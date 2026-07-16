#!/usr/bin/env bash
# Best-effort auto-capture of a Jira key for the current session.
# Resolution order: env CC_JIRA -> <cwd>/.ccjira file -> git branch.
# Appends {sessionId, jira, epic?, cwd, ts, src} to ~/.claude/cc-usage/tasks.jsonl.
# The latest event per session wins, so an explicit /task overrides this later.
#
# Usable as a SessionStart/SessionEnd hook (reads the hook JSON on stdin) or
# standalone. Never blocks the session.
set -euo pipefail

node -e '
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
let p = {};
try { p = JSON.parse(input); } catch {}

const sid = p.session_id || p.sessionId || "";
const cwd = p.cwd || process.cwd();

const dir = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "cc-usage"
);
try { fs.mkdirSync(dir, { recursive: true }); } catch {}

// Keep cwd -> sessionId fresh so /task can resolve the session.
if (sid) {
  const curFile = path.join(dir, "current.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(curFile, "utf8")); } catch {}
  cur[cwd] = sid;
  try { fs.writeFileSync(curFile, JSON.stringify(cur)); } catch {}
}

const KEY = /[A-Z][A-Z0-9]+-\d+/;
let jira = (process.env.CC_JIRA || "").toUpperCase().match(KEY)?.[0] || "";
if (!jira) {
  try { jira = fs.readFileSync(path.join(cwd, ".ccjira"), "utf8").toUpperCase().match(KEY)?.[0] || ""; } catch {}
}
if (!jira) {
  try {
    const b = cp.execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).toUpperCase();
    jira = b.match(KEY)?.[0] || "";
  } catch {}
}

if (sid && jira) {
  const row = { sessionId: sid, jira, cwd, ts: new Date().toISOString(), src: "hook" };
  const epic = (process.env.CC_EPIC || "").toUpperCase().match(KEY)?.[0] || "";
  if (epic) row.epic = epic;
  try { fs.appendFileSync(path.join(dir, "tasks.jsonl"), JSON.stringify(row) + "\n"); } catch {}
}

// Per-session account: record the Claude account signed in NOW (independent of
// jira), so each session is credited to the account/plan actually in use then —
// even after the user switches accounts or the collector later runs under a
// different login. The collector reads this via loadSessionAccounts.
if (sid) {
  try {
    const cfgPath = process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
      : path.join(os.homedir(), ".claude.json");
    const oa = JSON.parse(fs.readFileSync(cfgPath, "utf8")).oauthAccount || {};
    const account = String(oa.emailAddress || "").toLowerCase();
    const plan = String(oa.organizationType || "");
    if (account.includes("@")) {
      const arow = { sessionId: sid, account, plan, cwd, ts: new Date().toISOString(), src: "hook-acct" };
      fs.appendFileSync(path.join(dir, "tasks.jsonl"), JSON.stringify(arow) + "\n");
    }
  } catch {}
}
' || true   # never block the session on hook failure
