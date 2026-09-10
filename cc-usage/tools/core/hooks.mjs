// Shared Claude Code/Codex attribution hooks. Interpret the current request
// before reusing an old task. Only a standalone key binds deterministically;
// prose is interpreted by the host agent without uploading conversation text.
// Each handler returns hook context (or null); attribution never blocks work.
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR, resolverPath, readConfig } from "./config.mjs";
import {
  mapCwd, appendRow, captureAccount, branchKey, declaredRow, isDeclared,
  recentForCwd, hasMarker,
} from "./state.mjs";
import { reconcile } from "./launcher.mjs";
import { selfUpdate } from "./autoupdate.mjs";

const toolDir = dirname(dirname(fileURLToPath(import.meta.url))); // tools/
const ccUsageMjs = join(toolDir, "cc-usage.mjs");

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Headless / non-interactive runs (CI, `claude -p`, batch jobs) must never emit
// an AskUserQuestion instruction or a blocking prompt — there is no human to
// answer and a block can wedge the run. Such sessions still get silent
// autoCapture binding. Set
// CC_USAGE_HEADLESS=1 to force this off explicitly.
function nonInteractive() {
  return !!(process.env.CI || process.env.CC_USAGE_HEADLESS
    || process.env.CLAUDE_CODE_NONINTERACTIVE);
}

function currentProvider(payload) {
  const payloadSid = payload.session_id || payload.sessionId || "";
  const codexSid = process.env.CODEX_THREAD_ID || "";
  // A Codex parent process can run tests/tools that simulate a Claude hook.
  // Treat it as Codex only when the hook id is absent or matches this thread.
  return codexSid && (!payloadSid || payloadSid === codexSid) ? "codex" : "claude";
}

// The two hosts do not share an ask-the-user tool, and naming the wrong one
// leaves the agent improvising. Claude Code has AskUserQuestion. Codex has
// request_user_input (and request_user_input_async where the host only offers
// the sync form in Plan mode); this machine's Codex developer_instructions
// spell out exactly that mapping. Attribution is an optional question, not a
// permission request, so the structured tool is the right fit.
function askToolPhrase(provider) {
  return provider === "codex"
    ? "call the request_user_input tool (or request_user_input_async if the host only offers the sync form in Plan mode)"
    : 'call the AskUserQuestion tool (header "cc-usage")';
}

function hookSessionId(payload, provider) {
  if (provider === "codex" && process.env.CODEX_THREAD_ID) return process.env.CODEX_THREAD_ID;
  return payload.session_id || payload.sessionId || "";
}

