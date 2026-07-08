import path from "node:path";
import type { CcusageSessionCost } from "./ccusage.ts";
import { type JiraConfig, defaultJiraConfig, resolveJiraKey } from "./jira.ts";
import { costForModelUsage } from "./pricing.ts";
import type { SessionAccount, SessionTask } from "./sidecar.ts";
import type {
  AnalysisResult,
  DailySummary,
  ModelUsage,
  SessionSummary,
  TokenTotals,
  UsageRecord,
} from "./types.ts";

export interface AnalyzeOptions {
  user: string;
  since: Date;
  until: Date;
  /** Gaps longer than this (ms) are treated as idle and trimmed from activeMs. */
  idleGapMs: number;
  /** Jira key resolution config. Defaults to branch+commit scan, no project map. */
  jira?: JiraConfig;
  /** If set, keep only records whose project (cwd basename) matches. */
  project?: string;
  /** sessionId → explicitly declared { jira, epic? } (from /task + hooks). Top priority. */
  sessionTasks?: Map<string, SessionTask>;
  /** sessionId → Claude account in use then (SessionStart hook). Per-session
   * attribution: overrides the global `user` so each session is credited to the
   * account actually signed in then, not whatever is active at collector time. */
  sessionAccounts?: Map<string, SessionAccount>;
  /** sessionId → authoritative ccusage cost. When present, overrides pricing.ts. */
  ccusageCost?: Map<string, CcusageSessionCost> | null;
  /**
   * Optional per-day active-hours transform, applied to each worked day's coarse
   * active hours before they are apportioned to that day's sessions. Used by the
   * LOCAL workday-floor (kept out of git). Identity when absent. Because the
   * transform feeds BOTH the daily rollup AND the per-session apportioning, the
   * two stay consistent (Σ sessions of a day == that day's daily active).
   */
  dayHoursTransform?: (day: string, hours: number) => number;
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function emptyModelUsage(model: string): ModelUsage {
  return { model, ...emptyTotals(), costUsd: 0 };
}

function addTokens(t: TokenTotals, r: UsageRecord): void {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheCreationTokens += r.cacheCreationTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
}

function mergeTotals(into: TokenTotals, from: TokenTotals): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheCreationTokens += from.cacheCreationTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.totalTokens += from.totalTokens;
}

