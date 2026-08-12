// Side-effect-free live verification of the ingest token against the
// dashboard's read-only introspection endpoint (GET /api/ingest/whoami).
// Family-standard verdicts: 'ok' | 'rejected' | 'unreachable'. A network or
// 5xx failure is NOT a rejection — callers must never delete a token on
// 'unreachable'. Diagnostics never POST to /api/ingest (a write).

export function whoamiUrl(ingestUrl) {
  return `${String(ingestUrl).replace(/\/+$/, "")}/whoami`;
}

export async function verifyToken(ingestUrl, token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { verdict: "rejected", enrolledEmails: [] };
  let res;
  try {
    res = await fetchImpl(whoamiUrl(ingestUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { verdict: "unreachable", enrolledEmails: [] };
  }
  if (res.status === 401 || res.status === 403) return { verdict: "rejected", enrolledEmails: [] };
  if (!res.ok) return { verdict: "unreachable", enrolledEmails: [] };
  let body = {};
  try { body = await res.json(); } catch { /* tolerate non-JSON */ }
  const emails = Array.isArray(body.enrolledEmails) ? body.enrolledEmails.map(String) : [];
  return { verdict: "ok", enrolledEmails: emails };
}
