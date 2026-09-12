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
function doctor({ claudeEmail = null, codexEmail = null }) {
  const dir = mkdtempSync(join(tmpdir(), "ccu-doctor-"));
  const claudeCfg = join(dir, "claude");
  mkdirSync(join(claudeCfg, "cc-usage"), { recursive: true });
  // An account file with NO oauthAccount is the real shape this covers: the
  // file exists and parses, it just cannot say who is signed in.
  writeFileSync(
    join(claudeCfg, ".claude.json"),
    JSON.stringify(claudeEmail ? { oauthAccount: { emailAddress: claudeEmail } } : {}),
  );
  const codexHome = join(dir, "codex");
  mkdirSync(codexHome, { recursive: true });
  if (codexEmail) {
    const claim = Buffer.from(JSON.stringify({ email: codexEmail })).toString("base64url");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { id_token: `h.${claim}.s` } }));
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
  const { out, status } = doctor({});
  assert.match(out, /cannot read which account you are signed in to/);
  assert.match(out, /uploads NOTHING/);
  assert.notEqual(status, 0, "doctor must exit non-zero, not print `healthy`");
  assert.doesNotMatch(out, /doctor: healthy/);
});

test("a readable Claude identity does not trip that failure", () => {
  const { out } = doctor({ claudeEmail: "someone@nnb24.de" });
  assert.doesNotMatch(out, /cannot read which account you are signed in to/);
});

test("a Codex-only machine does not trip it either", () => {
  // The regression that motivated it: doctor read only ~/.claude.json.
  const { out } = doctor({ codexEmail: "someone@nnb24.de" });
  assert.doesNotMatch(out, /cannot read which account you are signed in to/);
});
