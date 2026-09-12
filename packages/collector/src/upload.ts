import { isWorkAccount } from "./config.ts";
import type {
  AnalysisResult,
  DailySummary,
  ModelUsage,
  SessionSummary,
  TokenTotals,
} from "./types.ts";

/**
 * Upload analysis to the Railway ingest API. Local machines hold only a scoped
 * ingest token — never the Supabase service key (which lives on Railway).
 *
 * Per-session attribution means one run can span multiple accounts (e.g. an
 * enterprise account earlier, max later). The ingest endpoint requires every
 * row in a payload to match payload.user (so a leaked token can't impersonate
 * others), so we split by user and POST one payload per account.
 */
// The wire payload is built by EXPLICIT field projection — never by serializing
// the in-memory objects. Metadata-only by construction: any field a future
// refactor attaches to a session/day (worst case: prompt content) does NOT ship
// unless it is deliberately added here AND accepted by the ingest route. The
// field sets mirror the route's isSessionRow / isDailyRow validators.
function wireTotals(t: TokenTotals): TokenTotals {
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    cacheReadTokens: t.cacheReadTokens,
    totalTokens: t.totalTokens,
  };
}

function wireModelUsage(m: ModelUsage) {
  return { model: m.model, ...wireTotals(m), costUsd: m.costUsd };
}

function wireSession(s: SessionSummary) {
  return {
    provider: s.provider,
    sessionId: s.sessionId,
    parentSessionId: s.parentSessionId,
    rootSessionId: s.rootSessionId,
    agentRole: s.agentRole,
    user: s.user,
    project: s.project,
    gitBranch: s.gitBranch,
    jiraKey: s.jiraKey,
    epicKey: s.epicKey,
    epicSummary: s.epicSummary,
    day: s.day,
    messageCount: s.messageCount,
    models: [...s.models],
    modelUsage: s.modelUsage.map(wireModelUsage),
    totals: wireTotals(s.totals),
    notionalCostUsd: s.notionalCostUsd,
    activeTimeHours: s.activeTimeHours,
  };
}

function wireDaily(d: DailySummary) {
  return {
    day: d.day,
    user: d.user,
    sessions: d.sessions,
    modelUsage: d.modelUsage.map(wireModelUsage),
    totals: wireTotals(d.totals),
    notionalCostUsd: d.notionalCostUsd,
    activeTimeHours: d.activeTimeHours,
  };
}

export async function httpUpload(
  result: AnalysisResult,
  opts: { url: string; token: string },
): Promise<{ sessions: number; daily: number }> {
  const byUser = new Map<string, { sessions: SessionSummary[]; daily: DailySummary[] }>();
  const bucket = (u: string) => {
    let b = byUser.get(u);
    if (!b) {
      b = { sessions: [], daily: [] };
      byUser.set(u, b);
    }
    return b;
  };
  // POLICY, enforced at the wire (not only at the run gate): sessions attributed
  // to a NON-work account never leave the machine. The cli gate checks the
  // CURRENTLY signed-in account, but a multi-account history buckets per-session
  // users — a personal bucket must be dropped here, not POSTed and 403'd (its
  // metadata would already have crossed the wire, and the throw aborts the run).
  // TWO counters, because they are two different events and one of them used to
  // be reported as the other. `unknown-<provider>-account` is what a session
  // gets when its account could NOT BE READ; it fails isWorkAccount() like a
  // private address does, so it was counted into skippedPersonal and reported
  // as "non-work accounts kept local" — a reassurance that was false. Those are
  // WORK sessions being lost, and the only user-visible trace said the opposite
  // of what happened.
  let skippedPersonal = 0;
  let skippedUnknown = 0;
  const unknownUser = (u: string): boolean => /^unknown-[a-z]+-account$/.test(u);
  for (const s of result.sessions) {
    if (unknownUser(s.user)) { skippedUnknown++; continue; }
    if (!isWorkAccount(s.user)) { skippedPersonal++; continue; }
    bucket(s.user).sessions.push(s);
  }
  for (const d of result.daily) {
    if (unknownUser(d.user) || !isWorkAccount(d.user)) continue;
    bucket(d.user).daily.push(d);
  }
  if (skippedPersonal > 0) {
    process.stderr.write(`${skippedPersonal} session(s) on non-work accounts kept local (never uploaded).\n`);
  }
  if (skippedUnknown > 0) {
    process.stderr.write(
      `${skippedUnknown} session(s) had NO readable account and were NOT uploaded. `
      + "This is not a privacy skip — the account could not be determined, so it could not be "
      + "checked against the work domain. Run  cc-usage doctor  to see which host is affected.\n",
    );
  }

  let sessions = 0;
  let daily = 0;
  let skippedUnauthorized = 0;
  let skippedRows = 0;
  const failures: string[] = [];
  for (const [user, payload] of byUser) {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({
        user,
        sessions: payload.sessions.map(wireSession),
        daily: payload.daily.map(wireDaily),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 401/403 = this token is not allowed to upload as THIS account. Common for
      // a two-account person (e.g. a Max + an Enterprise login) whose token only
      // covers one email: skip that account's bucket and keep uploading the ones
      // it DOES cover — do not abort the whole run (which would also lose the
      // covered account). Other errors (400 bad payload, 5xx) are real and rethrow.
      if (res.status === 401 || res.status === 403) {
        skippedUnauthorized++;
        // Prefer the server's own reason. A shared account rejects a token that
        // does not name its operator, and the generic "enroll this account"
        // advice would send the user down the wrong path — re-enrolling without
        // an operator mints another token that is rejected exactly the same way.
        let reason = "";
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error) reason = parsed.error;
        } catch { /* not JSON → fall back to the generic hint */ }
        process.stderr.write(
          reason
            ? `Skipped ${user} (${res.status}): ${reason}\n`
            : `Skipped ${user}: token not authorized to upload as this account ` +
              `(${res.status}). Enroll this account or have the maintainer extend your token.\n`,
        );
        continue;
      }
      // A server-side failure for ONE account must not cost the others their
      // upload. Throwing here aborted the whole run at the first bad bucket, so
      // every account after it in the payload went unsent — and there is no
      // retry queue, so anything outside the next run's --days window needed a
      // manual re-upload. Record it, keep going, and fail the RUN at the end so
      // it is never mistaken for success.
      failures.push(`${user} (${res.status}): ${text.slice(0, 200)}`);
      process.stderr.write(`Failed ${user} (${res.status}) — continuing with the other accounts.\n`);
      continue;
    }
    const json = (await res.json()) as { sessions?: number; daily?: number; skipped?: number };
    sessions += json.sessions ?? 0;
    daily += json.daily ?? 0;
    // The server refuses a session row that belongs to a DIFFERENT operator on a
    // shared account. Dropping that count would report a clean upload for work
    // that was not recorded.
    skippedRows += json.skipped ?? 0;
  }
  if (skippedRows > 0) {
    process.stderr.write(
      `${skippedRows} session row(s) rejected by the server: they already belong to ` +
        "another person on a shared account. If that is wrong, the session was " +
        "uploaded under the wrong operator — check `cc-usage doctor`.\n",
    );
  }
  if (skippedUnauthorized > 0) {
    process.stderr.write(
      `${skippedUnauthorized} account(s) skipped (token not authorized). ` +
        `Uploaded ${sessions} session(s) for the covered account(s).\n`,
    );
  }
  if (failures.length > 0) {
    // Non-zero exit, after everything that COULD be uploaded was.
    throw new Error(
      `ingest failed for ${failures.length} account(s), the rest were uploaded:\n  ${failures.join("\n  ")}`,
    );
  }
  return { sessions, daily };
}
