import path from "node:path";
import type { CcusageSessionCost } from "./ccusage.ts";
import { type JiraConfig, defaultJiraConfig, resolveJiraKey } from "./jira.ts";
import { costForModelUsage } from "./pricing.ts";
import { accountAt, sessionTaskKey, type SessionAccount, type SessionTask } from "./sidecar.ts";
import type {
  AnalysisResult,
  DailySummary,
  ModelUsage,
  SessionSummary,
  TokenTotals,
  UsageProvider,
  UsageRecord,
} from "./types.ts";

export interface AnalyzeOptions {
  user: string;
  /** Provider-specific authenticated identities; prevents cross-provider attribution. */
  providerUsers?: Partial<Record<"claude" | "codex", string | null>>;
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
  sessionAccounts?: Map<string, SessionAccount[]>;
  /** sessionId → authoritative ccusage cost. When present, overrides pricing.ts. */
  ccusageCost?: Map<string, CcusageSessionCost> | null;
}

export function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function emptyModelUsage(model: string, provider: "claude" | "codex"): ModelUsage {
  return {
    provider,
    model,
    ...emptyTotals(),
    costUsd: 0,
    costAvailable: provider === "claude",
  };
}

function addTokens(t: TokenTotals, r: UsageRecord): void {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheCreationTokens += r.cacheCreationTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
}

