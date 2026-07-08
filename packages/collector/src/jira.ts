import { execFileSync } from "node:child_process";

/** Jira key like ABT-192, BI-145, KI-610. */
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/**
 * Allowed Jira project prefixes. The bare key pattern also matches non-Jira
 * tokens (GPU-2, ADR-1, YOLOE-26), so we only accept keys whose prefix is a real
 * project. Override via CC_USAGE_JIRA_PROJECTS (comma-separated). Empty = accept
 * any prefix (back-compat escape hatch).
 */
const ALLOWED_PROJECTS = (process.env.CC_USAGE_JIRA_PROJECTS ?? "KI,BI,ABT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export interface JiraConfig {
  /** Scan git commit messages when the branch has no key. Default true. */
  scanCommits: boolean;
}

export const defaultJiraConfig: JiraConfig = { scanCommits: true };

/**
 * Commits are usually made shortly AFTER a coding session ends, so we extend the
 * commit-scan window past session end by this grace period (and slightly before
 * start for prep commits). Wide enough to catch "coded then committed", tight
 * enough not to absorb the next day's unrelated work.
 */
const COMMIT_GRACE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h
const COMMIT_GRACE_BEFORE_MS = 30 * 60 * 1000; // 30m

export function extractKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const key = JIRA_KEY_RE.exec(text)?.[1] ?? null;
  if (!key) return null;
  // Reject keys whose prefix isn't a real project (GPU-2, ADR-1, …).
  if (ALLOWED_PROJECTS.length && !ALLOWED_PROJECTS.includes(key.split("-")[0]!)) {
    return null;
  }
  return key;
}

// NOTE(limit): commit scan resolves against the CURRENT repo at the logged cwd.
// If a project dir was moved/renamed since the session, git -C fails and the
// session falls through to project-default/Unassigned. Fine for daily runs on
// fresh logs (cwd still valid); only affects backfill over old, moved dirs.
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // not a repo / git missing / dir gone
  }
}

/**
 * Find a Jira key from commits made DURING the session window, tying the key to
 * work actually done in that session. We intentionally do NOT fall back to the
 * repo's latest commit — that over-attributes unrelated sessions to whatever key
 * happened to be committed last. No window commit → defer to project default.
 */
function keyFromCommits(cwd: string, since: Date, until: Date): string | null {
  const from = new Date(since.getTime() - COMMIT_GRACE_BEFORE_MS);
  const to = new Date(until.getTime() + COMMIT_GRACE_AFTER_MS);
  const inWindow = git(cwd, [
    "log",
    `--since=${from.toISOString()}`,
    `--until=${to.toISOString()}`,
    "--format=%s%n%b",
  ]);
  return extractKey(inWindow);
}

/**
 * Resolve a session's Jira key by cascade:
 * 1. branch name  2. commits in the session window  3. per-project default
 * Returns null when none match (caller treats as "Unassigned").
 */
export function resolveJiraKey(
  p: { branch: string | null; cwd: string | null; project: string | null },
  since: Date,
  until: Date,
  cfg: JiraConfig,
): string | null {
  // Branches are structured, so allow lowercase keys (feat/ki-675-...) → KI-675.
  const fromBranch = extractKey(p.branch?.toUpperCase());
  if (fromBranch) return fromBranch;
  if (cfg.scanCommits && p.cwd) {
    const fromCommit = keyFromCommits(p.cwd, since, until);
    if (fromCommit) return fromCommit;
  }
  // No project→key fallback: attribution must come from an explicit declaration
  // (the /task command / sidecar) or a real branch/commit signal — never a guess
  // from the project name. Projects differ and this must scale company-wide.
  return null;
}
