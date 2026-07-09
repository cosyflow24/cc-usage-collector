#!/usr/bin/env bash
# Explicitly declare the Jira task (and optional epic) for the current session.
# Usage: set-task.sh <JIRA-KEY> [EPIC-KEY]
#   e.g. set-task.sh KI-758
#        set-task.sh KI-758 KI-700
# Run from your project dir, inside a Claude Code session.
set -euo pipefail

KEY="${1:-}"
EPIC="${2:-}"
if [[ -z "$KEY" ]]; then
  echo "usage: set-task.sh <JIRA-KEY> [EPIC-KEY]   e.g. set-task.sh KI-758 KI-700" >&2
  exit 1
fi

node -e '
const fs = require("fs"), path = require("path"), os = require("os");
let key = (process.argv[1] || "").toUpperCase();
let epic = (process.argv[2] || "").toUpperCase();
const cwd = process.argv[3];

const dir = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "cc-usage"
);
fs.mkdirSync(dir, { recursive: true });

let cur = {};
try { cur = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8")); } catch {}

// Resolve the session id $PWD-INDEPENDENTLY. CLAUDE_CODE_SESSION_ID is set by
// Claude Code in every session and is authoritative — so /task works from ANY
// directory and survives case-insensitive-FS $PWD differences. Fall back to exact
// cwd → case-insensitive cwd → the sole registered session.
const envSid = process.env.CLAUDE_CODE_SESSION_ID || "";
let sid = "";
if (envSid) sid = envSid;
else if (cur[cwd]) sid = cur[cwd];
else {
  const lc = cwd.toLowerCase();
  const ciHit = Object.keys(cur).find((k) => k.toLowerCase() === lc);
  if (ciHit) sid = cur[ciHit];
  else if (Object.keys(cur).length === 1) sid = Object.values(cur)[0];
}
if (!sid) { console.error("no active session found (start a Claude Code session, then retry)"); process.exit(1); }

// The REGISTERED project cwd (what the SessionStart hook recorded for this sid),
// reverse-looked-up by sid — used for the stored row + last matching so per-dir
// rollups stay consistent no matter which directory /task was invoked from.
let regCwd = cwd;
for (const [k, v] of Object.entries(cur)) { if (v === sid) { regCwd = k; break; } }
const regCwdLc = regCwd.toLowerCase();

// "last" → reuse the most recent task recorded for THIS session project dir.
if (key === "LAST") {
  try {
    const lines = fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const r = JSON.parse(lines[i]); if (r && String(r.cwd || "").toLowerCase() === regCwdLc && r.jira) { key = r.jira; if (r.epic && !epic) epic = r.epic; break; } } catch {}
    }
  } catch {}
  if (key === "LAST") { console.error("cc-usage: no previous task recorded for this dir"); process.exit(1); }
}

// "none" → mark this session as intentionally not tracked, stop the prompt.
if (key === "NONE") {
  const adir = path.join(dir, "asked");
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, sid), new Date().toISOString());
  console.log("cc-usage: session marked not tracked (no Jira task).");
  process.exit(0);
}

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
if (!KEY.test(key)) { console.error("not a Jira key: " + key); process.exit(1); }
if (epic && !KEY.test(epic)) { console.error("not a Jira key (epic): " + epic); process.exit(1); }

const row = { sessionId: sid, jira: key, cwd: regCwd, ts: new Date().toISOString(), src: "task-cmd" };
if (epic) row.epic = epic;
fs.appendFileSync(path.join(dir, "tasks.jsonl"), JSON.stringify(row) + "\n");
console.log("cc-usage: session attributed to " + key + (epic ? (" (epic " + epic + ")") : ""));
' "$KEY" "$EPIC" "$PWD"
