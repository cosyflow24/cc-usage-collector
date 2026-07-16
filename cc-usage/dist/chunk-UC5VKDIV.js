#!/usr/bin/env node
import { createRequire as __ccuCreateRequire } from 'module';
const require = __ccuCreateRequire(import.meta.url);

// src/config.ts
import { execFileSync as execFileSync2 } from "child_process";
import { readFileSync } from "fs";
import { hostname, homedir } from "os";
import path from "path";

// src/jira.ts
import { execFileSync } from "child_process";
var JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
var ALLOWED_PROJECTS = (process.env.CC_USAGE_JIRA_PROJECTS ?? "KI,BI,ABT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
var defaultJiraConfig = { scanCommits: true };
var COMMIT_GRACE_AFTER_MS = 6 * 60 * 60 * 1e3;
var COMMIT_GRACE_BEFORE_MS = 30 * 60 * 1e3;
function extractKey(text) {
  if (!text) return null;
  const key = JIRA_KEY_RE.exec(text)?.[1] ?? null;
  if (!key) return null;
  if (ALLOWED_PROJECTS.length && !ALLOWED_PROJECTS.includes(key.split("-")[0])) {
    return null;
  }
  return key;
}
function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function keyFromCommits(cwd, since, until) {
  const from = new Date(since.getTime() - COMMIT_GRACE_BEFORE_MS);
  const to = new Date(until.getTime() + COMMIT_GRACE_AFTER_MS);
  const inWindow = git(cwd, [
    "log",
    `--since=${from.toISOString()}`,
    `--until=${to.toISOString()}`,
    "--format=%s%n%b"
  ]);
  return extractKey(inWindow);
}
function resolveJiraKey(p, since, until, cfg) {
  const fromBranch = extractKey(p.branch?.toUpperCase());
  if (fromBranch) return fromBranch;
  if (cfg.scanCommits && p.cwd) {
    const fromCommit = keyFromCommits(p.cwd, since, until);
    if (fromCommit) return fromCommit;
  }
  return null;
}

// src/config.ts
var DEFAULT_WORK_DOMAIN = "nnb24.de";
function resolveAccountEmail() {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : null,
    path.join(homedir(), ".claude.json")
  ].filter((p) => p !== null);
  for (const file of candidates) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      const email = j.oauthAccount?.emailAddress;
      if (typeof email === "string" && email.includes("@")) return email.toLowerCase();
    } catch {
    }
  }
  return null;
}
function isWorkAccount(email, domain = process.env.CC_USAGE_WORK_DOMAIN ?? DEFAULT_WORK_DOMAIN) {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}
function loadJiraConfig() {
  return { ...defaultJiraConfig };
}
function resolveUser() {
  if (process.env.CC_USAGE_USER) return process.env.CC_USAGE_USER.trim();
  const account = resolveAccountEmail();
  if (account) return account;
  try {
    const email = execFileSync2("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (email) return email;
  } catch {
  }
  return hostname();
}
function dayStart(offset = 0) {
  const d = /* @__PURE__ */ new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}
function resolveRange(opts) {
  const until = opts.until ? new Date(opts.until) : /* @__PURE__ */ new Date();
  let since;
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

export {
  defaultJiraConfig,
  resolveJiraKey,
  resolveAccountEmail,
  isWorkAccount,
  loadJiraConfig,
  resolveUser,
  resolveRange
};
