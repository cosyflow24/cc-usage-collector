// The three Claude Code hook handlers. Since 2026-08-12 every interactive
// nudge (first attribution, drift, stale, backstop) uses ONE interaction
// contract: non-blocking additionalContext instructing the agent to call
// AskUserQuestion with options that map to exactly one deterministic CLI
// call. No blocking bilingual text prompts anymore; headless runs stay
// silent; slash commands remain the manual fallback.
//
// Each handler returns the hook-output object to print (or null = pass-through).
// Callers must always exit 0; diagnostics go to hook.err, never stdout.
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR, resolverPath, readConfig } from "./config.mjs";
import {
  mapCwd, appendRow, captureAccount, branchKey, declaredRow, isDeclared,
  recentForCwd, stickyKey, writeMarker, hasMarker,
} from "./state.mjs";
import { reconcile } from "./launcher.mjs";
import { selfUpdate } from "./autoupdate.mjs";

const toolDir = dirname(dirname(fileURLToPath(import.meta.url))); // tools/
const ccUsageMjs = join(toolDir, "cc-usage.mjs");

function ago(ts) {
  try {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
  } catch { return "?"; }
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Headless / non-interactive runs (CI, `claude -p`, batch jobs) must never emit
// an AskUserQuestion instruction or a blocking prompt — there is no human to
// answer and a block can wedge the run. Such sessions still get silent
// autoCapture + sticky binding, which is the correct behavior. Set
// CC_USAGE_HEADLESS=1 to force this off explicitly.
function nonInteractive() {
  return !!(process.env.CI || process.env.CC_USAGE_HEADLESS
    || process.env.CLAUDE_CODE_NONINTERACTIVE);
}

// ---- SessionStart: map cwd->sid, auto-capture, maintenance, task hint --------
export function sessionStart(payload) {
  const sid = payload.session_id || payload.sessionId || "";
  const cwd = payload.cwd || process.cwd();

  if (sid) mapCwd(cwd, sid);
  autoCapture(sid, cwd);
  try { captureAccount(sid, cwd); } catch { /* ignore */ }
  maintenance();

  if (!sid || isDeclared(sid)) return null; // resumed/attributed → no nag

  // Tier 1 — sticky: this folder was recently and unambiguously bound to one
  // issue, so continue it silently. No prompt, no typing. Drift/stale nudges in
  // promptSubmit still catch a task switch.
  const sk = stickyKey(cwd);
  if (sk) {
    try {
      appendRow({
        schemaVersion: 1, sessionId: sid, jira: sk, cwd,
        ts: new Date().toISOString(), src: "sticky",
      });
    } catch { /* ignore */ }
    return null;
  }

  // Nothing to auto-bind. In headless runs, stay silent (no human to answer).
  if (nonInteractive()) return null;

  // Tier 2 — clickable: ask the assistant to attribute via AskUserQuestion so
  // the user picks a key instead of typing a command.
  const recent = recentForCwd(cwd).map((r) => r.key);
  const bk = branchKey(cwd);
  const keys = recent.slice();
  if (bk && !keys.includes(bk)) keys.push(bk);
  const optionsList = keys.length ? keys.join(", ") : "(none on record)";
  const launcher = `node ${JSON.stringify(resolverPath)} task`;
  const additionalContext = "[cc-usage] This Claude Code session is not yet attributed to a Jira "
    + "issue. At the START of your first reply, call the AskUserQuestion tool (header \"cc-usage\") "
    + "asking which Jira issue this session is for, in the user's language. Offer these options as "
    + `clickable choices: the recent/branch keys [${optionsList}], plus "None — don't track". `
    + "The built-in \"Other\" choice lets the user type a different key. When the user answers, record "
    + `it by running exactly one Bash command: for a KEY matching ^[A-Z][A-Z0-9]+-[0-9]+$ run \`${launcher} <KEY>\`; `
    + `for \"None\" run \`${launcher} none\`. Do not pass free text or a URL to the shell — extract the KEY first. `
    + "This only records attribution metadata; it never touches Jira. If the user ignores the question, "
    + "do not block their work — just continue.";
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}

function autoCapture(sid, cwd) {
  const KEY = /[A-Z][A-Z0-9]+-\d+/;
  let jira = (process.env.CC_JIRA || "").toUpperCase().match(KEY)?.[0] || "";
  if (!jira) {
    try { jira = readFileSync(join(cwd, ".ccjira"), "utf8").toUpperCase().match(KEY)?.[0] || ""; } catch { /* no file */ }
  }
  if (!jira) jira = branchKey(cwd) || "";
  if (sid && jira) {
    const row = { schemaVersion: 1, sessionId: sid, jira, cwd, ts: new Date().toISOString(), src: "hook" };
    const epic = (process.env.CC_EPIC || "").toUpperCase().match(KEY)?.[0] || "";
    if (epic) row.epic = epic;
    try { appendRow(row); } catch { /* ignore */ }
  }
}

// ---- UserPromptSubmit: gate first prompt, drift/stale nudges ----------------
export function promptSubmit(payload) {
  const sid = payload.session_id || payload.sessionId || "";
  const cwd = payload.cwd || process.cwd();
  const prompt = (payload.prompt || payload.user_prompt || "").trim();

  // Pilot scope: config.project (env CC_USAGE_PROJECT still overrides).
  const proj = process.env.CC_USAGE_PROJECT || readConfig().project;
  if (proj && basename(cwd) !== proj) return null;

  if (sid) mapCwd(cwd, sid);
  if (!prompt || prompt.startsWith("/")) return null; // slash + empty pass
  if (!sid) return null;
  if (hasMarker(sid)) return null; // /cc-usage:task none → quiet

  const declared = declaredRow(sid);
  if (declared) {
    if (nonInteractive()) return null; // headless: never nudge
    const launcher = `node ${JSON.stringify(resolverPath)} task`;
    const bk = branchKey(cwd);
    if (bk && bk !== declared.jira) {
      const mark = `drift-${sid}-${bk}`;
      if (!hasMarker(mark)) {
        writeMarker(mark);
        // Same interaction contract as SessionStart: the agent asks via
        // AskUserQuestion; each option maps to exactly one deterministic CLI
        // call. Non-blocking — the user's actual prompt still goes through.
        const additionalContext = `[cc-usage] Task drift: this session is recorded as ${declared.jira}, `
          + `but the git branch points to ${bk}. At the START of your reply, call the AskUserQuestion tool `
          + `(header "cc-usage") asking, in the user's language, whether to switch. Options: `
          + `"Switch to ${bk}" (then run \`${launcher} ${bk}\`), "Keep ${declared.jira}" (run nothing), `
          + `"Stop tracking" (run \`${launcher} none\`). Ask once for this branch; if ignored, continue without blocking.`;
        return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
      }
      return null;
    }
    const ageH = (Date.now() - new Date(declared.ts || 0).getTime()) / 3600000;
    if (Number.isFinite(ageH) && ageH > 24) {
      const mark = `stale-${sid}-${new Date().toISOString().slice(0, 10)}`;
      if (!hasMarker(mark)) {
        writeMarker(mark);
        const ageD = Math.round((ageH / 24) * 10) / 10;
        const additionalContext = `[cc-usage] Stale attribution: this session was bound to ${declared.jira} `
          + `${ageD} day(s) ago. At the START of your reply, call the AskUserQuestion tool (header "cc-usage") `
          + `asking, in the user's language, whether that is still the right issue. Options: `
          + `"Keep ${declared.jira}" (run nothing), "Switch issue" (let the built-in Other collect a KEY matching `
          + `^[A-Z][A-Z0-9]+-[0-9]+$, then run \`${launcher} <KEY>\`), "Stop tracking" (run \`${launcher} none\`). `
          + `Asked at most once per day; if ignored, continue without blocking.`;
        return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
      }
    }
    return null;
  }

  // No task yet. SessionStart already offered a clickable AskUserQuestion; this
  // block is only the deterministic backstop for when that was ignored. Headless
  // runs never block. Give a short grace (a couple of prompts) before nagging,
  // then interrupt at most once per session.
  if (nonInteractive()) return null;
  const GRACE = 2;
  let seen = 0;
  while (seen < GRACE && hasMarker(`pc${seen + 1}-${sid}`)) seen += 1;
  if (seen < GRACE) { writeMarker(`pc${seen + 1}-${sid}`); return null; }
  if (hasMarker(sid)) return null; // already nagged once
  writeMarker(sid);
  const recent = recentForCwd(cwd);
  const bk = branchKey(cwd);
  const sugg = recent.map((r) => `${r.key} (${ago(r.ts)})`);
  if (bk && !recent.some((r) => r.key === bk)) sugg.push(`${bk} (branch)`);
  const optionsList = sugg.length ? sugg.join(", ") : "(none on record)";
  const launcher = `node ${JSON.stringify(resolverPath)} task`;
  // Backstop mirrors the SessionStart interaction: clickable AskUserQuestion,
  // deterministic CLI mapping, never a hard block of the user's prompt.
  const additionalContext = "[cc-usage] This session is still not attributed to a Jira issue "
    + "(the earlier question was not answered). At the START of your reply, call the AskUserQuestion "
    + "tool (header \"cc-usage\") asking which Jira issue this session is for, in the user's language. "
    + `Offer these clickable options: the recent/branch keys [${optionsList}], plus "None — don't track". `
    + "The built-in \"Other\" choice lets the user type a different key. When the user answers, run exactly "
    + `one Bash command: for a KEY matching ^[A-Z][A-Z0-9]+-[0-9]+$ run \`${launcher} <KEY>\`; for "None" run `
    + `\`${launcher} none\`. Do not pass free text or a URL to the shell — extract the KEY first. `
    + "This is asked at most once per session; if ignored, continue without blocking.";
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}

// ---- maintenance: replaces bootstrap.sh (keeps the 09:30 LaunchAgent alive) --
const COMPAT_MARKER = "Regenerated by cc-usage";

function maintenance() {
  try {
    // reconcile() FIRST: it writes the stable resolver copy that the sync.sh
    // compat shim below points at.
    reconcile();
    const bin = join(STATE_DIR, "bin");
    mkdirSync(bin, { recursive: true });
    regenCompatSync(bin);
    pruneOldSymlinks(bin);
    rmSync(join(STATE_DIR, "plugin-dist.env"), { force: true });
    selfUpdate();
  } catch { /* never block a hook */ }
}

function regenCompatSync(bin) {
  const target = join(bin, "sync.sh");
  if (existsSync(target) && !ownsCompat(target)) return; // foreign → leave
  // Never point the unattended LaunchAgent at a resolver that isn't there: if
  // reconcile() bailed (racing an update, unwritable state dir), keep whatever
  // shim already works rather than replacing it with a broken one.
  if (!existsSync(resolverPath)) return;
  // Point at the stable resolver, never a versioned plugin path: the LaunchAgent
  // fires unattended, and a path collected by a plugin cache GC would break the
  // daily sync silently until someone started a session.
  const body = "#!/bin/bash\n"
    + `# ${COMPAT_MARKER} (plugin). Compat entry for the com.nnb24.cc-usage-sync LaunchAgent.\n`
    + `exec node ${JSON.stringify(resolverPath)} sync --days "\${1:-1}"\n`;
  // Atomic + idempotent: rewriting unconditionally left an unlink/write window
  // in which the 09:30 LaunchAgent could find no file and skip a day's upload.
  let current = null;
  try { current = readFileSync(target, "utf8"); } catch { /* absent */ }
  if (current === body) return;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { mode: 0o755 });
  renameSync(tmp, target);
}

function ownsCompat(path) {
  try {
    if (isSymlink(path)) return /(?:^|[\\/])cc-usage(?:[\\/].*)?[\\/]scripts[\\/]sync\.sh$/.test(readlinkSync(path));
    return readFileSync(path, "utf8").includes(COMPAT_MARKER);
  } catch { return false; }
}

// Remove ONLY the known pre-plugin script symlinks, and only when they still
// resolve into a cc-usage scripts/ dir. Never touches anything else in bin/.
const OLD_SCRIPTS = [
  "ask-task.sh", "bootstrap.sh", "burn.sh", "capture-task.sh",
  "doctor.sh", "session-prompt.sh", "set-task.sh",
];
function pruneOldSymlinks(bin) {
  for (const name of OLD_SCRIPTS) {
    const p = join(bin, name);
    try {
      if (isSymlink(p) && /(?:^|[\\/])cc-usage(?:[\\/].*)?[\\/]scripts[\\/]/.test(readlinkSync(p))) {
        rmSync(p, { force: true });
      }
    } catch { /* ignore */ }
  }
}
