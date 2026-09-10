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
export async function verifyToken(ingestUrl, token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { verdict: "rejected", enrolledEmails: [], operator: null };
  let res;
  try {
    res = await fetchImpl(whoamiUrl(ingestUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { verdict: "unreachable", enrolledEmails: [], operator: null };
  }
  if (res.status === 401 || res.status === 403) {
    return { verdict: "rejected", enrolledEmails: [], operator: null };
  }
  if (!res.ok) return { verdict: "unreachable", enrolledEmails: [], operator: null };
  let body = {};
  try { body = await res.json(); } catch { /* tolerate non-JSON */ }
  const emails = Array.isArray(body.enrolledEmails) ? body.enrolledEmails.map(String) : [];
  // Older dashboards do not return `operator` at all; absent is treated the same
  // as null so an out-of-date deployment degrades to "unknown", never to a wrong
  // claim about who the uploads are attributed to.
  const operator = typeof body.operator === "string" && body.operator ? body.operator : null;
  return { verdict: "ok", enrolledEmails: emails, operator };
}
