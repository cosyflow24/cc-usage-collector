import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * In-flow task declarations captured during sessions (by the /task command and
 * the SessionStart/End hooks). Append-only JSONL of:
 *   { "sessionId": "...", "jira": "KI-758", "epic": "KI-700", "cwd": "...", "ts": "ISO" }
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
    let row: { sessionId?: unknown; jira?: unknown; epic?: unknown; ts?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sessionId !== "string" || typeof row.jira !== "string" || !row.jira) continue;
    const ts = typeof row.ts === "string" ? row.ts : "";
    const prev = latestTs.get(row.sessionId);
    if (prev === undefined || ts >= prev) {
      latestTs.set(row.sessionId, ts);
      const task: SessionTask = { jira: row.jira };
      if (typeof row.epic === "string" && row.epic) task.epic = row.epic;
      result.set(row.sessionId, task);
    }
  }
  return result;
}

export interface SessionAccount {
  /** Claude OAuth account email signed in during the session. */
  account: string;
  /** organizationType, e.g. "claude_max" | "enterprise". */
  plan?: string;
}

/**
 * Map sessionId → the Claude account in use DURING that session (latest ts per
 * session wins). The SessionStart hook records this from ~/.claude.json, so each
 * session is attributed to the account actually signed in then — not whatever
 * account happens to be active when the collector later runs. Unlike
 * loadSessionTasks, account-only rows (no jira) are honored.
 */
export function loadSessionAccounts(file = sidecarPath()): Map<string, SessionAccount> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  const latestTs = new Map<string, string>();
  const result = new Map<string, SessionAccount>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: { sessionId?: unknown; account?: unknown; plan?: unknown; ts?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sessionId !== "string" || typeof row.account !== "string" || !row.account) {
      continue;
    }
    const ts = typeof row.ts === "string" ? row.ts : "";
    const prev = latestTs.get(row.sessionId);
    if (prev === undefined || ts >= prev) {
      latestTs.set(row.sessionId, ts);
      const acct: SessionAccount = { account: row.account };
      if (typeof row.plan === "string" && row.plan) acct.plan = row.plan;
      result.set(row.sessionId, acct);
    }
  }
  return result;
}
