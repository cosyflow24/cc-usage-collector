import type { AnalysisResult } from "./types.ts";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Human-readable summary table for terminal output. Cost is notional. */
export function formatTable(r: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`User: ${r.user}`);
  lines.push(`Range: ${r.range.since} → ${r.range.until}`);
  lines.push("Cost is NOTIONAL (public API rates) · employees are not billed per token.");
  lines.push("");

  lines.push("By model:");
  for (const m of r.modelUsage) {
    lines.push(
      `  ${m.model.padEnd(28)} ${fmtCost(m.costUsd).padStart(9)}  ` +
        `${fmtTokens(m.totalTokens).padStart(8)}  ` +
        `(in ${fmtTokens(m.inputTokens)} / out ${fmtTokens(m.outputTokens)} / ` +
        `cache ${fmtTokens(m.cacheCreationTokens + m.cacheReadTokens)})`,
    );
  }
  lines.push("");

  lines.push("By day:");
  for (const d of r.daily) {
    lines.push(
      `  ${d.day}  sessions ${String(d.sessions).padStart(3)}  ` +
        `cost ${fmtCost(d.notionalCostUsd).padStart(9)}  ` +
        `tokens ${fmtTokens(d.totals.totalTokens).padStart(8)}`,
    );
  }
  lines.push("");

  lines.push("Sessions:");
  for (const s of r.sessions) {
    const tag = s.epicKey ?? s.jiraKey ?? s.gitBranch ?? "-";
    lines.push(
      `  ${s.day}  ` +
        `${(s.project ?? "-").padEnd(22).slice(0, 22)}  ` +
        `${tag.padEnd(16).slice(0, 16)}  ` +
        `${fmtCost(s.notionalCostUsd).padStart(9)}  ` +
        `${fmtTokens(s.totals.totalTokens).padStart(8)}  ` +
        `[${s.models.join(",")}]`,
    );
  }
  lines.push("");
  lines.push(
    `TOTAL  sessions ${r.sessions.length}  ` +
      `notional ${fmtCost(r.notionalCostUsd)}  ` +
      `tokens ${fmtTokens(r.totals.totalTokens)}`,
  );
  return lines.join("\n");
}
