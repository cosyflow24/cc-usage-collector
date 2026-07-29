// The three Claude Code hook handlers, ported near-verbatim from the old
// session-prompt.sh / capture-task.sh / ask-task.sh `node -e` bodies. The
// user-facing text (EN+DE block, verbatim hint line, drift/stale nudges) is
// transplanted unchanged — the collector and reviewers depend on it byte-for-byte.
//
// Each handler returns the hook-output object to print (or null = pass-through).
// Callers must always exit 0; diagnostics go to hook.err, never stdout.
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR, readConfig } from "./config.mjs";
import {
  mapCwd, appendRow, captureAccount, branchKey, declaredRow, isDeclared,
  recentForCwd, writeMarker, hasMarker,
} from "./state.mjs";
import { selfHealLauncher } from "./launcher.mjs";

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

// ---- SessionStart: map cwd->sid, auto-capture, maintenance, task hint --------
export function sessionStart(payload) {
  const sid = payload.session_id || payload.sessionId || "";
  const cwd = payload.cwd || process.cwd();

  if (sid) mapCwd(cwd, sid);
  autoCapture(sid, cwd);
  try { captureAccount(sid, cwd); } catch { /* ignore */ }
  maintenance();

  if (!sid || isDeclared(sid)) return null; // resumed/attributed → no nag

  const recent = recentForCwd(cwd).map((r) => r.key);
  const bk = branchKey(cwd);
  const sugg = recent.slice();
  if (bk && !recent.includes(bk)) sugg.push(`${bk} (branch)`);
  const hint = sugg.length ? `Recent here: ${sugg.join(", ")}. ` : "";

  const line = `[cc-usage] ${hint}`
    + "Set the Jira task for this session:  /cc-usage:task last (reuse most recent)  |  "
    + "/cc-usage:task <KEY> (existing issue)  |  /cc-usage:task none. "
    + "New issue? Create it via the company Jira plugin first, then /cc-usage:task <the new KEY>.";
  const additionalContext = "At the very START of your first reply, show the developer this line VERBATIM "
    + "(do not translate it, never Chinese), then continue normally. Hint only, not a blocker:\n"
    + line;
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
    const bk = branchKey(cwd);
    if (bk && bk !== declared.jira) {
      const mark = `drift-${sid}-${bk}`;
      if (!hasMarker(mark)) {
        writeMarker(mark);
        const reason = `[cc-usage] Task drift? This session is recorded as ${declared.jira}, but the git branch points to ${bk}. `
          + `Run  /cc-usage:task ${bk}  to switch, or ignore to keep ${declared.jira}.\n`
          + `[DE] Task gewechselt? Diese Session ist als ${declared.jira} erfasst, der Branch zeigt aber auf ${bk}. `
          + `Fuehre  /cc-usage:task ${bk}  zum Wechseln aus, oder ignoriere es.`;
        return { decision: "block", reason };
      }
      return null;
    }
    const ageH = (Date.now() - new Date(declared.ts || 0).getTime()) / 3600000;
    if (Number.isFinite(ageH) && ageH > 24) {
      const mark = `stale-${sid}-${new Date().toISOString().slice(0, 10)}`;
      if (!hasMarker(mark)) {
        writeMarker(mark);
        const ageD = Math.round((ageH / 24) * 10) / 10;
        const reason = `[cc-usage] Still working on ${declared.jira}? This session was bound to it ${ageD}d ago. `
          + "Confirm with  /cc-usage:task last  (keep), switch with  /cc-usage:task <KEY>, or  /cc-usage:task none  to stop tracking. "
          + "Asked at most once per day.\n"
          + `[DE] Arbeitest du noch an ${declared.jira}? Diese Session wurde vor ${ageD} Tag(en) darauf gebucht. `
          + "Bestaetige mit  /cc-usage:task last  (behalten), wechsle mit  /cc-usage:task <KEY>  oder  /cc-usage:task none. "
          + "Hoechstens einmal pro Tag gefragt.";
        return { decision: "block", reason };
      }
    }
    return null;
  }

  // No task yet → ask once. Mark BEFORE blocking so we interrupt at most once.
  writeMarker(sid);
  const recent = recentForCwd(cwd);
  const bk = branchKey(cwd);
  const sugg = recent.map((r) => `${r.key} (${ago(r.ts)})`);
  if (bk && !recent.some((r) => r.key === bk)) sugg.push(`${bk} (branch)`);
  const suggestLine = sugg.length
    ? `\n[cc-usage] Recent in this folder: ${sugg.join(", ")}`
      + " — reuse the most recent with  /cc-usage:task last  (or  /cc-usage:task <KEY>)."
      + `\n[DE] Zuletzt in diesem Ordner: ${sugg.join(", ")}`
      + " — den letzten uebernehmen mit  /cc-usage:task last  (oder  /cc-usage:task <KEY>)."
    : "";
  const reason = "[cc-usage] Which Jira issue is this session for? "
    + "Run  /cc-usage:task <KEY>  (e.g. /cc-usage:task KI-758) for an existing issue, or  /cc-usage:task none  to skip. "
    + "No existing key? Create the issue via the company Jira plugin first, then  /cc-usage:task <the new KEY>. "
    + "You will only be asked once per session.\n"
    + "[DE] Zu welchem Jira-Vorgang gehoert diese Session? "
    + "Fuehre  /cc-usage:task <KEY>  aus (z. B. /cc-usage:task KI-758) fuer einen bestehenden Vorgang, oder  /cc-usage:task none. "
    + "Noch kein Key? Lege den Vorgang zuerst ueber das Firmen-Jira-Plugin an, dann  /cc-usage:task <der neue KEY>."
    + suggestLine;
  return { decision: "block", reason };
}

// ---- maintenance: replaces bootstrap.sh (keeps the 09:30 LaunchAgent alive) --
const COMPAT_MARKER = "Regenerated by cc-usage";

function maintenance() {
  try {
    const bin = join(STATE_DIR, "bin");
    mkdirSync(bin, { recursive: true });
    regenCompatSync(bin);
    pruneOldSymlinks(bin);
    rmSync(join(STATE_DIR, "plugin-dist.env"), { force: true });
    selfHealLauncher();
  } catch { /* never block a hook */ }
}

function regenCompatSync(bin) {
  const target = join(bin, "sync.sh");
  if (existsSync(target) && !ownsCompat(target)) return; // foreign → leave
  const body = "#!/bin/bash\n"
    + `# ${COMPAT_MARKER} (plugin). Compat entry for the com.nnb24.cc-usage-sync LaunchAgent.\n`
    + `exec node ${JSON.stringify(ccUsageMjs)} sync --days "\${1:-1}"\n`;
  rmSync(target, { force: true });
  writeFileSync(target, body, { mode: 0o755 });
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
