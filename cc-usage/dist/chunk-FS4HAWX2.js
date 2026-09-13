#!/usr/bin/env node
import { createRequire as __ccuCreateRequire } from 'module';
const require = __ccuCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/sidecar.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
function sidecarPath() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  return path.join(base, "cc-usage", "tasks.jsonl");
}
function sessionTaskKey(provider, sessionId) {
  return `${provider}:${sessionId}`;
}
function loadSessionTasks(file = sidecarPath()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return /* @__PURE__ */ new Map();
  }
  const latestTs = /* @__PURE__ */ new Map();
  const result = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sessionId !== "string" || typeof row.jira !== "string" || !row.jira) continue;
    const provider = row.provider === "codex" ? "codex" : "claude";
    const composite = sessionTaskKey(provider, row.sessionId);
    const ts = typeof row.ts === "string" ? row.ts : "";
    const prev = latestTs.get(composite);
    if (prev === void 0 || ts >= prev) {
      latestTs.set(composite, ts);
      const task = { jira: row.jira };
      if (typeof row.epic === "string" && row.epic) task.epic = row.epic;
      result.set(composite, task);
    }
  }
  return result;
}
function loadSessionAccounts(file = sidecarPath()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return /* @__PURE__ */ new Map();
  }
  const result = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sessionId !== "string" || typeof row.account !== "string" || !row.account) {
      continue;
    }
    const provider = row.provider === "codex" ? "codex" : "claude";
    const composite = sessionTaskKey(provider, row.sessionId);
    const ts = typeof row.ts === "string" ? row.ts : "";
    const acct = { account: row.account, ts };
    if (typeof row.plan === "string" && row.plan) acct.plan = row.plan;
    acct.providerVerified = provider === "claude" || row.identitySource === "codex-id-token";
    const list = result.get(composite);
    if (list) list.push(acct);
    else result.set(composite, [acct]);
  }
  for (const [key, list] of result) {
    list.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
    const collapsed = [];
    for (const a of list) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.account === a.account) {
        if (a.providerVerified) prev.providerVerified = true;
        if (a.plan) prev.plan = a.plan;
        continue;
      }
      collapsed.push({ ...a });
    }
    result.set(key, collapsed);
  }
  return result;
}
function accountAt(timeline, when) {
  if (!Array.isArray(timeline) || timeline.length === 0) return void 0;
  const iso = when.toISOString();
  let current = timeline[0];
  for (const entry of timeline) {
    if (!entry.ts || entry.ts <= iso) current = entry;
    else break;
  }
  return current;
}

// src/analyze.ts
import path2 from "path";

