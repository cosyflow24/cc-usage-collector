#!/usr/bin/env bash
# SessionStart hook for cc-usage.
#
# Two jobs:
#   1. Record cwd -> sessionId in ~/.claude/cc-usage/current.json so a later
#      /task (set-task.sh) can resolve which session to attribute.
#   2. Emit `additionalContext` (hook JSON on stdout) instructing the agent to
#      ask the user — in ONE short line — which Jira epic/task this session is
#      for, offering: reuse-last / none / type a KEY.
#
# Reads the SessionStart hook payload on stdin. Never blocks the session.
set -euo pipefail

node -e '
const fs = require("fs"), path = require("path"), os = require("os");

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

// 1) Map cwd -> current sessionId (so /task can find this session later).
if (sid) {
  const curFile = path.join(dir, "current.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(curFile, "utf8")); } catch {}
  cur[cwd] = sid;
  try { fs.writeFileSync(curFile, JSON.stringify(cur)); } catch {}
}

// 2) Soft hint ON OPEN: surface recent tasks for this folder so the dev sees
//    them at session start. Best-effort — SessionStart context is advisory; the
//    UserPromptSubmit hook (ask-task.sh) is the reliable backstop that blocks on
//    the first prompt. We skip the hint if this session is already attributed
//    (e.g. a resumed session) to avoid nagging.
function declared() {
  try {
    const lines = fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const r = JSON.parse(lines[i]); if (r && r.sessionId === sid && r.jira) return true; } catch {}
    }
  } catch {}
  return false;
}
if (!sid || declared()) process.exit(0);

function recentForCwd() {
  const out = [];
  try {
    const lines = fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").split("\n").filter(Boolean);
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0 && out.length < 3; i--) {
      try { const r = JSON.parse(lines[i]); if (!r || r.cwd !== cwd || !r.jira || seen.has(r.jira)) continue; seen.add(r.jira); out.push(r.jira); } catch {}
    }
  } catch {}
  return out;
}
function branchKey() {
  try {
    const b = require("child_process").execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().toUpperCase();
    const m = /([A-Z][A-Z0-9]+-\d+)/.exec(b);
    return m ? m[1] : null;
  } catch { return null; }
}

const recent = recentForCwd();
const bk = branchKey();
const sugg = recent.slice();
if (bk && !recent.includes(bk)) sugg.push(bk + " (branch)");
const hint = sugg.length ? ("Recent here: " + sugg.join(", ") + ". ") : "";

// One language-neutral line; the agent must print it verbatim (no translation,
// never Chinese) so the keys/commands survive.
const line =
  "[cc-usage] " + hint +
  "Set the Jira task for this session:  /task last (reuse most recent)  |  " +
  "/task <KEY>  |  /task <describe new work> (created in German)  |  /task none.";
const ctx =
  "At the very START of your first reply, show the developer this line VERBATIM " +
  "(do not translate it, never Chinese), then continue normally. Hint only, not a blocker:\n" +
  line;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));
' || true   # never block the session on hook failure
