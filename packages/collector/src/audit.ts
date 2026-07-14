import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Phase 3: ship the automated-Jira-action audit trail to the team backend.
 *
 * idle-check.sh (the LaunchAgent idle tick) appends one JSONL line per headless
 * On-Hold attempt to ~/.claude/cc-jira/jira-audit.jsonl:
 *   { "ts": "...Z", "key": "KI-758", "to": "OnHold", "by": "idle-auto",
 *     "reason": "idle>45min", "verified": false }
 * NOTE the subdir differs from the cc-usage sidecar (tasks.jsonl lives under
 * .claude/cc-usage/) — the audit file is under .claude/cc-jira/ (idle-check's
 * STATE="$CC/cc-jira"). Both honour CLAUDE_CONFIG_DIR.
 *
 * The wire shape mirrors the file 1:1 (the ingest route maps to→to_status,
 * by→by_actor, ts→event_ts and STAMPS user_id server-side — the file has no user).
 */

const KEY_RE = /^[A-Z][A-Z0-9]+-[0-9]+$/;

function cjBase(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  return path.join(base, "cc-jira");
}

export function auditPath(): string {
  return path.join(cjBase(), "jira-audit.jsonl");
}

/** Local high-water mark alongside the audit log (mirrors the sidecar convention). */
export function auditHwmPath(): string {
  return path.join(cjBase(), "audit-sync.json");
}

/** One audit line, verbatim from the file (route renames the reserved words). */
export interface AuditRow {
  ts: string;
  key: string;
  to: string;
  by: string;
  reason: string | null;
  verified: boolean;
}

/**
 * Read the audit log line-by-line, keeping only rows with event_ts >= sinceTs
 * (boundary-INCLUSIVE: event_ts is second-granular, so we re-send the boundary
 * second and let the DB unique key collapse the overlap). Defensive parse like
 * sidecar.ts: skip blank/unparseable lines, drop rows whose key fails KEY_RE.
 * `sinceTs = ""` (the default HWM) sends everything.
 */
export function loadJiraAudit(sinceTs = "", file = auditPath()): AuditRow[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return []; // no audit file yet (automation never fired here)
  }
  const rows: AuditRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: { ts?: unknown; key?: unknown; to?: unknown; by?: unknown; reason?: unknown; verified?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.ts !== "string" || !row.ts) continue;
    if (typeof row.key !== "string" || !KEY_RE.test(row.key)) continue;
    if (typeof row.to !== "string" || !row.to) continue;
    if (typeof row.by !== "string" || !row.by) continue;
    if (row.ts < sinceTs) continue; // boundary-inclusive: keep == sinceTs
    rows.push({
      ts: row.ts,
      key: row.key,
      to: row.to,
      by: row.by,
      reason: typeof row.reason === "string" ? row.reason : null,
      verified: row.verified === true,
    });
  }
  return rows;
}

/** Highest event_ts across a set of rows (for advancing the HWM). "" if empty. */
export function maxAuditTs(rows: AuditRow[]): string {
  return rows.reduce((m, r) => (r.ts > m ? r.ts : m), "");
}

/** Read the last-synced event_ts; "" (send all) when the file is missing/corrupt. */
export function readAuditHwm(file = auditHwmPath()): string {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { lastTs?: unknown };
    return typeof j.lastTs === "string" ? j.lastTs : "";
  } catch {
    return "";
  }
}

/** Persist the new high-water mark. Only call AFTER a successful upload. */
export function writeAuditHwm(lastTs: string, file = auditHwmPath()): void {
  writeFileSync(file, `${JSON.stringify({ lastTs })}\n`);
}