// src/jira.ts
import { execFileSync } from "child_process";
var JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
var ALLOWED_PROJECTS = (process.env.CC_USAGE_JIRA_PROJECTS ?? "KI,BI,ABT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
var defaultJiraConfig = { scanCommits: true };
var COMMIT_GRACE_AFTER_MS = 6 * 60 * 60 * 1e3;
var COMMIT_GRACE_BEFORE_MS = 30 * 60 * 1e3;
function extractKey(text) {
  if (!text) return null;
  const key = JIRA_KEY_RE.exec(text)?.[1] ?? null;
  if (!key) return null;
  if (ALLOWED_PROJECTS.length && !ALLOWED_PROJECTS.includes(key.split("-")[0])) {
    return null;
  }
  return key;
}
function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function keyFromCommits(cwd, since, until) {
  const from = new Date(since.getTime() - COMMIT_GRACE_BEFORE_MS);
  const to = new Date(until.getTime() + COMMIT_GRACE_AFTER_MS);
  const inWindow = git(cwd, [
    "log",
    `--since=${from.toISOString()}`,
    `--until=${to.toISOString()}`,
    "--format=%s%n%b"
  ]);
  return extractKey(inWindow);
}
function resolveJiraKey(p, since, until, cfg) {
  const fromBranch = extractKey(p.branch?.toUpperCase());
  if (fromBranch) return fromBranch;
  if (cfg.scanCommits && p.cwd) {
    const fromCommit = keyFromCommits(p.cwd, since, until);
    if (fromCommit) return fromCommit;
  }
  return null;
}

// src/pricing.ts
var CACHE_WRITE_MULTIPLIER = 1.25;
var CACHE_READ_MULTIPLIER = 0.1;
var PER_MILLION = 1e6;
var RATES = {
  // Opus 4.5+ family: $5/$25 (LiteLLM-verified 2026-06-26).
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  // Older Opus 4.0/4.1: $15/$75.
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-0": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 }
};
var FAMILY_FALLBACKS = [
  ["opus", RATES["claude-opus-4-8"]],
  ["sonnet", RATES["claude-sonnet-4-6"]],
  ["haiku", RATES["claude-haiku-4-5"]]
];
var DEFAULT_RATE = RATES["claude-sonnet-4-6"];
function rateFor(model) {
  const exact = RATES[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  for (const [family, rate] of FAMILY_FALLBACKS) {
    if (lower.includes(family)) return rate;
  }
  return DEFAULT_RATE;
}
function costForModelUsage(mu, provider = "claude") {
  if (provider === "codex") return 0;
  const r = rateFor(mu.model);
  const cost = (mu.inputTokens * r.input + mu.outputTokens * r.output + mu.cacheCreationTokens * r.input * CACHE_WRITE_MULTIPLIER + mu.cacheReadTokens * r.input * CACHE_READ_MULTIPLIER) / PER_MILLION;
  return Number.isFinite(cost) ? cost : 0;
}

// src/analyze.ts
function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  };
}
function emptyModelUsage(model, provider) {
  return {
    provider,
    model,
    ...emptyTotals(),
    costUsd: 0,
    costAvailable: provider === "claude"
  };
}
function addTokens(t, r) {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheCreationTokens += r.cacheCreationTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
}
function mergeTotals(into, from) {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheCreationTokens += from.cacheCreationTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.totalTokens += from.totalTokens;
}
function localDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
var T_THINK_MS = 5 * 6e4;
var T_SESSION_MS = 30 * 6e4;
var AGENT_RUN_MAX_MS = 45 * 6e4;
var HOUR_MS = 36e5;
function activeMs(sortedRecs) {
  let ms = 0;
  const open = /* @__PURE__ */ new Map();
  for (let i = 0; i < sortedRecs.length; i++) {
    const r = sortedRecs[i];
    const key = sessionTaskKey(r.provider, r.sessionId);
    if (r.kind === "tool_use") open.set(key, (open.get(key) ?? 0) + 1);
    else if (r.kind === "tool_result" && (open.get(key) ?? 0) > 0)
      open.set(key, (open.get(key) ?? 0) - 1);
    const next = sortedRecs[i + 1];
    if (!next) break;
    const delta = next.timestamp.getTime() - r.timestamp.getTime();
    if (delta <= 0) continue;
    if ((open.get(key) ?? 0) > 0) {
      ms += Math.min(delta, AGENT_RUN_MAX_MS);
    } else if (delta <= T_SESSION_MS) {
      ms += Math.min(delta, T_THINK_MS);
    }
  }
  return ms;
}
function toActiveHours(ms) {
  return roundQuarterHours(ms / HOUR_MS);
}
function roundQuarterHours(hours) {
  return Math.round(hours / 0.25) * 0.25;
}
function buildSession(sessionId, recs, opts, segmentAccount, ccShare) {
  recs = [...recs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const start = recs[0].timestamp;
  const provider = recs[0].provider;
  const composite = sessionTaskKey(provider, sessionId);
  const scopedAccount = segmentAccount ?? accountAt(opts.sessionAccounts?.get(composite), recs[0].timestamp);
  const trustedScopedAccount = provider === "codex" && scopedAccount?.providerVerified !== true ? void 0 : scopedAccount;
  const legacyClaudeAccount = provider === "claude" ? accountAt(opts.sessionAccounts?.get(sessionId), recs[0].timestamp) : void 0;
  const hasProviderIdentity = opts.providerUsers ? Object.prototype.hasOwnProperty.call(opts.providerUsers, provider) : false;
  const providerUser = hasProviderIdentity ? opts.providerUsers?.[provider] : opts.user;
  const end = recs[recs.length - 1].timestamp;
  const last = (pick) => {
    for (let i = recs.length - 1; i >= 0; i--) {
      const v = pick(recs[i]);
      if (v) return v;
    }
    return null;
  };
  const cwd = last((r) => r.cwd);
  const branch = last((r) => r.gitBranch);
  const project = cwd ? path2.basename(cwd) : null;
  const declared = opts.sessionTasks?.get(composite) ?? (provider === "claude" ? opts.sessionTasks?.get(sessionId) : void 0);
  const jiraKey = declared?.jira ?? resolveJiraKey({ branch, cwd, project }, start, end, opts.jira ?? defaultJiraConfig);
  const epicKey = declared?.epic ?? null;
  const perModel = /* @__PURE__ */ new Map();
  const totals = emptyTotals();
  for (const r of recs) {
    addTokens(totals, r);
    if (!r.model) continue;
    let mu = perModel.get(r.model);
    if (!mu) {
      mu = emptyModelUsage(r.model, provider);
      perModel.set(r.model, mu);
    }
    addTokens(mu, r);
  }
  const cc = provider === "claude" ? opts.ccusageCost?.get(sessionId) : void 0;
  let modelUsage;
  let sessionTotals;
  let notionalCostUsd;
  if (cc && ccShare) {
    modelUsage = cc.models.flatMap((m) => {
      const t = ccShare.get(m.model);
      if (!t) return [];
      const f = m.totalTokens > 0 ? t.totalTokens / m.totalTokens : 0;
      return [{ ...m, ...t, costUsd: m.costUsd * f }];
    });
    sessionTotals = emptyTotals();
    for (const m of modelUsage) {
      sessionTotals.inputTokens += m.inputTokens;
      sessionTotals.outputTokens += m.outputTokens;
      sessionTotals.cacheCreationTokens += m.cacheCreationTokens;
      sessionTotals.cacheReadTokens += m.cacheReadTokens;
      sessionTotals.totalTokens += m.totalTokens;
    }
    notionalCostUsd = modelUsage.reduce((a, m) => a + m.costUsd, 0);
  } else if (cc) {
    modelUsage = cc.models;
    sessionTotals = cc.totals;
    notionalCostUsd = cc.totalCostUsd;
  } else {
    modelUsage = [...perModel.values()];
    for (const mu of modelUsage) mu.costUsd = costForModelUsage(mu, provider);
    sessionTotals = totals;
    notionalCostUsd = modelUsage.reduce((a, m) => a + m.costUsd, 0);
  }
  return {
    provider,
    sessionId,
    parentSessionId: recs[0].parentSessionId,
    rootSessionId: recs[0].rootSessionId,
    agentRole: recs[0].agentRole,
    // Per-session attribution: the account signed in DURING this session (from
    // the SessionStart hook), else the global user. Lets one machine's history
    // split across accounts (e.g. enterprise earlier, max later).
    user: trustedScopedAccount?.account ?? legacyClaudeAccount?.account ?? providerUser ?? `unknown-${provider}-account`,
    project,
    gitBranch: branch,
    jiraKey,
    epicKey,
    epicSummary: null,
    // backfilled by epic-sync from jira_issue
    day: localDay(start),
    messageCount: recs.length,
    models: modelUsage.map((m) => m.model),
    modelUsage,
    totals: sessionTotals,
    notionalCostUsd,
    costAvailable: provider === "claude",
    // Placeholder — analyze() overwrites this with the session's DAY-BOUNDED,
    // apportioned share (see apportionSessionActive). Summing whole-session
    // lifespans double-counts multi-day sessions vs the daily rollup.
    activeTimeHours: 0
  };
}
function rollupModels(sessions) {
  const map = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    for (const mu of s.modelUsage) {
      const key = `${mu.provider}\0${mu.model}`;
      let agg = map.get(key);
      if (!agg) {
        agg = emptyModelUsage(mu.model, mu.provider);
        map.set(key, agg);
      }
      mergeTotals(agg, mu);
      agg.costUsd += mu.costUsd;
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
function buildDaily(sessions) {
  const map = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    const k = `${s.user}\0${s.day}`;
    (map.get(k) ?? map.set(k, []).get(k)).push(s);
  }
  return [...map.values()].map((ses) => {
    const totals = emptyTotals();
    let notionalCostUsd = 0;
    let activeTimeHours = 0;
    for (const s of ses) {
      mergeTotals(totals, s.totals);
      notionalCostUsd += s.notionalCostUsd;
      activeTimeHours += s.activeTimeHours;
    }
    return {
      day: ses[0].day,
      user: ses[0].user,
      sessions: ses.length,
      modelUsage: rollupModels(ses),
      totals,
      notionalCostUsd,
      hasUnpricedCodex: ses.some((session) => !session.costAvailable),
      activeTimeHours
    };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.user.localeCompare(b.user));
}
function mergeInto(target, extra) {
  for (const f of [
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "totalTokens"
  ]) {
    target.totals[f] += extra.totals[f];
  }
  target.messageCount += extra.messageCount;
  target.notionalCostUsd += extra.notionalCostUsd;
  if (extra.project) target.project = extra.project;
  if (extra.gitBranch) target.gitBranch = extra.gitBranch;
  if (extra.jiraKey) target.jiraKey = extra.jiraKey;
  if (extra.epicKey) target.epicKey = extra.epicKey;
  if (extra.epicSummary) target.epicSummary = extra.epicSummary;
  const byModel = new Map(target.modelUsage.map((m) => [m.model, m]));
  for (const m of extra.modelUsage) {
    const cur = byModel.get(m.model);
    if (!cur) {
      target.modelUsage.push(m);
      byModel.set(m.model, m);
      continue;
    }
    cur.inputTokens += m.inputTokens;
    cur.outputTokens += m.outputTokens;
    cur.cacheCreationTokens += m.cacheCreationTokens;
    cur.cacheReadTokens += m.cacheReadTokens;
    cur.totalTokens += m.totalTokens;
    cur.costUsd += m.costUsd;
  }
  target.models = target.modelUsage.map((m) => m.model);
}
function segmentKey(provider, sessionId, index) {
  return `${provider}:${sessionId}#${index}`;
}
function apportionModels(segments, models) {
  const components = [
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens"
  ];
  const out = segments.map(() => /* @__PURE__ */ new Map());
  const weights = segments.map((seg) => {
    const m = /* @__PURE__ */ new Map();
    for (const r of seg.recs) {
      if (!r.model) continue;
      const n = r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
      m.set(r.model, (m.get(r.model) ?? 0) + n);
    }
    return m;
  });
  for (const model of models) {
    const w = weights.map((m) => m.get(model.model) ?? 0);
    const wSum = w.reduce((a, b) => a + b, 0);
    const share = wSum > 0 ? w.map((x) => x / wSum) : w.map((_, i) => i === 0 ? 1 : 0);
    const totals = segments.map(() => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0
    }));
    for (const field of components) {
      const total = model[field];
      const exact = share.map((f) => total * f);
      const floors = exact.map((x) => Math.floor(x));
      let left = total - floors.reduce((a, b) => a + b, 0);
      const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
      const give = floors.slice();
      for (const { i } of order) {
        if (left <= 0) break;
        give[i] = give[i] + 1;
        left -= 1;
      }
      give.forEach((v, i) => {
        totals[i][field] = v;
      });
    }
    totals.forEach((t, i) => {
      t.totalTokens = t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
      if (t.totalTokens > 0) out[i].set(model.model, t);
    });
  }
  return out;
}
function splitByAccount(recs, timeline) {
  if (!timeline || timeline.length <= 1) {
    return [{ account: timeline?.[0], recs }];
  }
  const buckets = timeline.map((account) => ({ account, recs: [] }));
  const indexOf = new Map(timeline.map((entry, i) => [entry, i]));
  for (const r of recs) {
    const entry = accountAt(timeline, r.timestamp);
    const i = entry ? indexOf.get(entry) ?? 0 : 0;
    buckets[i].recs.push(r);
  }
  return buckets.filter((b) => b.recs.length > 0);
}
function analyze(records, opts) {
  const filtered = opts.project ? records.filter((r) => r.cwd && path2.basename(r.cwd) === opts.project) : records;
  const bySession = /* @__PURE__ */ new Map();
  for (const r of filtered) {
    const key = sessionTaskKey(r.provider, r.sessionId);
    (bySession.get(key) ?? bySession.set(key, []).get(key)).push(r);
  }
  const built = [];
  const segRecords = /* @__PURE__ */ new Map();
  const builtKeys = /* @__PURE__ */ new Map();
  for (const recs of bySession.values()) {
    const sessionId = recs[0].sessionId;
    const provider = recs[0].provider;
    const timeline = opts.sessionAccounts?.get(sessionTaskKey(provider, sessionId));
    const segments = splitByAccount(recs, timeline);
    const cost = provider === "claude" ? opts.ccusageCost?.get(sessionId) : void 0;
    const shares = segments.length > 1 && cost ? apportionModels(segments, cost.models) : void 0;
    const byUser = /* @__PURE__ */ new Map();
    segments.forEach((seg, i) => {
      const summary = buildSession(sessionId, seg.recs, opts, seg.account, shares?.[i]);
      const prev = byUser.get(summary.user);
      if (prev) {
        mergeInto(prev.summary, summary);
        prev.recs.push(...seg.recs);
      } else {
        byUser.set(summary.user, { summary, recs: [...seg.recs] });
      }
    });
    let ordinal = 0;
    for (const { summary, recs: segRecs } of byUser.values()) {
      const key = segmentKey(provider, sessionId, ordinal);
      ordinal += 1;
      built.push(summary);
      builtKeys.set(summary, key);
      segRecords.set(key, segRecs);
    }
  }
  const recordSegment = /* @__PURE__ */ new Map();
  for (const [key, recs] of segRecords) for (const r of recs) recordSegment.set(r, key);
  const recsByDay = /* @__PURE__ */ new Map();
  const daySessions = /* @__PURE__ */ new Map();
  for (const r of filtered) {
    const d = localDay(r.timestamp);
    (recsByDay.get(d) ?? recsByDay.set(d, []).get(d)).push(r);
    const sm = daySessions.get(d) ?? daySessions.set(d, /* @__PURE__ */ new Map()).get(d);
    const key = recordSegment.get(r) ?? sessionTaskKey(r.provider, r.sessionId);
    (sm.get(key) ?? sm.set(key, []).get(key)).push(r);
  }
  const sessionActiveHours = /* @__PURE__ */ new Map();
  for (const [day, recs] of recsByDay) {
    recs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const dayHours = toActiveHours(activeMs(recs));
    if (dayHours <= 0) continue;
    const rawBy = /* @__PURE__ */ new Map();
    let sumRaw = 0;
    for (const [sid, srecs] of daySessions.get(day)) {
      srecs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const ms = activeMs(srecs);
      rawBy.set(sid, ms);
      sumRaw += ms;
    }
    for (const [sid, raw] of rawBy) {
      const share = sumRaw > 0 ? dayHours * (raw / sumRaw) : dayHours / rawBy.size;
      sessionActiveHours.set(sid, (sessionActiveHours.get(sid) ?? 0) + share);
    }
  }
  const sessions = built.map((s) => ({
    ...s,
    activeTimeHours: sessionActiveHours.get(builtKeys.get(s) ?? "") ?? 0
  })).sort((a, b) => b.notionalCostUsd - a.notionalCostUsd);
  const totals = emptyTotals();
  let notionalCostUsd = 0;
  for (const s of sessions) {
    mergeTotals(totals, s.totals);
    notionalCostUsd += s.notionalCostUsd;
  }
  return {
    user: opts.user,
    range: { since: opts.since.toISOString(), until: opts.until.toISOString() },
    sessions,
    daily: buildDaily(sessions),
    modelUsage: rollupModels(sessions),
    totals,
    notionalCostUsd,
    hasUnpricedCodex: sessions.some((session) => !session.costAvailable)
  };
}

// src/config.ts
import { execFileSync as execFileSync2 } from "child_process";
import { readFileSync as readFileSync2 } from "fs";
import { hostname, homedir as homedir2 } from "os";
import path3 from "path";
var DEFAULT_WORK_DOMAIN = "nnb24.de";
function resolveAccountEmail() {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR ? path3.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : null,
    path3.join(homedir2(), ".claude.json")
  ].filter((p) => p !== null);
  for (const file of candidates) {
    try {
      const j = JSON.parse(readFileSync2(file, "utf8"));
      const email = j.oauthAccount?.emailAddress;
      if (typeof email === "string" && email.includes("@")) return email.toLowerCase();
    } catch {
    }
  }
  return null;
}
function resolveCodexAccountEmail() {
  const file = path3.join(process.env.CODEX_HOME ?? path3.join(homedir2(), ".codex"), "auth.json");
  try {
    const auth = JSON.parse(readFileSync2(file, "utf8"));
    const token = auth.tokens?.id_token;
    if (typeof token !== "string") return null;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")
    );
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return email.includes("@") ? email : null;
  } catch {
    return null;
  }
}
function isWorkAccount(email, domain = process.env.CC_USAGE_WORK_DOMAIN ?? DEFAULT_WORK_DOMAIN) {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}
function loadJiraConfig() {
  return { ...defaultJiraConfig };
}
function resolveUser() {
  if (process.env.CC_USAGE_USER) return process.env.CC_USAGE_USER.trim();
  const account = resolveAccountEmail();
  if (account) return account;
  try {
    const email = execFileSync2("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (email) return email;
  } catch {
  }
  return hostname();
}
function dayStart(offset = 0) {
  const d = /* @__PURE__ */ new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}
function resolveRange(opts) {
  const until = opts.until ? new Date(opts.until) : /* @__PURE__ */ new Date();
  let since;
  if (opts.since) {
    since = new Date(opts.since);
  } else if (opts.days) {
    const n = Number.parseInt(opts.days, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --days: ${opts.days}`);
    since = dayStart(-n);
  } else {
    since = dayStart(-1);
  }
  if (Number.isNaN(since.getTime())) throw new Error(`invalid --since: ${opts.since}`);
  if (Number.isNaN(until.getTime())) throw new Error(`invalid --until: ${opts.until}`);
  if (since > until) throw new Error("since is after until");
  return { since, until };
}

export {
  __require,
  __commonJS,
  __toESM,
  loadSessionTasks,
  loadSessionAccounts,
  emptyTotals,
  mergeTotals,
  rollupModels,
  analyze,
  resolveAccountEmail,
  resolveCodexAccountEmail,
  isWorkAccount,
  loadJiraConfig,
  resolveUser,
  resolveRange
};
