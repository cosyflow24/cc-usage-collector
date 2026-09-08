// Daily background self-update: installed users stay current with zero manual
// steps. Once per day a detached Node worker runs the host CLIs, so this works
// on Windows too — no /bin/sh, no shell-quoted command string.
//
// Both hosts are covered, because this plugin ships a Codex manifest
// (.codex-plugin/plugin.json) and the README documents a Codex install. A
// Claude-only worker left every Codex install pinned at its install-time
// version forever. Each host is updated independently: one host missing or
// failing never suppresses the other.
//
// `claude plugin update` / `codex plugin add` install the marketplace's
// declared VERSION (not arbitrary commits), so publishing stays gated by a
// version bump. The update applies on the next session. Opt out with
// CC_USAGE_NO_AUTOUPDATE=1.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { STATE_DIR } from "./config.mjs";
import { claimMarker } from "./state.mjs";

const PLUGIN_ID = "cc-usage@cc-usage";
const MARKETPLACE = "cc-usage";
const ccUsageMjs = join(dirname(dirname(fileURLToPath(import.meta.url))), "cc-usage.mjs");

// Per-host CLI verbs. Claude updates an installed plugin in place; Codex
// re-adds it, which is its documented upgrade path (see README "Updating").
//
// The marketplace refresh is `optional`: it must not abort the host. Verified on
// this machine — `codex plugin marketplace upgrade <name>` exits non-zero with
// "is not configured as a Git marketplace" whenever the marketplace was added
// from a local path, which is exactly how a dev checkout is registered. Aborting
// there meant the install step never ran and Codex silently never updated. A
// failed refresh only risks installing the already-cached version, so the
// install step is the one that decides success.
const UPDATE_PLANS = {
  claude: [
    { args: ["plugin", "marketplace", "update", MARKETPLACE], optional: true },
    { args: ["plugin", "update", PLUGIN_ID] },
  ],
  codex: [
    { args: ["plugin", "marketplace", "upgrade", MARKETPLACE], optional: true },
    { args: ["plugin", "add", PLUGIN_ID] },
  ],
};


export function findExecutable(name) {
  const override = process.env[`CC_USAGE_${name.toUpperCase()}_BIN`];
  if (override) return override;
  const probe = platform() === "win32"
    ? ["where", [name]]
    : ["/bin/sh", ["-c", `command -v ${name}`]];
  try {
    const found = execFileSync(probe[0], probe[1], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch { /* not on PATH */ }
  const candidates = platform() === "win32"
    ? [join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Programs", name, `${name}.exe`)]
    : [join(homedir(), ".local/bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  for (const p of candidates) { if (existsSync(p)) return p; }
  return "";
}

// Kept for compatibility with callers that only ever wanted the Claude binary.
export function findClaude() {
  return findExecutable("claude");
}

// Runs in the detached child: per host, the two CLI calls, sequentially,
// argv arrays only. Returns a per-host result map so tests can assert it.
// Hosts are updated one after another, so a hung CLI would starve every host
// behind it while the day marker is already spent. Cap each call, and kill with
// SIGKILL — the default SIGTERM can simply be ignored, which turns the cap into
// no cap at all. Residual limit: a killed CLI can still leave descendants
// holding the stdout pipe, so the cap bounds the common case, not every case.
const CALL_TIMEOUT_MS = 5 * 60_000;
// A host's install (refresh + install, each capped at CALL_TIMEOUT_MS) cannot
// outlive this. A claim younger than that may still be RUNNING.
const INSTALL_WINDOW_MS = 2 * CALL_TIMEOUT_MS;

// ---- per-host install lock -------------------------------------------------
// Two workers may be alive at once (two SessionStarts a minute apart, or one
// straddling midnight). The day claim alone is not enough: a worker that read
// the date at 23:59:59.999 and was paused before its wx claim would install
// next to a worker that claimed the new day. So the whole host update, from
// the day check to the completion claim, runs under a pid-bound lock. A worker
// that meets a lock held by a LIVE process WAITS for it (bounded) and then
// re-checks today's claim — it must not skip, because SessionStart has already
// spent today's single spawn.
const LOCK_POLL_MS = 2_000;
const LOCK_MAX_MS = 2 * INSTALL_WINDOW_MS; // never trust a lock older than this
const LOCK_MAX_ATTEMPTS = 2 * (INSTALL_WINDOW_MS / LOCK_POLL_MS); // retries that do not wait
const lockPath = (host) => join(STATE_DIR, `autoupdate-lock-${host}`);

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === "EPERM"; }
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function lockHolder(file, clock) {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    return { pid, age: clock().getTime() - statSync(file).mtimeMs, ino: statSync(file).ino };
  } catch { return null; }
}
const holderIsLive = (h, isAlive) => !!h && Number.isInteger(h.pid) && h.pid > 0 && h.age <= LOCK_MAX_MS && isAlive(h.pid);

// Remove a lock we judged stale WITHOUT deleting a lock someone else may have
// just created at the same path: move it aside first, compare inodes, and put
// it back if it is not the file we judged. A live lock that could not be put
// back stays aside and keeps counting as held (see lockedAside).
function breakStaleLock(file, expectedIno) {
  const aside = `${file}.stale-${process.pid}-${Date.now()}`;
  try { renameSync(file, aside); } catch { return; }
  let moved; try { moved = statSync(aside).ino; } catch { return; }
  if (moved === expectedIno) { try { unlinkSync(aside); } catch { /* gone */ } return; }
  try { renameSync(aside, file); } catch { /* a newer lock took the path; the aside file stays and counts as held */ }
}
function lockedAside(host, clock, isAlive) {
  let names = []; try { names = readdirSync(STATE_DIR); } catch { return false; }
  for (const name of names) {
    if (!name.startsWith(`autoupdate-lock-${host}.stale-`)) continue;
    const file = join(STATE_DIR, name);
    if (holderIsLive(lockHolder(file, clock), isAlive)) return true;
    try { unlinkSync(file); } catch { /* best effort */ }
  }
  return false;
}
function acquireHostLock(host, { clock, isAlive, wait, note }) {
  const file = lockPath(host);
  const deadline = clock().getTime() + INSTALL_WINDOW_MS;
  // Every path through this loop — a vanished lock, an unreadable lock, a
  // stale lock that will not rename — must pass the bounded exit below: a
  // lock that stays unreadable must not turn into a busy loop that starves
  // the OTHER host (invariant 3). The attempt cap bounds retries that do not
  // wait and therefore do not move the clock.
  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= LOCK_MAX_ATTEMPTS || clock().getTime() >= deadline) {
      note(`SKIPPED ${host}: could not acquire the install lock within one install window\n`); return null;
    }
    if (!lockedAside(host, clock, isAlive)) {
      try {
        writeFileSync(file, String(process.pid), { flag: "wx" });
        return () => { try { if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file); } catch { /* gone */ } };
      } catch (error) {
        if (!error || error.code !== "EEXIST") { note(`SKIPPED ${host}: could not take the install lock\n`); return null; }
      }
      const holder = lockHolder(file, clock);
      if (holder === null) continue; // vanished or unreadable: retry (bounded above)
      if (!holderIsLive(holder, isAlive)) { breakStaleLock(file, holder.ino); continue; }
    }
    wait(LOCK_POLL_MS);
  }
}