// The host already has the conversation: semantic attribution needs no new
// model call, Jira credentials, prompt storage, or prompt upload.
function attributionContext(provider, declared, candidates, event) {
  const launcher = `node ${JSON.stringify(resolverPath)} task`;
  const additionalContext = `[cc-usage] Resolve task attribution from the CURRENT user request and conversation. `
    + `Current label: ${declared?.jira || "not attributed"}. Candidate keys (not decisions): [${candidates.join(", ")}]. `
    + "A previous label, recent folder history, or a branch is not evidence that a NEW request belongs to it. "
    + "Extract the task the user actually asks you to work on, including a key in a sentence or Jira URL. "
    + "For multiple keys, distinguish the target from comparisons, dependencies, quoted examples, and negated tasks; never take the first match blindly. "
    + "Without a key, use semantics only when this conversation already establishes the description-to-key mapping; never invent a Jira key. "
    + `When the target is clear and differs from the current label, run \`${launcher} <KEY>\` automatically, `
    + "passing only a validated key matching ^[A-Z][A-Z0-9]+-[0-9]+$; never interpolate raw user text. "
    + "Keep the existing label silently for a clear continuation. If a task switch is evident but the target key is unresolved, "
    + `${askToolPhrase(provider)} with one concise clarification; do not present the old label as the identified new task. `
    + "If initially unassigned and the request cannot be mapped, ask once for a key or None; if ignored, continue work without repeating the question. "
    + `For an explicit opt-out run \`${launcher} none\`. This records only local attribution metadata, never writes to Jira. `
    + "The collector labels the whole session with its latest key; for separate per-task accounting use a new session when switching tasks.";
  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

// ---- SessionStart: map cwd->sid, auto-capture, maintenance, task hint --------
export function sessionStart(payload) {
  const provider = currentProvider(payload);
  const sid = hookSessionId(payload, provider);
  const cwd = payload.cwd || process.cwd();
  if (sid) mapCwd(cwd, sid, provider);
  // Resuming must not overwrite a prompt/manual selection with an old branch.
  if (sid && !isDeclared(sid, provider) && !hasMarker(`${provider}-${sid}`)
      && !(provider === "claude" && hasMarker(sid))) autoCapture(sid, cwd, provider);
  try { captureAccount(sid, cwd, provider); } catch { /* ignore */ }
  maintenance();
  if (!sid || nonInteractive() || hasMarker(`${provider}-${sid}`)
      || (provider === "claude" && hasMarker(sid))) return null;
  // Folder history is a suggestion, never a silent binding of a new session.
  return attributionContext(provider, declaredRow(sid, provider),
    recentForCwd(cwd).map((r) => r.key), "SessionStart");
}

function autoCapture(sid, cwd, provider = "claude") {
  const KEY = /[A-Z][A-Z0-9]+-\d+/;
  let jira = (process.env.CC_JIRA || "").toUpperCase().match(KEY)?.[0] || "";
  if (!jira) {
    try { jira = readFileSync(join(cwd, ".ccjira"), "utf8").toUpperCase().match(KEY)?.[0] || ""; } catch { /* no file */ }
  }
  if (!jira) jira = branchKey(cwd) || "";
  if (sid && jira) {
    const row = { schemaVersion: 1, provider, sessionId: sid, jira, cwd, ts: new Date().toISOString(), src: "hook" };
    const epic = (process.env.CC_EPIC || "").toUpperCase().match(KEY)?.[0] || "";
    if (epic) row.epic = epic;
    try { appendRow(row); } catch { /* ignore */ }
  }
}

// ---- UserPromptSubmit: explicit keys and host semantic interpretation ------
export function promptSubmit(payload) {
  const provider = currentProvider(payload);
  const sid = hookSessionId(payload, provider);
  const cwd = payload.cwd || process.cwd();
  // Re-capture the signed-in account on EVERY prompt, before any early return.
  // SessionStart alone is not enough: `/login` mid-session silently leaves the
  // whole session attributed to the PREVIOUS account. captureAccount only writes
  // when the account actually changed, so the common case costs one bounded tail
  // read and no row. Deliberately ahead of the project filter and the
  // prompt/marker guards below — an account switch is worth recording even in a
  // session whose attribution we otherwise ignore.
  try { captureAccount(sid, cwd, provider); } catch { /* never block a hook */ }
  const raw = payload.prompt || payload.user_prompt || "";
  const prompt = typeof raw === "string" ? raw.trim() : "";
  const proj = process.env.CC_USAGE_PROJECT || readConfig().project;
  if (proj && basename(cwd) !== proj) return null;
  if (sid) mapCwd(cwd, sid, provider);
  if (!sid || !prompt || prompt.startsWith("/") || nonInteractive()) return null;
  if (hasMarker(`${provider}-${sid}`) || (provider === "claude" && hasMarker(sid))) return null;

  const declared = declaredRow(sid, provider);
  // Only a standalone key is unambiguous without interpreting the sentence.
  // A sentence with one key can still say "do not work on BI-123".
  const exact = /^[A-Z][A-Z0-9]+-[0-9]+$/i.test(prompt) ? prompt.toUpperCase() : null;
  if (exact) {
    if (declared?.jira !== exact) appendRow({
      schemaVersion: 1, provider, sessionId: sid, jira: exact, cwd,
      ts: new Date().toISOString(), src: "prompt-key",
    });
    return null;
  }
  const candidates = [...new Set(Array.from(
    prompt.matchAll(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9]+-[0-9]+(?![A-Za-z0-9_])/gi),
    (m) => m[0].toUpperCase(),
  ))].slice(0, 20);
  return attributionContext(provider, declared, candidates, "UserPromptSubmit");
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
