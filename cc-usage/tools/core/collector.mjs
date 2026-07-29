// The only boundary to the compiled collector bundle (dist/cli.js). Owns dist
// resolution, credential loading (keyring, with one-time legacy-env migration),
// and env injection. The token stays in memory — never re-written to disk.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readConfig, writeConfig, readLegacyEnv, stripLegacyToken, readOauthEmail,
} from "./config.mjs";
import { storeToken, loadToken } from "./keyring.mjs";

const pluginRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // cc-usage/

export function distDir() {
  return process.env.CC_USAGE_PLUGIN_DIST || join(pluginRoot, "dist");
}
export function bundlePath() { return join(distDir(), "cli.js"); }

// Resolve { url, token, cfg }. Migrates a pre-plugin plaintext token into the
// keyring on first encounter; never strands the user if migration fails.
export function loadCredentials({ notify = false } = {}) {
  const cfg = readConfig();
  let token = loadToken(cfg);
  if (token) return { url: cfg.ingestUrl, token, cfg };

  const legacy = readLegacyEnv();
  const legacyToken = legacy.CC_USAGE_INGEST_TOKEN || "";
  if (/^ccu_[A-Za-z0-9_-]+$/.test(legacyToken)) {
    const url = legacy.CC_USAGE_INGEST_URL || cfg.ingestUrl;
    // Always a concrete, stable keyring account so store/read is deterministic
    // (never the service-wide fuzzy match) — critical before deleting the plaintext.
    const email = cfg.email || readOauthEmail() || "default";
    try {
      storeToken(email, legacyToken);
      if (loadToken({ email }) === legacyToken) { // verify exact-account round-trip
        writeConfig({ ingestUrl: url, email, project: legacy.CC_USAGE_PROJECT || cfg.project });
        stripLegacyToken();
        if (notify) process.stderr.write("cc-usage: migrated your token from the plaintext env file into the OS keyring.\n");
      }
    } catch (error) {
      if (notify) process.stderr.write(`cc-usage: keyring migration deferred (${error.message}); using legacy token this run.\n`);
    }
    return { url, token: legacyToken, cfg: { ...cfg, ingestUrl: url } };
  }
  return { url: cfg.ingestUrl, token: "", cfg };
}

// Run the collector. When `args` includes --upload we require + inject creds;
// otherwise it's a pure local analysis pass. `quiet` (for the SessionEnd hook)
// discards the collector's stdout so the hook stays silent — on failure the
// caller logs to hook.err.
export function runCollector(args, { quiet = false } = {}) {
  const bundle = bundlePath();
  if (!existsSync(bundle)) {
    const e = new Error(`bundled collector not found at ${bundle}. Reinstall the plugin.`);
    e.exitCode = 1; throw e;
  }
  const env = { ...process.env };
  if (args.includes("--upload")) {
    const { url, token, cfg } = loadCredentials({ notify: !quiet });
    if (!token) {
      const e = new Error("no upload credentials. Run  cc-usage login  first.");
      e.exitCode = 1; throw e;
    }
    env.CC_USAGE_INGEST_URL = url;
    env.CC_USAGE_INGEST_TOKEN = token;
    if (cfg.user) env.CC_USAGE_USER = cfg.user;
    if (cfg.workDomain) env.CC_USAGE_WORK_DOMAIN = cfg.workDomain;
  }
  const result = spawnSync(process.execPath, [bundle, ...args], {
    stdio: quiet ? ["ignore", "ignore", "pipe"] : "inherit",
    encoding: quiet ? "utf8" : undefined,
    env,
  });
  if (quiet && result.status) {
    const e = new Error((result.stderr || "").trim() || `collector exited ${result.status}`);
    e.exitCode = result.status; throw e;
  }
  return result.status ?? 1;
}
