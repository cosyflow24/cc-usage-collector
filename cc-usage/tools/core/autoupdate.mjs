// Daily background self-update: installed users stay current with zero manual
// steps. Once per day a detached Node worker runs the Claude CLI, so this works
// on Windows too — no /bin/sh, no shell-quoted command string.
//
// `claude plugin update` installs the marketplace's declared VERSION (not
// arbitrary commits), so publishing stays gated by a version bump. The update
// applies on the next session. Opt out with CC_USAGE_NO_AUTOUPDATE=1.
import { appendFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { STATE_DIR } from "./config.mjs";
import { claimMarker } from "./state.mjs";

const PLUGIN_ID = "cc-usage@cc-usage";
const MARKETPLACE = "cc-usage";
const ccUsageMjs = join(dirname(dirname(fileURLToPath(import.meta.url))), "cc-usage.mjs");

export function findClaude() {
  const probe = platform() === "win32"
    ? ["where", ["claude"]]
    : ["/bin/sh", ["-c", "command -v claude"]];
  try {
    const found = execFileSync(probe[0], probe[1], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch { /* not on PATH */ }
  const candidates = platform() === "win32"
    ? [join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Programs", "claude", "claude.exe")]
    : [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  for (const p of candidates) { if (existsSync(p)) return p; }
  return "";
}

// Runs in the detached child: the two CLI calls, sequentially, argv arrays only.
export function runUpdateWorker() {
  const log = join(STATE_DIR, "autoupdate.log");
  const claude = findClaude();
  if (!claude) return;
  const note = (s) => { try { appendFileSync(log, s); } catch { /* best effort */ } };
  note(`${new Date().toISOString()} worker start\n`);
  for (const args of [
    ["plugin", "marketplace", "update", MARKETPLACE],
    ["plugin", "update", PLUGIN_ID],
  ]) {
    try {
      note(execFileSync(claude, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      note(`FAILED ${args.join(" ")}: ${error.stderr || error.message}\n`);
      return;
    }
  }
  note(`${new Date().toISOString()} worker done\n`);
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
    child.unref();
  } catch { /* best effort */ }
}
