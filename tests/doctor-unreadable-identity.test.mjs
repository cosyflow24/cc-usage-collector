// A machine where NEITHER provider identity can be read must FAIL the health
// check, not pass it.
//
// Since 0.9.0 the collector fails CLOSED on an unreadable account: the session
// resolves to `unknown-<provider>-account` and the work-domain gate drops it.
// That is the right call for privacy and the wrong thing to be silent about —
// such a machine uploads NOTHING, for ever, and doctor used to print the
// "not signed in" line as an info line and exit 0 with "healthy".
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../cc-usage/tools/cc-usage.mjs", import.meta.url).pathname;

/** Run `doctor` against a sandboxed HOME/config with a fake dashboard. */
function doctor({
  claudeEmail = null, codexEmail = null,
  claudeInstalled = undefined, codexInstalled = undefined,
}) {
  const dir = mkdtempSync(join(tmpdir(), "ccu-doctor-"));
  const claudeCfg = join(dir, "claude");
  mkdirSync(join(claudeCfg, "cc-usage"), { recursive: true });
  // An account file with NO oauthAccount is the real shape the "installed but
  // unreadable" fault covers: the file exists and parses, it just cannot say who
  // is signed in. Omitting the file entirely is the different, benign state —
  // this host is not used on this machine.
  if (claudeInstalled ?? Boolean(claudeEmail)) {
    writeFileSync(
      join(claudeCfg, ".claude.json"),
      JSON.stringify(claudeEmail ? { oauthAccount: { emailAddress: claudeEmail } } : {}),
    );
  }
  const codexHome = join(dir, "codex");
  mkdirSync(codexHome, { recursive: true });
  // `codexInstalled` separates "Codex is not on this machine" (no auth.json at
  // all) from "Codex is here but its identity cannot be read" (the file exists
  // and carries no usable email). Only the second is a fault.
  const wantCodexFile = codexInstalled ?? Boolean(codexEmail);
  if (wantCodexFile) {
    const body = codexEmail
      ? { tokens: { id_token: `h.${Buffer.from(JSON.stringify({ email: codexEmail })).toString("base64url")}.s` } }
      : {};
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(body));
  }
  // A token must be present, or doctor fails for the ordinary "no token" reason
  // and this test would pass for the wrong cause. CC_USAGE_ALLOW_ENV_TOKEN is
  // the module's own opt-in test hatch — it never shadows the real keyring
  // unless explicitly enabled, so a test run cannot pick up the developer's own
  // token by accident.

  const res = spawnSync(process.execPath, [cli, "doctor"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: dir,
      CLAUDE_CONFIG_DIR: claudeCfg,
      CODEX_HOME: codexHome,
      CC_USAGE_CONFIG_DIR: join(dir, "config"),
      // Unroutable on purpose: the live check must come back "unreachable", not
      // touch the real dashboard from a test run.
      CC_USAGE_INGEST_URL: "http://127.0.0.1:9/api/ingest",
      CC_USAGE_ALLOW_ENV_TOKEN: "1",
      CC_USAGE_INGEST_TOKEN: "ccu_sandbox_not_a_real_token",
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return { out: `${res.stdout}${res.stderr}`, status: res.status };
}

test("neither identity readable → doctor FAILS and says the machine uploads nothing", () => {
  // Both files present, neither naming an account.
  const { out, status } = doctor({ claudeInstalled: true, codexInstalled: true });
  // The Claude file exists (written above) but names no account, so this is the
  // "installed but unreadable" fault, not the "no host at all" one.
  assert.match(out, /Claude is installed here but its account cannot be read/);
  assert.match(out, /uploads NOTHING/);
  assert.notEqual(status, 0, "doctor must exit non-zero, not print `healthy`");
  assert.doesNotMatch(out, /doctor: healthy/);
});

test("a readable Claude identity does not trip that failure", () => {
  const { out } = doctor({ claudeEmail: "someone@nnb24.de" });
  assert.doesNotMatch(out, /Claude is installed here but its account cannot be read/);
});

test("a genuinely Codex-only machine is healthy — no Claude file, no complaint", () => {
  // The regression that motivated this file: doctor read only ~/.claude.json,
  // so a Codex-only colleague got "not signed in" and a healthy exit code.
  // Here the opposite must hold: judged on Codex, and silent about a host that
  // is not installed at all.
  const { out } = doctor({ codexEmail: "someone@nnb24.de", claudeInstalled: false });
  assert.doesNotMatch(out, /account file found/);
  assert.doesNotMatch(out, /cannot be read/);
});

test("a machine with NEITHER host installed says so, distinctly", () => {
  const { out, status } = doctor({ claudeInstalled: false, codexInstalled: false });
  assert.match(out, /no Claude or Codex account file found/);
  assert.notEqual(status, 0);
});

test("ONE unreadable provider is a failure even when the other is fine", () => {
  // The narrowing that cycle 2 caught: failing only when BOTH identities were
  // unreadable left a machine with a readable Codex login and an unreadable
  // Claude one printing a Codex verdict, saying nothing about Claude, and
  // exiting 0 — while every Claude session was dropped and uploaded nowhere.
  const { out, status } = doctor({
    claudeInstalled: true, claudeEmail: null, codexEmail: "someone@nnb24.de",
  });
  assert.match(out, /Claude is installed here but its account cannot be read/);
  assert.match(out, /uploads NOTHING/);
  assert.notEqual(status, 0);
  assert.doesNotMatch(out, /doctor: healthy/);
});

test("the reverse pairing fails too", () => {
  const { out, status } = doctor({ claudeEmail: "someone@nnb24.de", codexInstalled: true });
  assert.match(out, /Codex is installed here but its account cannot be read/);
  assert.notEqual(status, 0);
});

test("a host that is simply NOT INSTALLED is never reported as broken", () => {
  // Most colleagues do not use Codex. Failing on an absent auth.json would fire
  // on every one of those machines.
  const { out } = doctor({ claudeEmail: "someone@nnb24.de", codexInstalled: false });
  assert.doesNotMatch(out, /Codex is installed here/);
});
