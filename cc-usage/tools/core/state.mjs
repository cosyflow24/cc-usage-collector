// Attribution state layer over ~/.claude/cc-usage/. CRITICAL: the file paths and
// row schema here MUST stay byte-compatible with the collector bundle and the
// existing 5.9 MB tasks.jsonl history. Ported verbatim from the old bash `node -e`
// bodies (set-task.sh, session-prompt.sh, ask-task.sh, capture-task.sh).
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { STATE_DIR, readProviderEmail } from "./config.mjs";

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
export function mapCwd(cwd, sid, provider = "claude") {
  if (!sid) return;
  ensureStateDir();
  const cur = readCurrent();
  cur[provider === "codex" ? `codex:${cwd}` : cwd] = sid;
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

// Atomically claim a marker: create it exclusively (O_EXCL) and return true only
// for the caller that created it — false if it already exists OR the dir is
// unwritable. Serializes once-per-day work across concurrent sessions where a
// check-then-write would let two racers both proceed.
export function claimMarker(name) {
  try {
    mkdirSync(askedDir(), { recursive: true });
    writeFileSync(join(askedDir(), name), new Date().toISOString(), { flag: "wx" });
    return true;
  } catch { return false; }
}

// Resolve the session id $PWD-independently, exactly as set-task.sh did:
// CLAUDE_CODE_SESSION_ID (authoritative) -> exact cwd -> case-insensitive cwd ->
// the sole registered session.
export function resolveSession(cwd, cur = readCurrent()) {
  const codexSid = process.env.CODEX_THREAD_ID || "";
  if (codexSid) return { provider: "codex", sid: codexSid };
  const envSid = process.env.CLAUDE_CODE_SESSION_ID || "";
  if (envSid) return { provider: "claude", sid: envSid };
  if (cur[cwd]) return { provider: "claude", sid: cur[cwd] };
  if (cur[`codex:${cwd}`]) return { provider: "codex", sid: cur[`codex:${cwd}`] };
  const lc = cwd.toLowerCase();
  const ciHit = Object.keys(cur).find((k) => k.toLowerCase() === lc);
  if (ciHit) return { provider: "claude", sid: cur[ciHit] };
  const codexHit = Object.keys(cur).find((k) => k.toLowerCase() === `codex:${lc}`);
  if (codexHit) return { provider: "codex", sid: cur[codexHit] };
  const keys = Object.keys(cur);
  if (keys.length === 1) {
    const key = keys[0];
    return { provider: key.startsWith("codex:") ? "codex" : "claude", sid: cur[key] };
  }
  return { provider: "claude", sid: "" };
}

export function resolveSid(cwd, cur = readCurrent()) {
  return resolveSession(cwd, cur).sid;
}

// The cwd the SessionStart hook registered for this sid (reverse lookup), so the
// stored row + `last` matching stay consistent regardless of invocation dir.
export function registeredCwd(sid, cwd, cur = readCurrent(), provider = "claude") {
  for (const [k, v] of Object.entries(cur)) {
    if (v !== sid) continue;
    if (provider === "codex" && k.startsWith("codex:")) return k.slice("codex:".length);
    if (provider === "claude" && !k.startsWith("codex:")) return k;
  }
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
export function declaredRow(sid, provider = "claude") {
  try {
    const lines = readFileSync(tasksFile(), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        const rowProvider = r?.provider === "codex" ? "codex" : "claude";
        if (r && rowProvider === provider && r.sessionId === sid && r.jira) return r;
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  return null;
}
export function isDeclared(sid, provider = "claude") {
  return declaredRow(sid, provider) !== null;
}

// Sticky auto-bind candidate for a cwd: the most-recent key. Returns "" (→ ask
// instead) when there is no history, when the newest key is older than ttlDays
// (stale), or when the folder has churned through MORE THAN maxDistinct distinct
// keys recently (high-cardinality → clearly not 1:1 with an issue). Note: a
// folder with up to maxDistinct distinct keys still sticks to the newest — the
// heuristic assumes the newest is the active one, and a branch-encoded task
// switch is caught by drift detection; a switch on the same branch is only
// caught by the 24h stale nudge.
export function stickyKey(cwd, ttlDays = 14, maxDistinct = 3) {
  const recent = recentForCwd(cwd, maxDistinct + 1);
  if (!recent.length || recent.length > maxDistinct) return "";
  const top = recent[0];
  const ageDays = (Date.now() - new Date(top.ts || 0).getTime()) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays > ttlDays) return "";
  return top.key;
}

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

// Per-session account capture from the matching provider's authenticated
// identity. Never attribute a Codex session to the unrelated Claude login.
export function captureAccount(sid, cwd, provider = "claude") {
  if (!sid) return;
  try {
    const account = readProviderEmail(provider);
    if (account.includes("@")) {
      appendRow({
        schemaVersion: 1, provider, sessionId: sid, account, cwd,
        identitySource: provider === "codex" ? "codex-id-token" : "claude-oauth",
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
  const { provider, sid } = resolveSession(cwd, cur);
  if (!sid) {
    const e = new Error("no active Claude Code or Codex session found; start one, then retry");
    e.exitCode = 1; throw e;
  }
  const regCwd = registeredCwd(sid, cwd, cur, provider);
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
    writeMarker(`${provider}-${sid}`);
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
    schemaVersion: 1, sessionId: sid, provider, jira: key, cwd: regCwd,
    ts: new Date().toISOString(), src: "task-cmd",
  };
  if (epic) row.epic = epic;
  appendRow(row);
  return `cc-usage: ${provider} session attributed to ${key}${epic ? ` (epic ${epic})` : ""}`;
}
