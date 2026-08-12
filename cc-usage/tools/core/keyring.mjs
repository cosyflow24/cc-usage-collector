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
export const windowsTokenFile = process.env.CC_USAGE_DPAPI_FILE || join(configDir, "token.dpapi");

function run(command, args, input = undefined, env = {}) {
  return spawnSync(command, args, {
    input, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env },
  });
}

function powershell() {
  return process.env.CC_USAGE_POWERSHELL || "powershell.exe";
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
    // User-scoped DPAPI, ported from the data-catalog plugin (family pattern):
    // the token is encrypted for the current Windows user and stored as
    // base64 — no plaintext file, no external dependency.
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$path=[Environment]::GetEnvironmentVariable('CC_USAGE_DPAPI_TARGET')",
      "$plain=[Console]::In.ReadToEnd()",
      "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
      "$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "$encoded=[Convert]::ToBase64String($protected)",
      "[IO.File]::WriteAllText($path,$encoded,[Text.UTF8Encoding]::new($false))",
    ].join(";");
    const result = run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], token, {
      CC_USAGE_DPAPI_TARGET: windowsTokenFile,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "Windows DPAPI rejected token");
    }
    rmSync(tokenFile, { force: true });
    return "Windows DPAPI";
  }
  // Drop any existing file OR symlink first (rmSync removes the link itself, not
  // its target), then create the token file with an EXCLUSIVE open (flag "wx"):
  // if anything — including a re-planted symlink — races into place between the
  // two calls, "wx" fails with EEXIST instead of following it onto another path.
  rmSync(tokenFile, { force: true });
  writeFileSync(tokenFile, token, { flag: "wx", mode: 0o600 });
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
  if (platform() === "win32" && existsSync(windowsTokenFile)) {
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$path=[Environment]::GetEnvironmentVariable('CC_USAGE_DPAPI_TARGET')",
      "$encoded=[IO.File]::ReadAllText($path,[Text.Encoding]::UTF8)",
      "$protected=[Convert]::FromBase64String($encoded)",
      "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
    ].join(";");
    const result = run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], undefined, {
      CC_USAGE_DPAPI_TARGET: windowsTokenFile,
    });
    return result.status === 0 ? result.stdout.trimEnd() : "";
  }
  return existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trimEnd() : "";
}

export function removeToken(email) {
  if (platform() === "darwin") {
    if (email) run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", email]);
    else run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE]);
  }
  rmSync(windowsTokenFile, { force: true });
  rmSync(tokenFile, { force: true });
}

export function secretDescription() {
  if (platform() === "darwin") return `macOS Keychain (${KEYCHAIN_SERVICE})`;
  if (platform() === "win32") return `Windows DPAPI (${windowsTokenFile})`;
  return tokenFile;
}
