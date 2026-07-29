// ~/.local/bin/cc-usage launcher install + ownership guard. Ported from
// nnb-jira jira.mjs (installLauncher/ownsLauncher/launcherDir), single-purpose so
// both the CLI entry and the session-start self-heal can use it without a cycle.
import {
  existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tools/ dir = two up from tools/core/launcher.mjs.
export const toolDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shim = join(toolDir, "cc-usage");

export function launcherDir() {
  if (process.env.CC_USAGE_BIN_DIR) return process.env.CC_USAGE_BIN_DIR;
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "cc-usage", "bin");
  }
  return join(homedir(), ".local", "bin");
}

export function launcherPath() {
  return join(launcherDir(), platform() === "win32" ? "cc-usage.cmd" : "cc-usage");
}

// True only for a launcher we created: a symlink resolving into a cc-usage
// `tools/cc-usage` (accepts both the versioned cache and the dev-workspace shape).
export function ownsLauncher(path) {
  if (!existsSync(path)) return false;
  try {
    const target = readlinkSync(path);
    return /(?:^|[\\/])cc-usage(?:[\\/].*)?[\\/]tools[\\/]cc-usage$/.test(target);
  } catch { return false; }
}

export function installLauncher() {
  const target = launcherDir();
  mkdirSync(target, { recursive: true });
  if (platform() === "win32") {
    throw new Error("Windows launcher is not supported yet; run cc-usage on macOS/Linux");
  }
  const launcher = join(target, "cc-usage");
  if (existsSync(launcher) && !ownsLauncher(launcher)) {
    const e = new Error(`refusing to replace an unrecognized launcher: ${launcher}`);
    e.exitCode = 1; throw e;
  }
  rmSync(launcher, { force: true });
  symlinkSync(shim, launcher);
  process.stdout.write(`Installed launcher: ${launcher}\n`);
  const norm = (v) => v.replace(/[\\/]+$/, "");
  if (!(process.env.PATH || "").split(":").map(norm).includes(norm(target))) {
    process.stderr.write(`Add ${target} to PATH to call cc-usage directly.\n`);
  }
  return launcher;
}

// Silent upgrade re-link for the session-start maintenance step: if the launcher
// is ours but points at a different (or dangling) plugin version, re-point it.
export function selfHealLauncher() {
  try {
    const launcher = join(launcherDir(), "cc-usage");
    if (!existsSync(launcher)) return; // absent = user never ran login; leave it
    if (!ownsLauncher(launcher)) return; // foreign = never touch
    let current = "";
    try { current = readlinkSync(launcher); } catch { /* dangling */ }
    if (current !== shim) { rmSync(launcher, { force: true }); symlinkSync(shim, launcher); }
  } catch { /* never block a hook */ }
}
