// Secret storage for the cc-usage ingest token. The ONLY module allowed to touch
// /usr/bin/security or the mode-0600 fallback file. Ported from nnb-jira's
// platform.mjs, minus Jira specifics. Account = the Claude oauth email.
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { configDir } from "./config.mjs";

export const KEYCHAIN_SERVICE = process.env.CC_USAGE_KEYCHAIN_SERVICE || "cc-usage-ingest-token";
export const tokenFile = process.env.CC_USAGE_TOKEN_FILE || join(configDir, "token");

function run(command, args, input = undefined) {
  return spawnSync(command, args, { input, encoding: "utf8", windowsHide: true });
}

export function storeToken(email, token) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (platform() === "darwin") {
    const result = run("/usr/bin/security", [
      "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", email || "", "-w", token,
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "macOS Keychain rejected token");
    }
    rmSync(tokenFile, { force: true });
    return "macOS Keychain";
  }
  if (platform() === "win32") {
    throw new Error("Windows keyring is not supported yet; run cc-usage on macOS/Linux");
  }
  writeFileSync(tokenFile, token, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  process.stderr.write(`WARNING: OS keyring unavailable; token stored in ${tokenFile} (mode 600).\n`);
  return tokenFile;
}

export function loadToken(config = {}) {
  // Opt-in test/CI escape hatch — never shadows the keyring silently.
  if (process.env.CC_USAGE_ALLOW_ENV_TOKEN === "1" && process.env.CC_USAGE_INGEST_TOKEN) {
    return process.env.CC_USAGE_INGEST_TOKEN;
  }
  if (platform() === "darwin") {
    if (config.email) {
      const byAccount = run("/usr/bin/security", [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", config.email, "-w",
      ]);
      if (byAccount.status === 0) return byAccount.stdout.trimEnd();
    }
    // Resilience: config lost its email → first match for the service.
    const byService = run("/usr/bin/security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w",
    ]);
    return byService.status === 0 ? byService.stdout.trimEnd() : "";
  }
  return existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trimEnd() : "";
}

export function removeToken(email) {
  if (platform() === "darwin") {
    if (email) run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", email]);
    else run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE]);
  }
  rmSync(tokenFile, { force: true });
}

export function secretDescription() {
  if (platform() === "darwin") return `macOS Keychain (${KEYCHAIN_SERVICE})`;
  if (platform() === "win32") return "unsupported";
  return tokenFile;
}
