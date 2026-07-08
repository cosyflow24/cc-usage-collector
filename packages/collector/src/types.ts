/** Normalized usage record extracted from one JSONL line. */
export interface UsageRecord {
  sessionId: string;
  timestamp: Date;
  model: string | null;
  cwd: string | null;
  gitBranch: string | null;
  /**
   * Stable identity (message.id + requestId) for de-duplication. Claude Code
   * logs the same assistant message across multiple JSONL lines (streaming,
   * sidechains), so the SAME usage appears many times; counting every line
   * double-counts tokens (~2x). Null when the line carries no message id (those
   * are not deduped). Mirrors ccusage's dedup strategy.
   */
  dedupeKey: string | null;
  /** Token counts; 0 for non-assistant / no-usage records. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /**
   * Event kind, derived from the JSONL type + content blocks (KI-759, Daniel's
   * decision): distinguishes a human `prompt`, an assistant `answer`, a
   * `tool_use` dispatch, and its `tool_result` return — so active-time can treat
   * an agent RUN (tool_use → tool_result span) differently from prompt-prep gaps.
   * Derived locally from content shape only; no prompt/response text is kept.
   */
  kind: EventKind;
}

export type EventKind = "prompt" | "answer" | "tool_use" | "tool_result" | "other";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

/** Per-model token rollup plus its notional USD cost (what tokens WOULD cost). */
export interface ModelUsage extends TokenTotals {
  model: string;
  /** Notional USD at public API rates. Employees are not billed per token. */
  costUsd: number;
}

export interface SessionSummary {
  sessionId: string;
  user: string;
  project: string | null;
  gitBranch: string | null;
  jiraKey: string | null;
  /** Epic key (declared via sidecar, else null — epic-sync backfills later). */
  epicKey: string | null;
  epicSummary: string | null;
  /**
   * Local calendar day (YYYY-MM-DD) the session falls on. We never store the
   * exact time-of-day — only this coarse bucket.
   */
  day: string;
  messageCount: number;
  models: string[];
  modelUsage: ModelUsage[];
  totals: TokenTotals;
  /** Notional USD across all models. Labelled "notional · not billed" in UI. */
  notionalCostUsd: number;
  /**
   * Estimated active hours for this session (KI-759), rounded coarse (quarter
   * hour). A PLANNING signal for effort estimation — explicitly NOT work-time
   * tracking, never minute/second precision, never a per-person ranking.
   * Gap-based: sums gaps capped at T_THINK, drops gaps over T_SESSION (AFK).
   */
  activeTimeHours: number;
}

export interface DailySummary {
  day: string; // YYYY-MM-DD
  user: string;
  sessions: number;
  modelUsage: ModelUsage[];
  totals: TokenTotals;
  notionalCostUsd: number;
  /**
   * Active hours for the whole day (KI-759), computed from ALL of the user's
   * events that day merged into one timeline — NOT a sum of per-session hours,
   * so concurrent sessions never double-count. "Wie viele Stunden an einem Tag."
   */
  activeTimeHours: number;
}

export interface AnalysisResult {
  user: string;
  range: { since: string; until: string };
  sessions: SessionSummary[];
  daily: DailySummary[];
  modelUsage: ModelUsage[];
  totals: TokenTotals;
  notionalCostUsd: number;
}
