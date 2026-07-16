import type { AuditRow } from "./audit.ts";
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
 *
 * Phase 3: the automated-Jira-action audit trail (jiraAudit) rides along on the
 * resolved work account's payload. The audit file has no user, so all its rows
 * belong to `auditUser` (the currently signed-in work account); the route stamps
 * user_id = body.user, reusing the anti-impersonation invariant. If that account
 * has no sessions this run, we still POST a standalone {sessions:[],daily:[],
 * jiraAudit:[...]} — the route accepts empty arrays.
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

function wireModelUsage(m: ModelUsage): ModelUsage {
  return { model: m.model, ...wireTotals(m), costUsd: m.costUsd };
}

function wireSession(s: SessionSummary): SessionSummary {
  return {
    sessionId: s.sessionId,
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

function wireDaily(d: DailySummary): DailySummary {
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
  opts: { url: string; token: string; jiraAudit?: AuditRow[]; auditUser?: string },
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
  let skippedPersonal = 0;
  for (const s of result.sessions) {
    if (!isWorkAccount(s.user)) { skippedPersonal++; continue; }
    bucket(s.user).sessions.push(s);
  }
  for (const d of result.daily) {
    if (!isWorkAccount(d.user)) continue;
    bucket(d.user).daily.push(d);
  }
  if (skippedPersonal > 0) {
    process.stderr.write(`${skippedPersonal} session(s) on non-work accounts kept local (never uploaded).\n`);
  }

  // Ensure the work account has a bucket so its audit rows have somewhere to ride,
  // even when it produced no sessions today.
  const audit = opts.jiraAudit ?? [];
  if (audit.length > 0 && opts.auditUser) bucket(opts.auditUser);

  let sessions = 0;
  let daily = 0;
  let skippedUnauthorized = 0;
  for (const [user, payload] of byUser) {
    const jiraAudit = user === opts.auditUser ? audit : [];
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
        ...(jiraAudit.length > 0 ? { jiraAudit } : {}),
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
        process.stderr.write(
          `Skipped ${user}: token not authorized to upload as this account ` +
            `(${res.status}). Enroll this account or have the maintainer extend your token.\n`,
        );
        continue;
      }
      throw new Error(`ingest failed for ${user} (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { sessions?: number; daily?: number };
    sessions += json.sessions ?? 0;
    daily += json.daily ?? 0;
  }
  if (skippedUnauthorized > 0) {
    process.stderr.write(
      `${skippedUnauthorized} account(s) skipped (token not authorized). ` +
        `Uploaded ${sessions} session(s) for the covered account(s).\n`,
    );
  }
  return { sessions, daily };
}
