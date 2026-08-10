// Attribution state layer over ~/.claude/cc-usage/. CRITICAL: the file paths and
// row schema here MUST stay byte-compatible with the collector bundle and the
// existing 5.9 MB tasks.jsonl history. Ported verbatim from the old bash `node -e`
// bodies (set-task.sh, session-prompt.sh, ask-task.sh, capture-task.sh).
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { STATE_DIR, CLAUDE_JSON } from "./config.mjs";

// Pull the first Jira key out of any input (bare key, browse URL, or a sentence
// containing one), so users can paste a link without hand-trimming it to the key.
const KEY_EXTRACT = /[A-Z][A-Z0-9]+-\d+/;
function extractKey(raw) {
  const m = KEY_EXTRACT.exec((raw || "").toUpperCase());
  return m ? m[0] : "";
}

export function ensureStateDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }
}
const tasksFile = () => join(STATE_DIR, "tasks.jsonl");
const currentFile = () => join(STATE_DIR, "current.json");
const askedDir = () => join(STATE_DIR, "asked");

export function readCurrent() {
  try { return JSON.parse(readFileSync(currentFile(), "utf8")); } catch { return {}; }
}

// Keep cwd -> live sessionId fresh so `task` can resolve THIS session later.
export function mapCwd(cwd, sid) {
  if (!sid) return;
  ensureStateDir();
  const cur = readCurrent();
  cur[cwd] = sid;
  try { writeFileSync(currentFile(), JSON.stringify(cur)); } catch { /* ignore */ }
}

export function appendRow(row) {
  ensureStateDir();
  appendFileSync(tasksFile(), `${JSON.stringify(row)}\n`);
}

export function writeMarker(name) {
  try {
    mkdirSync(askedDir(), { recursive: true });
    writeFileSync(join(askedDir(), name), new Date().toISOString());
  } catch { /* ignore */ }
}
export function hasMarker(name) {
  try { return existsSync(join(askedDir(), name)); } catch { return false; }
}

// Resolve the session id $PWD-independently, exactly as set-task.sh did:
// CLAUDE_CODE_SESSION_ID (authoritative) -> exact cwd -> case-insensitive cwd ->
// the sole registered session.
export function resolveSid(cwd, cur = readCurrent()) {
  const envSid = process.env.CLAUDE_CODE_SESSION_ID || "";
  if (envSid) return envSid;
  if (cur[cwd]) return cur[cwd];
  const lc = cwd.toLowerCase();
  const ciHit = Object.keys(cur).find((k) => k.toLowerCase() === lc);
  if (ciHit) return cur[ciHit];
  const keys = Object.keys(cur);
  return keys.length === 1 ? cur[keys[0]] : "";
}

// The cwd the SessionStart hook registered for this sid (reverse lookup), so the
// stored row + `last` matching stay consistent regardless of invocation dir.
export function registeredCwd(sid, cwd, cur = readCurrent()) {
  for (const [k, v] of Object.entries(cur)) if (v === sid) return k;
  return cwd;
}

export function branchKey(cwd) {
  try {
    const b = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).toUpperCase();
    const m = /([A-Z][A-Z0-9]+-\d+)/.exec(b);
    return m ? m[1] : null;
  } catch { return null; }
}

// Latest task row (with a jira key) for this session — declared attribution.
export function declaredRow(sid) {
  try {
    const lines = readFileSync(tasksFile(), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        if (r && r.sessionId === sid && r.jira) return r;
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  return null;
}
export function isDeclared(sid) { return declaredRow(sid) !== null; }

// Recent distinct keys for a cwd (case-insensitive), newest first.
export function recentForCwd(cwd, limit = 3) {
  const out = [];
  const lc = cwd.toLowerCase();
  try {
    const lines = readFileSync(tasksFile(), "utf8").split("\n").filter(Boolean);
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        if (!r || !r.jira || String(r.cwd || "").toLowerCase() !== lc || seen.has(r.jira)) continue;
        seen.add(r.jira);
        out.push({ key: r.jira, ts: r.ts });
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  return out;
}

// Per-session account/plan capture from ~/.claude.json — so each session is
// credited to the plan actually in use then. Appends a `hook-acct` row.
export function captureAccount(sid, cwd) {
  if (!sid) return;
  try {
    const oa = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")).oauthAccount || {};
    const account = String(oa.emailAddress || "").toLowerCase();
    const plan = String(oa.organizationType || "");
    if (account.includes("@")) {
      appendRow({
        schemaVersion: 1, sessionId: sid, account, plan, cwd,
        ts: new Date().toISOString(), src: "hook-acct",
      });
    }
  } catch { /* ignore */ }
}

// Explicit attribution — the `task` subcommand. Returns a confirmation string or
// throws Error with .exitCode. Semantics identical to set-task.sh.
export function setTask(rawKey, rawEpic, cwd) {
  let key = (rawKey || "").toUpperCase();
  let epic = (rawEpic || "").toUpperCase();
  ensureStateDir();
  const cur = readCurrent();
  const sid = resolveSid(cwd, cur);
  if (!sid) {
    const e = new Error("no active session found (start a Claude Code session, then retry)");
    e.exitCode = 1; throw e;
  }
  const regCwd = registeredCwd(sid, cwd, cur);
  const regCwdLc = regCwd.toLowerCase();

  if (key === "LAST") {
    try {
      const lines = readFileSync(tasksFile(), "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const r = JSON.parse(lines[i]);
          if (r && String(r.cwd || "").toLowerCase() === regCwdLc && r.jira) {
            key = r.jira; if (r.epic && !epic) epic = r.epic; break;
          }
        } catch { /* skip */ }
      }
    } catch { /* no file */ }
    if (key === "LAST") {
      const e = new Error("cc-usage: no previous task recorded for this dir");
      e.exitCode = 1; throw e;
    }
  }

  if (key === "NONE") {
    writeMarker(sid);
    return "cc-usage: session marked not tracked (no Jira task).";
  }

  const extractedKey = extractKey(key);
  if (!extractedKey) { const e = new Error(`no Jira key found in: ${rawKey}`); e.exitCode = 1; throw e; }
  key = extractedKey;
  if (epic) {
    const extractedEpic = extractKey(epic);
    if (!extractedEpic) { const e = new Error(`no Jira key found in (epic): ${rawEpic}`); e.exitCode = 1; throw e; }
    epic = extractedEpic;
  }

  const row = {
    schemaVersion: 1, sessionId: sid, jira: key, cwd: regCwd,
    ts: new Date().toISOString(), src: "task-cmd",
  };
  if (epic) row.epic = epic;
  appendRow(row);
  return `cc-usage: session attributed to ${key}${epic ? ` (epic ${epic})` : ""}`;
}
