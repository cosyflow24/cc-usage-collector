// Semantic task candidates: a local, read-only cache of the user's OPEN Jira
// issues, plus a purely local ranking over it.
//
// Why this exists: attribution used to offer the host model only the keys
// already bound in this cwd plus whatever the user literally typed. A ticket
// that was never bound here could therefore never be recommended, no matter how
// obviously the request matched its title. The cache gives the host REAL titles
// to reason over; the ranking decides which eight are worth showing.
//
// Boundaries this file must keep:
//   * Read-only. The gateway is only ever asked to `search`; nothing here can
//     create, edit, comment on, or transition an issue.
//   * Prompts never leave the machine. Ranking is string matching in this
//     process — no model call, no upload, no prompt in the cache file.
//   * Never blocking. The refresh runs in a DETACHED child; a session start
//     never waits on Jira, and a broken gateway degrades to "no candidates".
//   * Candidates are suggestions. Nothing here writes an attribution row.
//
// Opt out entirely with CC_USAGE_NO_ISSUE_CACHE=1.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { STATE_DIR } from "./config.mjs";
import { claimMarker } from "./state.mjs";

export const ISSUES_FILE = join(STATE_DIR, "open-issues.json");
export const TTL_MS = 6 * 3600_000;
export const MAX_ISSUES = 50;
// Assignee OR reporter: a ticket someone else works on but that you raised is
// still plausibly what you are sitting in front of. statusCategory (not status)
// so this survives a workflow with custom done-state names.
export const OPEN_ISSUES_JQL =
  "(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != Done ORDER BY updated DESC";

const KEY_RE = /^[A-Z][A-Z0-9]+-[0-9]+$/;
const CALL_TIMEOUT_MS = 60_000;
const ccUsageMjs = join(dirname(dirname(fileURLToPath(import.meta.url))), "cc-usage.mjs");

