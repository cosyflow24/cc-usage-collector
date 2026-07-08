import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { type JiraConfig, defaultJiraConfig } from "./jira.ts";

/** Default work-email domain that gates reporting. Override CC_USAGE_WORK_DOMAIN. */
const DEFAULT_WORK_DOMAIN = "nnb24.de";

/**
 * Read the Claude Code OAuth account email from ~/.claude.json
 * (oauthAccount.emailAddress). Returns null if not found / not logged in.
 */
export function resolveAccountEmail(): string | null {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
      : null,
    path.join(homedir(), ".claude.json"),
  ].filter((p): p is string => p !== null);
  for (const file of candidates) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as {
        oauthAccount?: { emailAddress?: unknown };
      };
      const email = j.oauthAccount?.emailAddress;
      if (typeof email === "string" && email.includes("@")) return email.toLowerCase();
    } catch {
      // missing / unreadable / malformed → try next candidate
    }
  }
  return null;
}

/**
 * True when the currently logged-in Claude account is a work account (its email
 * ends with the configured domain). PRIVACY/POLICY: only work-account usage is
 * reported; a developer signed into a personal account is never uploaded.
 */
export function isWorkAccount(
  email: string | null,
  domain = process.env.CC_USAGE_WORK_DOMAIN ?? DEFAULT_WORK_DOMAIN,
): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}

/**
 * Jira resolution config. Attribution comes only from an explicit /task
 * declaration (sidecar) or a real branch/commit signal — there is deliberately
 * no project→key fallback (projects differ; must scale company-wide).
 * `--no-commit-scan` (cli) turns the commit scan off.
 */
export function loadJiraConfig(): JiraConfig {
  return { ...defaultJiraConfig };
}

/**
 * Resolve the user identity for attribution. Per-machine = per-user.
 *
 * Identity = the Claude OAuth account email — the SAME signal the work-account
 * gate (isWorkAccount) checks, so attribution and gating can never diverge.
 * Earlier this used git config user.email, which drifted from the OAuth account
 * (e.g. git "yu.zha@nnb24.de" vs OAuth "zha@nnb24.de"). git email / hostname
 * remain as fallbacks only when not signed in. CC_USAGE_USER still overrides all.
 */
export function resolveUser(): string {
  if (process.env.CC_USAGE_USER) return process.env.CC_USAGE_USER.trim();
  const account = resolveAccountEmail();
  if (account) return account;
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email) return email;
  } catch {
    // git missing or no email configured → fall through
  }
  return hostname();
}

/** Start of local day for an offset (0 = today, -1 = yesterday). */
export function dayStart(offset = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

/**
 * Resolve a [since, until] window from CLI flags.
 * Default = yesterday 00:00 → now (covers "the last day" the boss asked for).
 */
export function resolveRange(opts: {
  since?: string;
  until?: string;
  days?: string;
}): { since: Date; until: Date } {
  const until = opts.until ? new Date(opts.until) : new Date();
  let since: Date;
  if (opts.since) {
    since = new Date(opts.since);
  } else if (opts.days) {
    const n = Number.parseInt(opts.days, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --days: ${opts.days}`);
    since = dayStart(-n);
  } else {
    since = dayStart(-1);
  }
  if (Number.isNaN(since.getTime())) throw new Error(`invalid --since: ${opts.since}`);
  if (Number.isNaN(until.getTime())) throw new Error(`invalid --until: ${opts.until}`);
  if (since > until) throw new Error("since is after until");
  return { since, until };
}
