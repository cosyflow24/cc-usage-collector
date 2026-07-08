import type { ModelUsage, TokenTotals } from "./types.ts";

/**
 * Notional USD pricing. We compute what tokens WOULD cost at public API rates;
 * employees are on enterprise seats (later Max) and are NEVER billed per token.
 * Always label as "notional · not billed" in any UI.
 *
 * Rates are USD per 1,000,000 tokens, mirroring ccusage / LiteLLM
 * (model_prices_and_context_window.json). SYNC-CHECK these against
 * `npx ccusage@latest --offline` periodically — see ccusage.ts for the runtime
 * reconciliation path. Snapshot source: LiteLLM pricing JSON, 2026-06-26.
 *
 * Cache pricing: Anthropic charges cache WRITES at ~1.25x base input and cache
 * READS at ~0.1x base input. We derive both from the input rate via multipliers
 * rather than hardcoding four numbers per model. Verified against LiteLLM
 * 2026-06-26: opus-4-8 cacheCreate 6.25 = 1.25×5, cacheRead 0.5 = 0.1×5.
 *
 * IMPORTANT: Opus 4.5+/4.6/4.7/4.8 are priced at $5/$25 per 1M (NOT the older
 * Opus 4.0/4.1 $15/$75). Mixing these up roughly triples opus cost — sync-check
 * via --ccusage-check after any rate edit.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

interface Rate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

const PER_MILLION = 1_000_000;

// Per-1M base rates (input/output). Cache rates are derived via the multipliers.
const RATES: Record<string, Rate> = {
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
  "claude-3-5-haiku": { input: 0.8, output: 4 },
};

// Fallbacks for unknown/aliased model ids — match by family substring so a new
// point release (e.g. claude-opus-4-9) still prices sensibly until RATES grows.
const FAMILY_FALLBACKS: ReadonlyArray<[string, Rate]> = [
  ["opus", RATES["claude-opus-4-8"]!],
  ["sonnet", RATES["claude-sonnet-4-6"]!],
  ["haiku", RATES["claude-haiku-4-5"]!],
];

// Last-resort default when nothing matches (treat as Sonnet-class, mid-range).
const DEFAULT_RATE: Rate = RATES["claude-sonnet-4-6"]!;

function rateFor(model: string): Rate {
  const exact = RATES[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  for (const [family, rate] of FAMILY_FALLBACKS) {
    if (lower.includes(family)) return rate;
  }
  return DEFAULT_RATE;
}

/** Notional USD cost for a per-model token rollup. */
export function costForModelUsage(mu: Pick<ModelUsage, "model"> & TokenTotals): number {
  const r = rateFor(mu.model);
  const cost =
    (mu.inputTokens * r.input +
      mu.outputTokens * r.output +
      mu.cacheCreationTokens * r.input * CACHE_WRITE_MULTIPLIER +
      mu.cacheReadTokens * r.input * CACHE_READ_MULTIPLIER) /
    PER_MILLION;
  // Guard against NaN from corrupt token counts; cost is always a finite number.
  return Number.isFinite(cost) ? cost : 0;
}
