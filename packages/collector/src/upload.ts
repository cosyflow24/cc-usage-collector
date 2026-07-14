import type { AuditRow } from "./audit.ts";
import type { AnalysisResult, DailySummary, SessionSummary } from "./types.ts";

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
  for (const s of result.sessions) bucket(s.user).sessions.push(s);
  for (const d of result.daily) bucket(d.user).daily.push(d);

  // Ensure the work account has a bucket so its audit rows have somewhere to ride,
  // even when it produced no sessions today.
  const audit = opts.jiraAudit ?? [];
  if (audit.length > 0 && opts.auditUser) bucket(opts.auditUser);

  let sessions = 0;
  let daily = 0;
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
        sessions: payload.sessions,
        daily: payload.daily,
        ...(jiraAudit.length > 0 ? { jiraAudit } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ingest failed for ${user} (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { sessions?: number; daily?: number };
    sessions += json.sessions ?? 0;
    daily += json.daily ?? 0;
  }
  return { sessions, daily };
}