export function mergeTotals(into: TokenTotals, from: TokenTotals): void {
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
const T_THINK_MS = 5 * 60_000; // non-run gap ≤ this counts fully (thinking/typing)
const T_SESSION_MS = 30 * 60_000; // non-run gap > this = AFK/break, not counted
const AGENT_RUN_MAX_MS = 45 * 60_000; // sanity cap on a single agent run (resume artifacts)
const HOUR_MS = 3_600_000;

/**
 * Coarse active time (ms) over a TIME-SORTED record list (KI-759, per Daniel's
 * decision 2026-07-05):
 *  - An AGENT RUN — a gap where a tool was dispatched and we're waiting for its
 *    result (`tool_use` → `tool_result`) — counts FULLY: the tool was genuinely
 *    running, so it is not capped at T_think nor dropped as AFK (capped only by a
 *    45-min sanity bound against session-resume artifacts).
 *  - Any other gap (prompt-prep / thinking) contributes min(gap, T_think); gaps
 *    beyond T_session are breaks and contribute nothing.
 * Correctness-over-precision — a planning signal, not minute-accurate tracking.
 *
 * TODO(debt): now = agent runs count fully up to a fixed 45-min cap; full =
 * Daniel's rule (cap a ≥5-min run at the moment a prompt lands on ANOTHER task —
 * needs the cross-task merged timeline) + complexity-estimated prep time (§5,
 * awaiting calibration data).
 */
function activeMs(sortedRecs: UsageRecord[]): number {
  let ms = 0;
  // Open (dispatched, not-yet-returned) tool count PER SESSION — so intervening
  // noise events (attachments, mode, system) don't break a run, and a run in one
  // session isn't confused with another session's events in the merged timeline.
  const open = new Map<string, number>();
  for (let i = 0; i < sortedRecs.length; i++) {
    const r = sortedRecs[i]!;
    const key = sessionTaskKey(r.provider, r.sessionId);
    if (r.kind === "tool_use") open.set(key, (open.get(key) ?? 0) + 1);
    else if (r.kind === "tool_result" && (open.get(key) ?? 0) > 0)
      open.set(key, (open.get(key) ?? 0) - 1);

    const next = sortedRecs[i + 1];
    if (!next) break;
    const delta = next.timestamp.getTime() - r.timestamp.getTime();
    if (delta <= 0) continue;
    if ((open.get(key) ?? 0) > 0) {
      ms += Math.min(delta, AGENT_RUN_MAX_MS); // a tool is running → count the wait fully
    } else if (delta <= T_SESSION_MS) {
      ms += Math.min(delta, T_THINK_MS); // prompt-prep proxy (interim, until §5 calib)
    }
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
  segmentAccount?: SessionAccount,
  /**
   * This segment's whole-number share of the session's authoritative per-model
   * counts. Absent for an unsplit session. Already conserves across segments.
   */
  ccShare?: Map<string, TokenTotals>,
): SessionSummary {
  // Copy before sorting — never mutate the caller's array (analyze() also groups
  // these same records by day, so an in-place sort would be a hidden side effect).
  recs = [...recs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const start = recs[0]!.timestamp;
  const provider = recs[0]!.provider;
  const composite = sessionTaskKey(provider, sessionId);
  // The account for THIS segment, chosen by the caller from the session's
  // account timeline (see splitByAccount). Falls back to the timeline's own
  // resolution when a caller passes records without a segment account.
  const scopedAccount = segmentAccount
    ?? accountAt(opts.sessionAccounts?.get(composite), recs[0]!.timestamp);
  const trustedScopedAccount = provider === "codex" && scopedAccount?.providerVerified !== true
    ? undefined
    : scopedAccount;
  // Pre-provider sidecars contain bare ids and were written by Claude hooks.
  // Never let one of those entries attribute a Codex rollout to a Claude user.
  const legacyClaudeAccount = provider === "claude"
    ? accountAt(opts.sessionAccounts?.get(sessionId), recs[0]!.timestamp)
    : undefined;
  const hasProviderIdentity = opts.providerUsers
    ? Object.prototype.hasOwnProperty.call(opts.providerUsers, provider)
    : false;
  const providerUser = hasProviderIdentity
    ? opts.providerUsers?.[provider]
    : opts.user;
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
  const declared = opts.sessionTasks?.get(composite)
    ?? (provider === "claude" ? opts.sessionTasks?.get(sessionId) : undefined);
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
      mu = emptyModelUsage(r.model, provider);
      perModel.set(r.model, mu);
    }
    addTokens(mu, r);
  }

  // Numbers: prefer ccusage's authoritative (deduped) tokens + cost; our parser
  // only contributes attribution. Fall back to our own deduped counts +
  // pricing.ts only when ccusage has no row for this session.
  // ccusage reports one total per SESSION. A split session cannot use it whole,
  // but it must not fall back to pricing.ts either: that table resolves some
  // dated model ids (claude-opus-4-1-20250805) to a cheaper generation and would
  // report a third of the real cost. Instead the authoritative per-model numbers
  // are apportioned by this segment's share of that model's tokens — an
  // approximation of the SPLIT, not of the price.
  const cc = provider === "claude" ? opts.ccusageCost?.get(sessionId) : undefined;
  let modelUsage: ModelUsage[];
  let sessionTotals: TokenTotals;
  let notionalCostUsd: number;
  if (cc && ccShare) {
    // Whole numbers straight from apportionModels; cost follows the token share
    // of that model so it cannot drift from the authoritative per-model price.
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
    parentSessionId: recs[0]!.parentSessionId,
    rootSessionId: recs[0]!.rootSessionId,
    agentRole: recs[0]!.agentRole,
    // Per-session attribution: the account signed in DURING this session (from
    // the SessionStart hook), else the global user. Lets one machine's history
    // split across accounts (e.g. enterprise earlier, max later).
    user: trustedScopedAccount?.account
      ?? legacyClaudeAccount?.account
      ?? providerUser
      ?? `unknown-${provider}-account`,
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
    costAvailable: provider === "claude",
    // Placeholder — analyze() overwrites this with the session's DAY-BOUNDED,
    // apportioned share (see apportionSessionActive). Summing whole-session
    // lifespans double-counts multi-day sessions vs the daily rollup.
    activeTimeHours: 0,
  };
}

/** Roll per-session model usage (incl cost) up into one list, sorted by tokens. */
export function rollupModels(sessions: SessionSummary[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const s of sessions) {
    for (const mu of s.modelUsage) {
      const key = `${mu.provider}\u0000${mu.model}`;
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

function buildDaily(sessions: SessionSummary[]): DailySummary[] {
  // Roll up per (user, day) — NEVER per day alone: a day mixing work + personal
  // sessions must produce one row per account, not attribute everything to the
  // first session's account. ACTIVE-TIME SEMANTICS: the day-timeline merge in
  // analyze() stays per-day-all-accounts (one human, one machine — concurrent
  // sessions never double-count) and apportions the day's hours to sessions;
  // daily is then Σ of the user's session shares, so
  // Σ(a user's session hours of a day) == that user's daily hours by
  // construction.
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const k = `${s.user}\u0000${s.day}`;
    (map.get(k) ?? map.set(k, []).get(k)!).push(s);
  }
  return [...map.values()]
    .map((ses) => {
      const totals = emptyTotals();
      let notionalCostUsd = 0;
      let activeTimeHours = 0;
      for (const s of ses) {
        mergeTotals(totals, s.totals);
        notionalCostUsd += s.notionalCostUsd;
        activeTimeHours += s.activeTimeHours;
      }
      return {
        day: ses[0]!.day,
        user: ses[0]!.user,
        sessions: ses.length,
        modelUsage: rollupModels(ses),
        totals,
        notionalCostUsd,
        hasUnpricedCodex: ses.some((session) => !session.costAvailable),
        activeTimeHours,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || a.user.localeCompare(b.user));
}

/**
 * Identity of one account-segment of a session, for per-segment bookkeeping.
 *
 * Keyed by the segment's ORDINAL, not by the resolved user: two segments can
 * resolve to the same identity — both to `unknown-codex-account`, or both to the
 * same fallback work email — and a user-keyed map then silently drops one
 * segment's records, leaving it with zero active hours.
 */
/**
 * Fold `extra` into `target`. Used only when two segments of one session resolve
 * to the SAME user, which the server cannot represent as two rows: it keys
 * sessions by (user_id, session_id), so the second upload would overwrite the
 * first and leave the session holding one segment while daily holds both.
 */
function mergeInto(target: SessionSummary, extra: SessionSummary): void {
  for (const f of [
    "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens",
  ] as const) {
    target.totals[f] += extra.totals[f];
  }
  target.messageCount += extra.messageCount;
  // NOT covered by a test, deliberately noted rather than faked: a merge only
  // happens when two segments resolve to the same user, which today only occurs
  // for UNVERIFIED Codex segments — and pricing.ts returns 0 for every Codex
  // model, so both operands are always 0. Kept because it is correct if either
  // of those facts changes; do not read the green suite as proof of this line.
  target.notionalCostUsd += extra.notionalCostUsd;
  // buildSession resolves cwd/branch/task as "latest non-null wins". `extra` is
  // the LATER visit, so its values must win here too — otherwise a merged row
  // carries the later visit's tokens under the earlier visit's project and Jira
  // key, and the work is reported against the wrong task.
  if (extra.project) target.project = extra.project;
  if (extra.gitBranch) target.gitBranch = extra.gitBranch;
  if (extra.jiraKey) target.jiraKey = extra.jiraKey;
  if (extra.epicKey) target.epicKey = extra.epicKey;
  if (extra.epicSummary) target.epicSummary = extra.epicSummary;
  const byModel = new Map(target.modelUsage.map((m) => [m.model, m]));
  for (const m of extra.modelUsage) {
    const cur = byModel.get(m.model);
    if (!cur) { target.modelUsage.push(m); byModel.set(m.model, m); continue; }
    cur.inputTokens += m.inputTokens;
    cur.outputTokens += m.outputTokens;
    cur.cacheCreationTokens += m.cacheCreationTokens;
    cur.cacheReadTokens += m.cacheReadTokens;
    cur.totalTokens += m.totalTokens;
    cur.costUsd += m.costUsd;
  }
  target.models = target.modelUsage.map((m) => m.model);
}

function segmentKey(provider: UsageProvider, sessionId: string, index: number): string {
  return `${provider}:${sessionId}#${index}`;
}

/**
 * Split each model's authoritative token counts across the segments.
 *
 * Returns whole numbers, not ratios, and they SUM to the authoritative figure
 * for every field. Scaling by a ratio and rounding each segment independently
 * does not conserve: three thirds of 2 floor to 0+0+1, and two halves of 1 round
 * to 1+1. Largest remainder assigns the floor to everyone, then hands the
 * leftover units to the segments with the largest fractional parts.
 */
function apportionModels(
  segments: { recs: UsageRecord[] }[],
  models: ModelUsage[],
): Map<string, TokenTotals>[] {
  const components = [
    "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens",
  ] as const;
  const out: Map<string, TokenTotals>[] = segments.map(() => new Map());

  // Our own per-segment, per-model counts — used only as WEIGHTS.
  const weights = segments.map((seg) => {
    const m = new Map<string, number>();
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
    // A model no segment used locally: give it entirely to the first segment
    // rather than dropping it, so its authoritative tokens never vanish.
    const share = wSum > 0 ? w.map((x) => x / wSum) : w.map((_, i) => (i === 0 ? 1 : 0));

    const totals = segments.map(() => ({
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
      cacheReadTokens: 0, totalTokens: 0,
    }));
    // totalTokens is DERIVED from the components below, never apportioned on its
    // own: rounding it separately let a row report total=1 while its own parts
    // added to 2, and the server stores both.
    for (const field of components) {
      const total = model[field];
      const exact = share.map((f) => total * f);
      const floors = exact.map((x) => Math.floor(x));
      let left = total - floors.reduce((a, b) => a + b, 0);
      // Hand out the remaining units to the largest fractional parts first.
      const order = exact
        .map((x, i) => ({ i, frac: x - Math.floor(x) }))
        .sort((a, b) => b.frac - a.frac);
      const give = floors.slice();
      for (const { i } of order) {
        if (left <= 0) break;
        give[i] = give[i]! + 1;
        left -= 1;
      }
      give.forEach((v, i) => { totals[i]![field] = v; });
    }
    totals.forEach((t, i) => {
      t.totalTokens = t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
      if (t.totalTokens > 0) out[i]!.set(model.model, t);
    });
  }
  return out;
}

/**
 * Group a session's records by the account signed in when each was produced.
 *
 * Without this, a session that switched accounts mid-flight is attributed
 * WHOLLY to one of them. That is not merely mislabelled: the earlier account
 * already uploaded the session's running total, so re-attributing the grown
 * total to the second account leaves BOTH rows in the database and the period
 * rollup counts the work twice.
 *
 * Returns one entry when nothing switched, which is the normal case.
 */
function splitByAccount(
  recs: UsageRecord[],
  timeline: SessionAccount[] | undefined,
): { account?: SessionAccount; recs: UsageRecord[] }[] {
  if (!timeline || timeline.length <= 1) {
    return [{ account: timeline?.[0], recs }];
  }
  // Bucketed by the timeline ENTRY, not by the account string. A session that
  // goes A -> B -> A has three entries, and the third may carry stronger
  // identity evidence than the first; merging them by address reuses the first
  // entry and throws that evidence away.
  const buckets = timeline.map((account) => ({ account, recs: [] as UsageRecord[] }));
  const indexOf = new Map(timeline.map((entry, i) => [entry, i]));
  for (const r of recs) {
    const entry = accountAt(timeline, r.timestamp);
    const i = entry ? indexOf.get(entry) ?? 0 : 0;
    buckets[i]!.recs.push(r);
  }
  return buckets.filter((b) => b.recs.length > 0);
}

export function analyze(records: UsageRecord[], opts: AnalyzeOptions): AnalysisResult {
  const filtered = opts.project
    ? records.filter((r) => r.cwd && path.basename(r.cwd) === opts.project)
    : records;
  const bySession = new Map<string, UsageRecord[]>();
  for (const r of filtered) {
    const key = sessionTaskKey(r.provider, r.sessionId);
    (bySession.get(key) ?? bySession.set(key, []).get(key)!).push(r);
  }
  // Split each session at its account switches. A session that never switched
  // yields exactly one segment, so this is a no-op for almost every session.
  //
  // The segment's records are kept alongside its summary: active time is
  // apportioned per SEGMENT further down, and keying that by session id alone
  // gave every segment the whole session's hours (0.5h became 2 x 0.5h).
  const built: SessionSummary[] = [];
  const segRecords = new Map<string, UsageRecord[]>();
  // summary -> its segment key, so the active-time lookup cannot depend on the
  // resolved user (which two segments may share).
  const builtKeys = new Map<SessionSummary, string>();
  for (const recs of bySession.values()) {
    const sessionId = recs[0]!.sessionId;
    const provider = recs[0]!.provider;
    const timeline = opts.sessionAccounts?.get(sessionTaskKey(provider, sessionId));
    const segments = splitByAccount(recs, timeline);
    // Per-model share of the session, used to apportion ccusage's authoritative
    // numbers. Computed from OUR counts, which is only a ratio — the price per
    // token still comes from ccusage.
    const cost = provider === "claude" ? opts.ccusageCost?.get(sessionId) : undefined;
    const shares = segments.length > 1 && cost
      ? apportionModels(segments, cost.models)
      : undefined;
    // Build first, then MERGE any segments that resolved to the same user.
    // The server keys sessions by (user_id, session_id), so two such segments
    // are one row there: sending both makes the second overwrite the first — the
    // session ends up with one segment's tokens while daily has both.
    const byUser = new Map<string, { summary: SessionSummary; recs: UsageRecord[] }>();
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

  // Active time (KI-759), derived so per-session and daily rollups AGREE.
  // Bucket every record by calendar DAY (and, within the day, by session):
  //   1. a day's coarse active hours = ALL that day's events merged into one
  //      timeline (concurrent sessions never double-count);
  //   2. that day's hours are apportioned across the day's sessions by each
  //      session's share of raw same-day active. A multi-day session sums its
  //      per-day shares — so no single session can exceed a day, and the daily
  //      rollup (per user+day, from these shares) == Σ its sessions == what
  //      epics sum.
  // Which segment each record belongs to, so a day's active time is apportioned
  // across SEGMENTS. Keying by session alone handed every segment of a split
  // session the session's full hours.
  const recordSegment = new Map<UsageRecord, string>();
  for (const [key, recs] of segRecords) for (const r of recs) recordSegment.set(r, key);

  const recsByDay = new Map<string, UsageRecord[]>();
  const daySessions = new Map<string, Map<string, UsageRecord[]>>();
  for (const r of filtered) {
    const d = localDay(r.timestamp);
    (recsByDay.get(d) ?? recsByDay.set(d, []).get(d)!).push(r);
    const sm = daySessions.get(d) ?? daySessions.set(d, new Map()).get(d)!;
    const key = recordSegment.get(r) ?? sessionTaskKey(r.provider, r.sessionId);
    (sm.get(key) ?? sm.set(key, []).get(key)!).push(r);
  }
  const sessionActiveHours = new Map<string, number>();
  for (const [day, recs] of recsByDay) {
    recs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const dayHours = toActiveHours(activeMs(recs));
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
    .map((s) => ({
      ...s,
      activeTimeHours: sessionActiveHours.get(builtKeys.get(s) ?? "") ?? 0,
    }))
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
    daily: buildDaily(sessions),
    modelUsage: rollupModels(sessions),
    totals,
    notionalCostUsd,
    hasUnpricedCodex: sessions.some((session) => !session.costAvailable),
  };
}
