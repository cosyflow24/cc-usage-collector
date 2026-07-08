#!/usr/bin/env bash
# UserPromptSubmit hook for cc-usage — reliably attribute a session to a Jira task.
#
# Why block (not just additionalContext): injected context (SessionStart OR
# UserPromptSubmit additionalContext) is treated as BACKGROUND and the model does
# not reliably ask. A `decision: "block"` on UserPromptSubmit deterministically
# interrupts the prompt and shows the reason to the developer. Safety:
#   - only fires inside the monitored project (CC_USAGE_PROJECT);
#   - slash commands (incl. /task) and empty prompts pass through → no lockout;
#   - once a task is recorded (or /task none), it never blocks again.
#
# Language: the block text is FIXED English + German. We never let the agent
# generate the question (that could come out in the wrong language) and never
# emit Chinese. Reads the UserPromptSubmit payload on stdin.
set -euo pipefail

CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# Load CC_USAGE_PROJECT (pilot scope) if the user env file is present.
if [[ -f "$CC/cc-usage/env" ]]; then
  set -a  # export sourced vars so the node child sees CC_USAGE_PROJECT
  # shellcheck disable=SC1091
  . "$CC/cc-usage/env" 2>/dev/null || true
  set +a
fi

node -e '
const fs = require("fs"), path = require("path"), os = require("os");
let input = ""; try { input = fs.readFileSync(0, "utf8"); } catch {}
let p = {}; try { p = JSON.parse(input); } catch {}
const sid = p.session_id || p.sessionId || "";
const cwd = p.cwd || process.cwd();
const prompt = (p.prompt || p.user_prompt || "").trim();
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "cc-usage");

// Pilot scope: only monitor the configured project. Elsewhere, never interfere.
const proj = process.env.CC_USAGE_PROJECT;
if (proj && path.basename(cwd) !== proj) process.exit(0);

// Keep cwd -> live sessionId fresh so /task (set-task.sh) records THIS session,
// not a stale one. (SessionStart mapping can be stale with multiple sessions.)
if (sid) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "current.json");
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    cur[cwd] = sid;
    fs.writeFileSync(f, JSON.stringify(cur));
  } catch {}
}

// Escape hatches: slash commands (incl. /task) and empty prompts always pass.
if (!prompt || prompt.startsWith("/")) process.exit(0);

if (!sid) process.exit(0); // no session id -> cannot track; never block

const askedDir = path.join(dir, "asked");
const hasSkip = () => { try { return fs.existsSync(path.join(askedDir, sid)); } catch { return false; } };
function declaredKey() {
  try {
    const lines = fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const r = JSON.parse(lines[i]); if (r && r.sessionId === sid && r.jira) return r.jira; } catch {}
    }
  } catch {}
  return null;
}
function branchKey() {
  try {
    const b = require("child_process")
      .execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().toUpperCase();
    const m = /([A-Z][A-Z0-9]+-\d+)/.exec(b);
    return m ? m[1] : null;
  } catch { return null; }
}
const writeMarker = (name) => {
  try { fs.mkdirSync(askedDir, { recursive: true }); fs.writeFileSync(path.join(askedDir, name), new Date().toISOString()); } catch {}
};

if (hasSkip()) process.exit(0); // /task none -> stay quiet

const declared = declaredKey();
if (declared) {
  // Drift: declared key vs the Jira key in the current git branch. Nudge once per drift.
  const bk = branchKey();
  if (bk && bk !== declared) {
    const mark = `drift-${sid}-${bk}`;
    if (!hasSkipMark(mark)) {
      writeMarker(mark);
      const reason =
        `[cc-usage] Task drift? This session is recorded as ${declared}, but the git branch points to ${bk}. ` +
        `Run  /task ${bk}  to switch, or ignore to keep ${declared}.\n` +
        `[DE] Task gewechselt? Diese Session ist als ${declared} erfasst, der Branch zeigt aber auf ${bk}. ` +
        `Fuehre  /task ${bk}  zum Wechseln aus, oder ignoriere es.`;
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
    }
  }
  process.exit(0);
}

// No task yet → ask once. Mark BEFORE blocking so we interrupt at most once.
writeMarker(sid);

// Reuse hints: the last few tasks recorded for THIS dir + the git branch key,
// so the developer never has to remember an old key. Data only (keys/times);
// the surrounding text stays fixed EN+DE.
function recentForCwd() {
  const out = [];
  try {
    const lines = fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").split("\n").filter(Boolean);
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0 && out.length < 3; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (!r || r.cwd !== cwd || !r.jira || seen.has(r.jira)) continue;
        seen.add(r.jira); out.push({ key: r.jira, ts: r.ts });
      } catch {}
    }
  } catch {}
  return out;
}
function ago(ts) {
  try {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 60) return m + "m";
    const h = Math.round(m / 60);
    return h < 48 ? h + "h" : Math.round(h / 24) + "d";
  } catch { return "?"; }
}
const recent = recentForCwd();
const bk = branchKey();
const sugg = recent.map((r) => r.key + " (" + ago(r.ts) + ")");
if (bk && !recent.some((r) => r.key === bk)) sugg.push(bk + " (branch)");
const suggestLine = sugg.length
  ? ("\n[cc-usage] Recent in this folder: " + sugg.join(", ") +
     " — reuse the most recent with  /task last  (or  /task <KEY>)." +
     "\n[DE] Zuletzt in diesem Ordner: " + sugg.join(", ") +
     " — den letzten uebernehmen mit  /task last  (oder  /task <KEY>).")
  : "";

const reason =
  "[cc-usage] Which Jira issue is this session for? " +
  "Run  /task <KEY>  (e.g. /task KI-758) for an existing issue, " +
  "/task <describe new work>  to create one (written in German), or  /task none  to skip. " +
  "You will only be asked once per session.\n" +
  "[DE] Zu welchem Jira-Vorgang gehoert diese Session? " +
  "Fuehre  /task <KEY>  aus (z. B. /task KI-758), " +
  "/task <neue Arbeit beschreiben>  zum Anlegen (auf Deutsch) oder  /task none  zum Ueberspringen." +
  suggestLine;
process.stdout.write(JSON.stringify({ decision: "block", reason }));

function hasSkipMark(name) { try { return fs.existsSync(path.join(askedDir, name)); } catch { return false; } }
' || true
