import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelUsage, TokenTotals } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Authoritative per-session numbers from ccusage: token counts (already
 * deduped) AND notional cost (LiteLLM pricing). When present, these REPLACE our
 * own counts so the numbers match ccusage exactly — our parser only contributes
 * attribution (project / branch / jira), which ccusage does not expose.
 */
export interface CcusageSessionCost {
  totalCostUsd: number;
  totals: TokenTotals;
  models: ModelUsage[];
}

/** YYYYMMDD for ccusage --since/--until (it also accepts dashed dates). */
function toCcusageDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

interface RawTokens {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
}
interface RawBreakdown extends RawTokens {
  modelName?: unknown;
  cost?: unknown;
}
interface RawSession extends RawTokens {
  agent?: unknown;
  period?: unknown; // sessionId for `ccusage session`
  totalCost?: unknown;
  modelBreakdowns?: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Token counts from a ccusage row → our TokenTotals (totalTokens summed). */
function toTotals(t: RawTokens): TokenTotals {
  const inputTokens = num(t.inputTokens);
  const outputTokens = num(t.outputTokens);
  const cacheCreationTokens = num(t.cacheCreationTokens);
  const cacheReadTokens = num(t.cacheReadTokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
  };
}

/**
 * Authoritative per-session cost from ccusage (the COST oracle). Shells out to
 * `npx ccusage@latest session --json --offline` and maps `period` → cost.
 *
 * Returns null on ANY failure (npx/network/parse/absent) — ingest must NOT
 * depend on ccusage being installed. pricing.ts is the self-sufficient primary
 * path; this is validation + a higher-fidelity override when available.
 */
export async function fetchCcusageCost(
  since: Date,
  until: Date,
): Promise<Map<string, CcusageSessionCost> | null> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      [
        "-y",
        "ccusage@latest",
        "session",
        "--json",
        "--offline",
        "--since",
        toCcusageDate(since),
        "--until",
        toCcusageDate(until),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    );

    const parsed = JSON.parse(stdout) as { session?: unknown };
    const list = Array.isArray(parsed.session) ? (parsed.session as RawSession[]) : [];
    const map = new Map<string, CcusageSessionCost>();
    for (const s of list) {
      // Filter to Claude agent rows; period carries the session UUID here.
      if (typeof s.agent === "string" && s.agent !== "claude") continue;
      if (typeof s.period !== "string") continue;
      const breakdowns = Array.isArray(s.modelBreakdowns)
        ? (s.modelBreakdowns as RawBreakdown[])
        : [];
      const models: ModelUsage[] = breakdowns
        .filter((b) => typeof b.modelName === "string")
        .map((b) => ({ model: b.modelName as string, ...toTotals(b), costUsd: num(b.cost) }));
      map.set(s.period, {
        totalCostUsd: num(s.totalCost),
        totals: toTotals(s),
        models,
      });
    }
    return map;
  } catch {
    return null; // graceful: trust pricing.ts
  }
}

/** Total notional cost from `ccusage daily` for the window — used by --ccusage-check. */
export async function fetchCcusageDailyTotal(
  since: Date,
  until: Date,
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      [
        "-y",
        "ccusage@latest",
        "daily",
        "--json",
        "--offline",
        "--since",
        toCcusageDate(since),
        "--until",
        toCcusageDate(until),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    );
    const parsed = JSON.parse(stdout) as { daily?: unknown };
    const list = Array.isArray(parsed.daily) ? (parsed.daily as RawSession[]) : [];
    return list.reduce((sum, d) => sum + num(d.totalCost), 0);
  } catch {
    return null;
  }
}