// One host: today's claim → optional refresh → wx day claim → install →
// completion-day claim. Returns true (done or already done), false (failed),
// null (could not claim). Caller holds the host lock.
function updateHost(host, binary, { clock, execute, note }) {
  const doneMark = (day) => join(STATE_DIR, `autoupdate-done-${host}-${day}`);
  if (existsSync(doneMark(clock().toISOString().slice(0, 10)))) return true;
  let day = null;
  for (const { args, optional } of UPDATE_PLANS[host]) {
    if (!optional && day === null) {
      // The day claim is taken immediately before the INSTALL command, after
      // the optional refresh: a refresh at 23:59 with the install at 00:01
      // belongs to the new day. Atomic (wx); the claim stays on failure too —
      // this plugin does not retry within a day.
      day = clock().toISOString().slice(0, 10);
      try { writeFileSync(doneMark(day), new Date().toISOString(), { flag: "wx" }); }
      catch (error) {
        if (error && error.code === "EEXIST") return true;
        note(`SKIPPED ${host}: could not persist the day claim: ${error.message}\n`); return null;
      }
    }
    try {
      const output = execute(binary, args);
      if (output) note(output);
    } catch (error) {
      note(`${optional ? "SKIPPED" : "FAILED"} ${host} ${args.join(" ")}: ${error.stderr || error.message}\n`);
      if (optional) continue; // a stale marketplace is still installable
      return false;
    }
  }
  // The install may have COMPLETED on a later day than it was claimed on
  // (claimed 23:59:59, finished 00:00:01). Claim the completion day as well.
  const doneDay = clock().toISOString().slice(0, 10);
  if (doneDay !== day) { try { writeFileSync(doneMark(doneDay), new Date().toISOString(), { flag: "wx" }); } catch { /* claimed or unwritable */ } }
  return true;
}

export function runUpdateWorker({
  executables = {},
  clock = () => new Date(),
  execute = (binary, args) => execFileSync(binary, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: CALL_TIMEOUT_MS, killSignal: "SIGKILL",
  }),
  // Test seams: liveness probe for a lock holder; synchronous wait between polls.
  isAlive = pidIsAlive,
  wait = sleepSync,
} = {}) {
  // The worker can be invoked directly (`cc-usage hook autoupdate-worker`), so
  // it must not depend on anything else having created the state dir first.
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* best effort */ }
  const log = join(STATE_DIR, "autoupdate.log");
  const note = (s) => { try { appendFileSync(log, s); } catch { /* best effort */ } };
  const results = {};
  note(`${new Date().toISOString()} worker start\n`);
  for (const host of Object.keys(UPDATE_PLANS)) {
    const binary = executables[host] ?? findExecutable(host);
    if (!binary) { results[host] = null; continue; } // host not installed here
    const release = acquireHostLock(host, { clock, isAlive, wait, note });
    if (!release) { results[host] = null; continue; }
    try { results[host] = updateHost(host, binary, { clock, execute, note }); }
    finally { release(); }
  }
  note(`${new Date().toISOString()} worker done\n`);
  return results;
}

export function selfUpdate() {
  if (process.env.CC_USAGE_NO_AUTOUPDATE) return;
  // Atomic O_EXCL claim: only the racer that creates today's marker proceeds,
  // so concurrent session starts can never spawn two updates at once. A failed
  // claim (already done today, or unwritable state dir) simply skips.
  if (!claimMarker(`autoupdate-${new Date().toISOString().slice(0, 10)}`)) return;
  try {
    const child = spawn(process.execPath, [ccUsageMjs, "hook", "autoupdate-worker"], {
      detached: true, stdio: "ignore",
    });
    // spawn() reports failures like EAGAIN asynchronously via an 'error' event.
    // With no listener Node raises it as an uncaught exception, which the
    // surrounding try/catch cannot see — it would escape the SessionStart hook.
    child.on("error", () => { /* best effort: the next session retries */ });
    child.unref();
  } catch { /* best effort */ }
}