// ------------------------------------------------------------------ the cache
/** The cached open issues, or null when absent/unreadable/corrupt. */
export function readOpenIssues() {
  try {
    const parsed = JSON.parse(readFileSync(ISSUES_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : "",
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch { return null; }
}

/** A cache younger than the TTL. A missing or undated cache is never fresh. */
export function isFresh(cache, now = Date.now(), ttl = TTL_MS) {
  const at = Date.parse(cache?.fetchedAt || "");
  if (!Number.isFinite(at)) return false;
  return now - at < ttl;
}

// Written tmp+rename so a session start can never read a half-written cache,
// and 0600 because issue titles are internal information.
function writeCache(issues) {
  const tmp = `${ISSUES_FILE}.tmp-${process.pid}-${Date.now()}`;
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* best effort */ }
  writeFileSync(tmp, `${JSON.stringify({ fetchedAt: new Date().toISOString(), issues })}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, ISSUES_FILE);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

// ---------------------------------------------------------------- the gateway
// Mirrors findExecutable() in autoupdate.mjs, with one deliberate difference:
// an EMPTY override means "no gateway on this machine", which is what the tests
// need in order to prove that nothing is ever spawned.
export function findNnbJira() {
  const override = process.env.CC_USAGE_NNB_JIRA_BIN;
  if (override !== undefined && override !== "") return override;
  if (override === "") return null;
  const name = "nnb-jira";
  const probe = platform() === "win32" ? ["where", [name]] : ["/bin/sh", ["-c", `command -v ${name}`]];
  try {
    const found = execFileSync(probe[0], probe[1], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch { /* not on PATH */ }
  const candidates = platform() === "win32"
    ? [join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", name, `${name}.exe`)]
    : [join(homedir(), ".local/bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  for (const p of candidates) { if (existsSync(p)) return p; }
  return null;
}

/**
 * Ask the read-only gateway for the open issues and replace the cache.
 * Returns the number of issues cached, or null on ANY failure — in which case
 * the previous cache is left exactly as it was, because a stale list of real
 * tickets is far more useful than no list at all.
 */
export function refreshOpenIssues({ bin = findNnbJira(), spawn: spawnFn = spawnSync } = {}) {
  if (!bin) return null;
  try {
    const result = spawnFn(bin, [
      "search", OPEN_ISSUES_JQL,
      "--fields", "key,summary,status,updated",
      "--max", String(MAX_ISSUES),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // SIGKILL, not the default SIGTERM: a CLI that ignores SIGTERM turns the
      // cap into no cap at all, and this runs unattended in a detached child.
      timeout: CALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (!result || result.error || result.status !== 0) return null;
    const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout || "");
    // The gateway prints a WARNING banner before the payload, so the JSON does
    // not start at byte 0.
    const start = stdout.indexOf("{");
    if (start < 0) return null;
    const parsed = JSON.parse(stdout.slice(start));
    const issues = [];
    for (const raw of Array.isArray(parsed?.issues) ? parsed.issues : []) {
      const key = String(raw?.key || "").toUpperCase();
      if (!KEY_RE.test(key)) continue; // a key is interpolated into prose later
      issues.push({
        key,
        summary: String(raw?.fields?.summary || ""),
        status: String(raw?.fields?.status?.name || ""),
        updated: String(raw?.fields?.updated || ""),
      });
      if (issues.length >= MAX_ISSUES) break;
    }
    writeCache(issues);
    return issues.length;
  } catch { return null; }
}

/**
 * Fire-and-forget refresh from SessionStart. Never blocks: the work happens in
 * a DETACHED child that outlives this hook. Throttled to one attempt per hour
 * by an atomic marker claim, so concurrent session starts cannot pile up.
 * Returns whether a refresh was actually scheduled.
 */
export function scheduleRefresh({ spawn: spawnFn = spawn } = {}) {
  if (process.env.CC_USAGE_NO_ISSUE_CACHE) return false;
  if (!findNnbJira()) return false;
  if (isFresh(readOpenIssues())) return false;
  if (!claimMarker(`issues-refresh-${new Date().toISOString().slice(0, 13)}`)) return false;
  try {
    const child = spawnFn(process.execPath, [ccUsageMjs, "hook", "issues-refresh"], {
      detached: true, stdio: "ignore",
    });
    // spawn() reports EAGAIN and friends asynchronously; with no listener Node
    // rethrows it as an uncaught exception that the try/catch cannot see.
    child?.on?.("error", () => { /* best effort: the next hour retries */ });
    child?.unref?.();
    return true;
  } catch { return false; }
}

// ----------------------------------------------------------------- the ranking
// Deliberately tiny: these are the words that carry no signal yet appear in
// nearly every summary, so a match on them would drown the real ones.
const STOPWORDS = new Set([
  "der", "die", "das", "und", "mit", "für", "the", "and", "for", "with", "von", "zu", "im", "in", "auf",
]);

function tokenize(text) {
  const out = new Set();
  for (const token of String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 3 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

// Score bands, widest gaps first. They never overlap, so the ordering
// history > branch > title match > recency is a property of the numbers, not of
// how the callers happen to sort.
const SCORE_HISTORY = 1000; // minus the position, so the newest binding leads
const SCORE_BRANCH = 500;
const SCORE_OVERLAP = 100; // plus 10 per matched word, capped below SCORE_BRANCH
const SCORE_NONE = 0;

const updatedMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Rank open issues as attribution candidates. Pure: no I/O, no clock, no
 * network. `recent` is newest-first cwd history, `issues` the cached open
 * issues. Keys present only in history or on the branch still appear, with an
 * empty summary — losing them would be a regression against today's behaviour.
 */
export function rankCandidates({
  cwd = "", prompt = "", branchKey = null, recent = [], issues = [], limit = 8,
} = {}) {
  const meta = new Map();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const key = String(issue?.key || "").toUpperCase();
    if (!KEY_RE.test(key) || meta.has(key)) continue;
    meta.set(key, {
      key,
      summary: String(issue?.summary || ""),
      status: String(issue?.status || ""),
      updated: String(issue?.updated || ""),
    });
  }

  const scored = new Map();
  const bid = (rawKey, score, reason) => {
    const key = String(rawKey || "").toUpperCase();
    if (!KEY_RE.test(key)) return;
    const prev = scored.get(key);
    if (prev && prev.score >= score) return;
    scored.set(key, { score, reason });
  };

  const history = Array.isArray(recent) ? recent : [];
  history.forEach((key, index) => bid(key, SCORE_HISTORY - index, "cwd history"));
  bid(branchKey, SCORE_BRANCH, "branch");

  const wanted = tokenize(`${prompt} ${basename(String(cwd || ""))}`);
  for (const issue of meta.values()) {
    let overlap = 0;
    for (const token of tokenize(issue.summary)) { if (wanted.has(token)) overlap += 1; }
    if (overlap > 0) bid(issue.key, SCORE_OVERLAP + Math.min(overlap, 20) * 10, "prompt match");
    else bid(issue.key, SCORE_NONE, "recently updated");
  }

  return [...scored.entries()]
    .map(([key, { score, reason }]) => {
      const known = meta.get(key);
      return {
        key,
        summary: known?.summary || "",
        status: known?.status || "",
        updated: known?.updated || "",
        score,
        reason,
      };
    })
    .sort((a, b) => b.score - a.score
      || updatedMs(b.updated) - updatedMs(a.updated)
      || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit))
    .map(({ key, summary, status, reason }) => ({ key, summary, status, reason }));
}
