import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { EventKind, UsageRecord } from "./types.ts";

const MAX_LINE_LEN = 1_000_000;

interface NormalizedSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface SessionMeta {
  sessionId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  agentRole: string | null;
  cwd: string | null;
}

export function codexSessionsDir(): string {
  const base = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  return path.join(base, "sessions");
}

async function listLogFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      process.stderr.write(`warning: cannot read ${dir}: ${String(error)}\n`);
    }
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listLogFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

function nonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Codex input_tokens includes cached/write tokens; split it without double-counting. */
function normalizeSnapshot(value: unknown): NormalizedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const totalInput = nonNegative(row.input_tokens);
  const output = nonNegative(row.output_tokens);
  if (totalInput === null || output === null) return null;
  const requestedRead = nonNegative(row.cached_input_tokens) ?? 0;
  const cacheRead = Math.min(totalInput, requestedRead);
  const requestedWrite = nonNegative(row.cache_write_input_tokens) ?? 0;
  const cacheCreation = Math.min(totalInput - cacheRead, requestedWrite);
  return {
    inputTokens: totalInput - cacheRead - cacheCreation,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
  };
}

function deltaSnapshot(
  current: NormalizedSnapshot,
  previous: NormalizedSnapshot | null,
): NormalizedSnapshot | null {
  if (!previous) return current;
  const delta = {
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens,
    cacheReadTokens: current.cacheReadTokens - previous.cacheReadTokens,
  };
  return Object.values(delta).some((v) => v < 0) ? null : delta;
}

function responseKind(payload: unknown): EventKind | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type === "message" && p.role === "user") return "prompt";
  if (p.type === "message" && p.role === "assistant") return "answer";
  if (p.type === "function_call" || p.type === "custom_tool_call") return "tool_use";
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    return "tool_result";
  }
  return null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMeta(payload: unknown): SessionMeta | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id) return null;
  const rootSessionId = typeof p.session_id === "string" && p.session_id ? p.session_id : p.id;
  return {
    sessionId: p.id,
    parentSessionId:
      typeof p.parent_thread_id === "string" && p.parent_thread_id ? p.parent_thread_id : null,
    rootSessionId,
    agentRole: typeof p.agent_role === "string" && p.agent_role ? p.agent_role : null,
    cwd: typeof p.cwd === "string" && p.cwd ? p.cwd : null,
  };
}

function makeRecord(
  meta: SessionMeta,
  timestamp: Date,
  model: string | null,
  cwd: string | null,
  kind: EventKind,
  tokens: NormalizedSnapshot,
  dedupeKey: string,
): UsageRecord {
  return {
    provider: "codex",
    sessionId: meta.sessionId,
    parentSessionId: meta.parentSessionId,
    rootSessionId: meta.rootSessionId,
    agentRole: meta.agentRole,
    timestamp,
    model,
    cwd: cwd ?? meta.cwd,
    gitBranch: null,
    dedupeKey,
    kind,
    ...tokens,
  };
}

async function parseFile(file: string, since: Date, until: Date): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let meta: SessionMeta | null = null;
  let model: string | null = null;
  let cwd: string | null = null;
  let previous: NormalizedSnapshot | null = null;
  let ordinal = 0;
  for await (const line of lines) {
    ordinal += 1;
    if (!line || line.length > MAX_LINE_LEN) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type === "session_meta") {
      // A subagent rollout starts with its own metadata, then embeds one or more
      // parent-history session_meta rows. The filename and all following live
      // events belong to the first id; replacing it would collapse child usage
      // into the parent session and corrupt task/thread attribution.
      if (!meta) meta = parseMeta(row.payload);
      continue;
    }
    if (!meta) continue;
    if (row.type === "turn_context" && row.payload && typeof row.payload === "object") {
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload.model === "string" && payload.model) model = payload.model;
      if (typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
      continue;
    }
    const timestamp = parseDate(row.timestamp);
    if (!timestamp) continue;
    const inRange = timestamp >= since && timestamp <= until;
    if (row.type === "response_item") {
      const kind = responseKind(row.payload);
      if (kind && inRange) {
        records.push(makeRecord(meta, timestamp, model, cwd, kind, {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }, `codex:${meta.sessionId}:${ordinal}`));
      }
      continue;
    }
    if (row.type !== "event_msg" || !row.payload || typeof row.payload !== "object") continue;
    const payload = row.payload as Record<string, unknown>;
    if (payload.type !== "token_count" || !payload.info || typeof payload.info !== "object") continue;
    const snapshot = normalizeSnapshot(
      (payload.info as Record<string, unknown>).total_token_usage,
    );
    if (!snapshot) continue;
    // Codex can reset cumulative counters after compaction. A decrease starts a
    // new cumulative segment; count the new segment's current snapshot instead
    // of dropping it (and every later snapshot below the old high-water mark).
    const delta = deltaSnapshot(snapshot, previous) ?? snapshot;
    previous = snapshot;
    if (!inRange || Object.values(delta).every((v) => v === 0)) continue;
    records.push(makeRecord(
      meta,
      timestamp,
      model,
      cwd,
      "answer",
      delta,
      `codex:${meta.sessionId}:tokens:${ordinal}`,
    ));
  }
  return records;
}

export async function readCodexRecords(
  since: Date,
  until: Date,
  dir = codexSessionsDir(),
): Promise<UsageRecord[]> {
  const files = await listLogFiles(dir);
  const nested = await Promise.all(files.map((file) => parseFile(file, since, until)));
  return nested.flat();
}
