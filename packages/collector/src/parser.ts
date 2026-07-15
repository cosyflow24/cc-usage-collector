import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import type { EventKind, UsageRecord } from "./types.ts";

/**
 * Classify an event from its JSONL `type` + content-block shapes. Content TEXT is
 * never read/kept — only the block `type`s (tool_use / tool_result / text) which
 * tell us whether this is a human prompt, an assistant answer, a tool dispatch, or
 * a tool return. Drives the agent-run vs prompt-gap distinction in active-time.
 */
function classifyKind(type: unknown, content: unknown): EventKind {
  const blocks = Array.isArray(content) ? content : [];
  const has = (t: string) => blocks.some((b) => b && (b as { type?: string }).type === t);
  if (type === "assistant") return has("tool_use") ? "tool_use" : "answer";
  if (type === "user") {
    if (has("tool_result")) return "tool_result";
    if (typeof content === "string" || has("text") || has("image")) return "prompt";
  }
  return "other";
}

/** Default Claude Code projects log dir. Override with CLAUDE_CONFIG_DIR. */
export function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  return path.join(base, "projects");
}

/** Recursively list *.jsonl files under the projects dir. */
async function listLogFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A MISSING dir is expected (no logs yet). Anything else (EACCES, EIO, …)
    // must warn — otherwise a permissions problem reads as "TOTAL sessions 0"
    // with exit 0 and silently uploads nothing.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      process.stderr.write(`warning: cannot read ${dir}: ${String(err)}\n`);
    }
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listLogFiles(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function num(v: unknown): number {
  // Clamp to >= 0: a corrupt negative count must never subtract from totals.
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

// A legit usage line is a few KB; anything near 1MB is a corrupt/runaway line.
// Skip it before JSON.parse so one bad line can't exhaust memory for the run.
const MAX_LINE_LEN = 1_000_000;

/** Parse one JSONL line into a UsageRecord, or null if not a timestamped record. */
function parseLine(line: string): UsageRecord | null {
  if (!line || line.length > MAX_LINE_LEN) return null;
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return null; // skip malformed line, don't abort the file
  }
  const ts = row?.timestamp;
  const sessionId = row?.sessionId;
  if (typeof ts !== "string" || typeof sessionId !== "string") return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;

  const usage = row?.message?.usage ?? {};
  // De-dup identity: message.id (+ requestId). Same message logged on many lines
  // → count its usage once. Null when absent (those lines carry no message id).
  const msgId = typeof row?.message?.id === "string" ? row.message.id : null;
  const reqId = typeof row?.requestId === "string" ? row.requestId : "";
  return {
    sessionId,
    timestamp: date,
    model: typeof row?.message?.model === "string" ? row.message.model : null,
    cwd: typeof row?.cwd === "string" ? row.cwd : null,
    gitBranch: typeof row?.gitBranch === "string" ? row.gitBranch : null,
    kind: classifyKind(row?.type, row?.message?.content),
    dedupeKey: msgId ? `${msgId}|${reqId}` : null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

/** Stream all records within [since, until], across all log files. */
export async function readRecords(
  since: Date,
  until: Date,
  dir = projectsDir(),
): Promise<UsageRecord[]> {
  const files = await listLogFiles(dir);
  const records: UsageRecord[] = [];
  // Global across all files: the same message id can appear in multiple session
  // files (sidechains/subagents). Count each once.
  // TODO(debt): 现在=dedup/parse logic proven only by manual fixtures (audit found
  // zero tests here) 完整=node --test fixtures for parser dedup (historic ~2x
  // double-count), analyze active-time gaps, pricing, upload splitting, config.
  const seen = new Set<string>();
  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const rec = parseLine(line);
      if (!rec || rec.timestamp < since || rec.timestamp > until) continue;
      if (rec.dedupeKey) {
        if (seen.has(rec.dedupeKey)) continue; // duplicate usage → skip
        seen.add(rec.dedupeKey);
      }
      records.push(rec);
    }
  }
  return records;
}
