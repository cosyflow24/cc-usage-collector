#!/usr/bin/env node
import { createRequire as __ccuCreateRequire } from 'module';
const require = __ccuCreateRequire(import.meta.url);
import {
  isWorkAccount
} from "./chunk-UC5VKDIV.js";
import "./chunk-HOACXCDS.js";

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
        authorization: `Bearer ${opts.token}`
      },
      body: JSON.stringify({
        user,
        sessions: payload.sessions.map(wireSession),
        daily: payload.daily.map(wireDaily),
        ...jiraAudit.length > 0 ? { jiraAudit } : {}
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        skippedUnauthorized++;
        process.stderr.write(
          `Skipped ${user}: token not authorized to upload as this account (${res.status}). Enroll this account or have the maintainer extend your token.
`
        );
        continue;
      }
      throw new Error(`ingest failed for ${user} (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    sessions += json.sessions ?? 0;
    daily += json.daily ?? 0;
  }
  if (skippedUnauthorized > 0) {
    process.stderr.write(
      `${skippedUnauthorized} account(s) skipped (token not authorized). Uploaded ${sessions} session(s) for the covered account(s).
`
    );
  }
  return { sessions, daily };
}
export {
  httpUpload
};
