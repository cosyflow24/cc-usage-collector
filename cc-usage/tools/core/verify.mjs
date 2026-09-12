// Side-effect-free live verification of the ingest token against the
// dashboard's read-only introspection endpoint (GET /api/ingest/whoami).
// Family-standard verdicts: 'ok' | 'rejected' | 'unreachable'. A network or
// 5xx failure is NOT a rejection — callers must never delete a token on
// 'unreachable'. Diagnostics never POST to /api/ingest (a write).

export function whoamiUrl(ingestUrl) {
  return `${String(ingestUrl).replace(/\/+$/, "")}/whoami`;
}

// `operator` is the employee the token uploads AS. null means the token names
// nobody, which is fine for a personal account and fatal for a shared one — the
// ingest route rejects a shared-account upload from an operator-less token.
// `sharedAccounts` says WHICH of enrolledEmails are shared, so a caller can tell
// those two cases apart instead of describing both and leaving the user to
// guess. Absent on an older dashboard → [] → "nothing known to be shared".
export async function verifyToken(ingestUrl, token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { verdict: "rejected", enrolledEmails: [], operator: null, sharedAccounts: [] };
  let res;
  try {
    res = await fetchImpl(whoamiUrl(ingestUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { verdict: "unreachable", enrolledEmails: [], operator: null, sharedAccounts: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { verdict: "rejected", enrolledEmails: [], operator: null, sharedAccounts: [] };
  }
  if (!res.ok) return { verdict: "unreachable", enrolledEmails: [], operator: null, sharedAccounts: [] };
  let body = {};
  try { body = await res.json(); } catch { /* tolerate non-JSON */ }
  const emails = Array.isArray(body.enrolledEmails) ? body.enrolledEmails.map(String) : [];
  // Older dashboards do not return `operator` at all; absent is treated the same
  // as null so an out-of-date deployment degrades to "unknown", never to a wrong
  // claim about who the uploads are attributed to.
  const operator = typeof body.operator === "string" && body.operator ? body.operator : null;
  // Which of those accounts are SHARED. An older dashboard omits the field, and
  // the empty list it degrades to is the honest answer there: "nothing is known
  // to be shared", which makes doctor fall back to describing both cases instead
  // of asserting the wrong one.
  const sharedAccounts = Array.isArray(body.sharedAccounts)
    ? body.sharedAccounts.map(String)
    : [];
  return { verdict: "ok", enrolledEmails: emails, operator, sharedAccounts };
}

/**
 * Decide what a live whoami result MEANS for the account the user is signed in
 * as right now. Pure, so the decision can be tested without a dashboard, a
 * keyring, or a filesystem — `doctor` only renders what this returns.
 *
 * It exists because the old doctor printed both halves of the answer ("fine for
 * a personal account; a SHARED account will reject uploads") and left the reader
 * to work out which one they were in. A new colleague signed into the shared
 * account with an operator-less token got "cc-usage doctor: healthy" and then
 * silent 403s on every upload.
 *
 * Returns { level, message }:
 *   "ok"   — uploads will be attributed, and to whom
 *   "note" — nothing is wrong; something is worth stating (a personal account,
 *            a non-work account that is deliberately never uploaded)
 *   "fail" — this setup cannot upload; message says what to run
 */
export function attributionVerdict({
  me = null,
  provider = "Claude",
  domain = "",
  operator = null,
  enrolledEmails = [],
  sharedAccounts = [],
} = {}) {
  const lower = (x) => String(x ?? "").toLowerCase();
  const shared = new Set(sharedAccounts.map(lower));
  const enrolled = new Set(enrolledEmails.map(lower));

  if (!me) {
    return { level: "note", message: `not signed in to a ${provider} account — nothing to attribute yet.` };
  }
  // Checked FIRST: a personal address is never uploaded at all, so no statement
  // about tokens or operators applies to it. Saying it plainly is the point —
  // otherwise the silence reads as a broken install.
  if (domain && !lower(me).endsWith(`@${lower(domain)}`)) {
    return {
      level: "note",
      message: `${provider}: ${me} is not a @${domain} address — kept local and never uploaded, by design.`,
    };
  }
  if (enrolled.size && !enrolled.has(lower(me))) {
    return {
      level: "fail",
      message: `${provider}: ${me} is not among this token's accounts (${enrolledEmails.join(", ")}) — its uploads are rejected. Enroll it at the dashboard's /enroll page, or ask the maintainer to extend your token.`,
    };
  }
  if (shared.has(lower(me))) {
    return operator
      ? { level: "ok", message: `${provider}: ${me} is shared; your usage is recorded under ${operator}.` }
      : {
          level: "fail",
          // The remediation has to name the field that actually carries the
          // operator. `cc-usage login` only asks for a TOKEN; the operator is
          // set on the dashboard's /enroll form, in the second field ("Your own
          // work email"). An earlier version of this message sent people back
          // to `login`, where they re-minted the same operator-less token and
          // stayed 403'd.
          message: `${provider}: ${me} is a SHARED account and this token names nobody — every upload is rejected (403). Fix: open the dashboard's /enroll page, enter ${me} as the account AND your own @${domain || "work"} address in the second field ("Your own work email"), then run  cc-usage login <new-token>.`,
        };
  }
  // Personal work account. The operator is irrelevant here: attribution resolves
  // through the account-to-employee mapping, so naming one changes nothing.
  return {
    level: "note",
    message: `${provider}: ${me} is a personal work account; usage is attributed through the account, not through the token.`,
  };
}
