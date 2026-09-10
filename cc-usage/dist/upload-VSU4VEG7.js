#!/usr/bin/env node
import { createRequire as __ccuCreateRequire } from 'module';
const require = __ccuCreateRequire(import.meta.url);
import {
  isWorkAccount
} from "./chunk-NEB74BZI.js";

// src/upload.ts
function wireTotals(t) {
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    cacheReadTokens: t.cacheReadTokens,
    totalTokens: t.totalTokens
  };
}
function wireModelUsage(m) {
  return { model: m.model, ...wireTotals(m), costUsd: m.costUsd };
}
function wireSession(s) {
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
    activeTimeHours: s.activeTimeHours
  };
}
function wireDaily(d) {
  return {
    day: d.day,
    user: d.user,
    sessions: d.sessions,
    modelUsage: d.modelUsage.map(wireModelUsage),
    totals: wireTotals(d.totals),
    notionalCostUsd: d.notionalCostUsd,
    activeTimeHours: d.activeTimeHours
  };
}
async function httpUpload(result, opts) {
  const byUser = /* @__PURE__ */ new Map();
  const bucket = (u) => {
    let b = byUser.get(u);
    if (!b) {
      b = { sessions: [], daily: [] };
      byUser.set(u, b);
    }
    return b;
  };
  let skippedPersonal = 0;
  for (const s of result.sessions) {
    if (!isWorkAccount(s.user)) {
      skippedPersonal++;
      continue;
    }
    bucket(s.user).sessions.push(s);
  }
  for (const d of result.daily) {
    if (!isWorkAccount(d.user)) continue;
    bucket(d.user).daily.push(d);
  }
  if (skippedPersonal > 0) {
    process.stderr.write(`${skippedPersonal} session(s) on non-work accounts kept local (never uploaded).
`);
  }
  let sessions = 0;
  let daily = 0;
  let skippedUnauthorized = 0;
  let skippedRows = 0;
  const failures = [];
  for (const [user, payload] of byUser) {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`
      },
      body: JSON.stringify({
        user,
        sessions: payload.sessions.map(wireSession),
        daily: payload.daily.map(wireDaily)
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        skippedUnauthorized++;
        let reason = "";
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.error === "string" && parsed.error) reason = parsed.error;
        } catch {
        }
        process.stderr.write(
          reason ? `Skipped ${user} (${res.status}): ${reason}
` : `Skipped ${user}: token not authorized to upload as this account (${res.status}). Enroll this account or have the maintainer extend your token.
`
        );
        continue;
      }
      failures.push(`${user} (${res.status}): ${text.slice(0, 200)}`);
      process.stderr.write(`Failed ${user} (${res.status}) \u2014 continuing with the other accounts.
`);
      continue;
    }
    const json = await res.json();
    sessions += json.sessions ?? 0;
    daily += json.daily ?? 0;
    skippedRows += json.skipped ?? 0;
  }
  if (skippedRows > 0) {
    process.stderr.write(
      `${skippedRows} session row(s) rejected by the server: they already belong to another person on a shared account. If that is wrong, the session was uploaded under the wrong operator \u2014 check \`cc-usage doctor\`.
`
    );
  }
  if (skippedUnauthorized > 0) {
    process.stderr.write(
      `${skippedUnauthorized} account(s) skipped (token not authorized). Uploaded ${sessions} session(s) for the covered account(s).
`
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `ingest failed for ${failures.length} account(s), the rest were uploaded:
  ${failures.join("\n  ")}`
    );
  }
  return { sessions, daily };
}
export {
  httpUpload
};
