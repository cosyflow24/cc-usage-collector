// Non-secret configuration + path helpers for the cc-usage CLI.
//
// Two distinct dirs, on purpose:
//   ~/.config/cc-usage/        tool config (this module) — XDG, like nnb-jira
//   ~/.claude/cc-usage/        collector STATE (state.mjs) — unchanged, because
//                              the dist bundle and 5.9 MB of history live here.
// Every path has an env override so the test sandbox can redirect it.
import {
  chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_INGEST_URL = "https://cc-usage.up.railway.app/api/ingest";

export const configDir = process.env.CC_USAGE_CONFIG_DIR
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cc-usage");
export const jsonConfigFile = process.env.CC_USAGE_CONFIG_FILE || join(configDir, "config.json");

// Collector state dir (honours CLAUDE_CONFIG_DIR exactly like the old bash did).
export const STATE_DIR = join(
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  "cc-usage",
);
export const legacyEnvFile = join(STATE_DIR, "env");
export const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
  : join(homedir(), ".claude.json");

export function readConfig() {
  let stored = {};
  if (existsSync(jsonConfigFile)) {
    try { stored = JSON.parse(readFileSync(jsonConfigFile, "utf8")); } catch { stored = {}; }
  }
  return {
    schemaVersion: 1,
    ingestUrl: stored.ingestUrl || process.env.CC_USAGE_INGEST_URL || DEFAULT_INGEST_URL,
    email: stored.email || "",
    project: stored.project || process.env.CC_USAGE_PROJECT || "",
    user: stored.user || process.env.CC_USAGE_USER || "",
    workDomain: stored.workDomain || process.env.CC_USAGE_WORK_DOMAIN || "",
  };
}

export function writeConfig(config) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") chmodSync(configDir, 0o700);
  const body = {
    schemaVersion: 1,
    ingestUrl: config.ingestUrl || DEFAULT_INGEST_URL,
    email: config.email || "",
    project: config.project || "",
    ...(config.user ? { user: config.user } : {}),
    ...(config.workDomain ? { workDomain: config.workDomain } : {}),
  };
  writeFileSync(jsonConfigFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  if (platform() !== "win32") chmodSync(jsonConfigFile, 0o600);
  return body;
}

// Parse the pre-plugin plaintext env (`~/.claude/cc-usage/env`), tolerating the
// `printf %q` quoting the old login command used. Returns { CC_USAGE_* : value }.
export function readLegacyEnv() {
  const result = {};
  if (!existsSync(legacyEnvFile)) return result;
  for (const line of readFileSync(legacyEnvFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^(CC_USAGE_[A-Z_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    value = value.replace(/\\(.)/g, "$1"); // undo `\ ` etc. from %q
    result[match[1]] = value;
  }
  return result;
}

// Remove ONLY the token line from the legacy env file after migration — every
// other line (URL, project, comments, anything the user added) is preserved.
// Best-effort — never throws.
export function stripLegacyToken() {
  try {
    if (!existsSync(legacyEnvFile)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const kept = readFileSync(legacyEnvFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^CC_USAGE_INGEST_TOKEN=/.test(l));
    const note = `# cc-usage: token moved to the OS keyring (cc-usage-ingest-token) on ${stamp}.`;
    const body = `${[note, ...kept].join("\n").replace(/\n+$/, "")}\n`;
    writeFileSync(legacyEnvFile, body, { mode: 0o600 });
    if (platform() !== "win32") chmodSync(legacyEnvFile, 0o600);
  } catch { /* never block on cleanup */ }
}

export function readOauthEmail() {
  try {
    const data = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
    return String(data?.oauthAccount?.emailAddress || "").toLowerCase();
  } catch { return ""; }
}

export function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}