function localDay(d: Date): string {
  // YYYY-MM-DD in local time (matches a developer's working day).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Active-time estimation (KI-759). FIXED thresholds, no calibration loop.
const T_THINK_MS = 5 * 60_000; // gap ≤ this counts fully as active (thinking/typing)
const T_SESSION_MS = 30 * 60_000; // gap > this = AFK/break, not counted
const HOUR_MS = 3_600_000;

/**
 * Coarse active time (ms) over a TIME-SORTED record list: each gap contributes
 * min(gap, T_THINK); gaps beyond T_SESSION are breaks and contribute nothing.
 * Correctness-over-precision — a planning signal, not minute-accurate tracking.
 */
function activeMs(sortedRecs: UsageRecord[]): number {
  let ms = 0;
  for (let i = 1; i < sortedRecs.length; i++) {
    const delta = sortedRecs[i]!.timestamp.getTime() - sortedRecs[i - 1]!.timestamp.getTime();
    if (delta <= 0 || delta > T_SESSION_MS) continue;
    ms += Math.min(delta, T_THINK_MS);
  }
  return ms;
}

/** Round to a coarse quarter-hour — deliberately NOT minute/second precision. */
function toActiveHours(ms: number): number {
  return roundQuarterHours(ms / HOUR_MS);
}

function roundQuarterHours(hours: number): number {
  return Math.round(hours / 0.25) * 0.25;
}

function buildSession(
  sessionId: string,
  recs: UsageRecord[],
  opts: AnalyzeOptions,
): SessionSummary {
  // Copy before sorting — never mutate the caller's array (analyze() also groups
  // these same records by day, so an in-place sort would be a hidden side effect).
  recs = [...recs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const start = recs[0]!.timestamp;
  // `end` is used ONLY for the in-window git-commit Jira scan below — never
  // uploaded. The exact span never leaves the machine.
  const end = recs[recs.length - 1]!.timestamp;

  // Latest non-null cwd/branch wins (a session can change branch mid-flight).
  const last = (pick: (r: UsageRecord) => string | null): string | null => {
    for (let i = recs.length - 1; i >= 0; i--) {
      const v = pick(recs[i]!);
      if (v) return v;
    }
    return null;
  };
  const cwd = last((r) => r.cwd);
  const branch = last((r) => r.gitBranch);
  const project = cwd ? path.basename(cwd) : null;

  // Explicit declaration (sidecar) wins over any heuristic.
  const declared = opts.sessionTasks?.get(sessionId);
  const jiraKey =
    declared?.jira ??
    resolveJiraKey({ branch, cwd, project }, start, end, opts.jira ?? defaultJiraConfig);
  // Epic only from explicit declaration here; epic-sync backfills the rest.
  const epicKey = declared?.epic ?? null;

  const perModel = new Map<string, ModelUsage>();
  const totals = emptyTotals();
  for (const r of recs) {
    addTokens(totals, r);
    if (!r.model) continue;
    let mu = perModel.get(r.model);
    if (!mu) {
      mu = emptyModelUsage(r.model);
      perModel.set(r.model, mu);
    }
    addTokens(mu, r);
  }

  // Numbers: prefer ccusage's authoritative (deduped) tokens + cost; our parser
  // only contributes attribution. Fall back to our own deduped counts +
  // pricing.ts only when ccusage has no row for this session.
  const cc = opts.ccusageCost?.get(sessionId);
  let modelUsage: ModelUsage[];
  let sessionTotals: TokenTotals;
  let notionalCostUsd: number;
  if (cc) {
    modelUsage = cc.models;
    sessionTotals = cc.totals;
    notionalCostUsd = cc.totalCostUsd;
  } else {
    modelUsage = [...perModel.values()];
    for (const mu of modelUsage) mu.costUsd = costForModelUsage(mu);
    sessionTotals = totals;
    notionalCostUsd = modelUsage.reduce((a, m) => a + m.costUsd, 0);
  }

  return {
    sessionId,
    // Per-session attribution: the account signed in DURING this session (from
    // the SessionStart hook), else the global user. Lets one machine's history
    // split across accounts (e.g. enterprise earlier, max later).
    user: opts.sessionAccounts?.get(sessionId)?.account ?? opts.user,
    project,
    gitBranch: branch,
    jiraKey,
    epicKey,
    epicSummary: null, // backfilled by epic-sync from jira_issue
    day: localDay(start),
    messageCount: recs.length,
    models: modelUsage.map((m) => m.model),
    modelUsage,
    totals: sessionTotals,
    notionalCostUsd,
    // Placeholder — analyze() overwrites this with the session's DAY-BOUNDED,
    // apportioned share (see apportionSessionActive). Summing whole-session
    // lifespans double-counts multi-day sessions vs the daily rollup.
    activeTimeHours: 0,
  };
}

/** Roll per-session model usage (incl cost) up into one list, sorted by tokens. */
function rollupModels(sessions: SessionSummary[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const s of sessions) {
    for (const mu of s.modelUsage) {
      let agg = map.get(mu.model);
      if (!agg) {
        agg = emptyModelUsage(mu.model);
        map.set(mu.model, agg);
      }
      mergeTotals(agg, mu);
      agg.costUsd += mu.costUsd;
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildDaily(
  sessions: SessionSummary[],
  user: string,
  // Precise per-day active hours (all of the user's events that day merged into
  // one timeline → no double-count). When absent, fall back to summing session
  // hours (an upper bound that can double-count concurrent sessions).
  dayActiveHours?: Map<string, number>,
): DailySummary[] {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    (map.get(s.day) ?? map.set(s.day, []).get(s.day)!).push(s);
  }
  return [...map.entries()]
    .map(([day, ses]) => {
      const totals = emptyTotals();
      let notionalCostUsd = 0;
      for (const s of ses) {
        mergeTotals(totals, s.totals);
        notionalCostUsd += s.notionalCostUsd;
      }
      return {
        day,
        // The day's account = that day's sessions' account. With a clean cutoff
        // (one account per day) this is exact. TODO(debt): if a single day ever
        // mixes accounts, daily rolls up under the first session's account only.
        user: ses[0]?.user ?? user,
        sessions: ses.length,
        modelUsage: rollupModels(ses),
        totals,
        notionalCostUsd,
        activeTimeHours:
          dayActiveHours?.get(day) ?? ses.reduce((a, s) => a + s.activeTimeHours, 0),
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

export function analyze(records: UsageRecord[], opts: AnalyzeOptions): AnalysisResult {
  const filtered = opts.project
    ? records.filter((r) => r.cwd && path.basename(r.cwd) === opts.project)
    : records;
  const bySession = new Map<string, UsageRecord[]>();
  for (const r of filtered) {
    (bySession.get(r.sessionId) ?? bySession.set(r.sessionId, []).get(r.sessionId)!).push(r);
  }
  const built = [...bySession.entries()].map(([id, recs]) => buildSession(id, recs, opts));

  // Active time (KI-759), derived so per-session and daily rollups AGREE.
  // Bucket every record by calendar DAY (and, within the day, by session):
  //   1. a day's coarse active hours = ALL that day's events merged into one
  //      timeline (concurrent sessions never double-count), then the optional
  //      workday transform;
  //   2. that day's hours are apportioned across the day's sessions by each
  //      session's share of raw same-day active. A multi-day session sums its
  //      per-day shares — so no single session can exceed a day, and
  //      Σ (sessions of a day) == that day's daily active == what epics sum.
  const recsByDay = new Map<string, UsageRecord[]>();
  const daySessions = new Map<string, Map<string, UsageRecord[]>>();
  for (const r of filtered) {
    const d = localDay(r.timestamp);
    (recsByDay.get(d) ?? recsByDay.set(d, []).get(d)!).push(r);
    const sm = daySessions.get(d) ?? daySessions.set(d, new Map()).get(d)!;
    (sm.get(r.sessionId) ?? sm.set(r.sessionId, []).get(r.sessionId)!).push(r);
  }
  const transform = opts.dayHoursTransform ?? ((_d, h) => h);
  const dayActiveHours = new Map<string, number>();
  const sessionActiveHours = new Map<string, number>();
  for (const [day, recs] of recsByDay) {
    recs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const dayHours = transform(day, toActiveHours(activeMs(recs)));
    dayActiveHours.set(day, dayHours);
    if (dayHours <= 0) continue;
    const rawBy = new Map<string, number>();
    let sumRaw = 0;
    for (const [sid, srecs] of daySessions.get(day)!) {
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

  // Store the PRECISE apportioned share (DB holds active_ms; the dashboard
  // rounds for display). Rounding each session to a quarter-hour here would make
  // Σ sessions drift a few % from the daily total. The day-level number stays
  // deliberately coarse (toActiveHours); the per-session split is an estimate of
  // it, so Σ sessions of a day == that day's daily active exactly.
  const sessions = built
    .map((s) => ({ ...s, activeTimeHours: sessionActiveHours.get(s.sessionId) ?? 0 }))
    .sort((a, b) => b.notionalCostUsd - a.notionalCostUsd);

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
    daily: buildDaily(sessions, opts.user, dayActiveHours),
    modelUsage: rollupModels(sessions),
    totals,
    notionalCostUsd,
  };
}
