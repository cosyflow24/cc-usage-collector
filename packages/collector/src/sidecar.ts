import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { UsageProvider } from "./types.ts";

/**
 * In-flow task declarations captured during sessions (by the /task command and
 * the SessionStart/End hooks). Append-only JSONL of:
 *   { "schemaVersion": 1, "sessionId": "...", "jira": "KI-758",
 *     "epic": "KI-700", "cwd": "...", "ts": "ISO" }
 * The latest event per session wins, so a mid-session switch is honored. An
 * explicit declaration here beats any heuristic in jira.ts.
 */
export function sidecarPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  return path.join(base, "cc-usage", "tasks.jsonl");
}

export interface SessionTask {
  jira: string;
  epic?: string;
}

export function sessionTaskKey(provider: UsageProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

/** Map sessionId → declared { jira, epic? } (latest ts per session wins). */
export function loadSessionTasks(file = sidecarPath()): Map<string, SessionTask> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return new Map(); // no declarations yet
  }
  const latestTs = new Map<string, string>();
  const result = new Map<string, SessionTask>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: { provider?: unknown; sessionId?: unknown; jira?: unknown; epic?: unknown; ts?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sessionId !== "string" || typeof row.jira !== "string" || !row.jira) continue;
    const provider: UsageProvider = row.provider === "codex" ? "codex" : "claude";
    const composite = sessionTaskKey(provider, row.sessionId);
    const ts = typeof row.ts === "string" ? row.ts : "";
    const prev = latestTs.get(composite);
    if (prev === undefined || ts >= prev) {
      latestTs.set(composite, ts);
      const task: SessionTask = { jira: row.jira };
      if (typeof row.epic === "string" && row.epic) task.epic = row.epic;
      result.set(composite, task);
    }
  }
  return result;
}

export interface SessionAccount {
  /** Matching provider account email signed in during the session. */
  account: string;
  /** organizationType, e.g. "claude_max" | "enterprise". */
  plan?: string;
  /** True only when the row was captured from that provider's own auth store. */
  providerVerified?: boolean;
  /** When this account became the signed-in one. Empty for pre-timeline rows. */
  ts?: string;
}

/**
 * Map sessionId → the TIMELINE of provider accounts used during that session,
 * oldest first. The hooks record the signed-in account at session start and
 * again whenever it CHANGES, so a session that switched accounts mid-flight has
 * several entries.
 *
 * A timeline rather than a single winner because a session can legitimately span
 * two accounts: attributing all of it to the last one would move usage the first
 * account really produced, and attributing all of it to the first would leave the
 * switch unrecorded. analyze() splits the records at these boundaries instead.
 * Unlike loadSessionTasks, account-only rows (no jira) are honored.
 */
export function loadSessionAccounts(file = sidecarPath()): Map<string, SessionAccount[]> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  const result = new Map<string, SessionAccount[]>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      provider?: unknown;
      sessionId?: unknown;
      account?: unknown;
      plan?: unknown;
      identitySource?: unknown;
      ts?: unknown;
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sessionId !== "string" || typeof row.account !== "string" || !row.account) {
      continue;
    }
    const provider: UsageProvider = row.provider === "codex" ? "codex" : "claude";
    const composite = sessionTaskKey(provider, row.sessionId);
    const ts = typeof row.ts === "string" ? row.ts : "";
    const acct: SessionAccount = { account: row.account, ts };
    if (typeof row.plan === "string" && row.plan) acct.plan = row.plan;
    acct.providerVerified = provider === "claude" || row.identitySource === "codex-id-token";
    const list = result.get(composite);
    if (list) list.push(acct);
    else result.set(composite, [acct]);
  }
  // Oldest first, and collapse repeats: only a CHANGE starts a new segment, so a
  // re-recorded identical account must not split the session in two.
  for (const [key, list] of result) {
    list.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
    const collapsed: SessionAccount[] = [];
    for (const a of list) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1]!.account !== a.account) {
        collapsed.push(a);
      }
    }
    result.set(key, collapsed);
  }
  return result;
}

/** The account in effect at `when`, or the earliest known one before any switch. */
export function accountAt(
  timeline: SessionAccount[] | undefined,
  when: Date,
): SessionAccount | undefined {
  // Defensive: a caller holding an older shape (a single account rather than a
  // list) must degrade to "unknown", never throw inside the analysis pass.
  if (!Array.isArray(timeline) || timeline.length === 0) return undefined;
  const iso = when.toISOString();
  let current = timeline[0];
  for (const entry of timeline) {
    // A row with no ts cannot be placed in time; treat it as "from the start"
    // so old sidecar history keeps behaving exactly as it did.
    if (!entry.ts || entry.ts <= iso) current = entry;
    else break;
  }
  return current;
}
