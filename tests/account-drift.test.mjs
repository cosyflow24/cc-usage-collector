// Mid-session account switching (`/login`) must be recorded.
//
// Before this, captureAccount ran only on SessionStart, so a session that
// switched accounts kept being attributed to whoever was signed in when it
// started. On a SHARED account that is not a cosmetic error: the usage lands
// under the wrong person.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const stateModule = new URL("../cc-usage/tools/core/state.mjs", import.meta.url).href;
const hooksModule = new URL("../cc-usage/tools/core/hooks.mjs", import.meta.url).href;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ccu-drift-"));
  mkdirSync(join(dir, "claude", "cc-usage"), { recursive: true });
  return dir;
}

function setAccount(dir, email) {
  writeFileSync(
    join(dir, "claude", ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
}

/** Run `body` inside a child process with CLAUDE_CONFIG_DIR pointed at the sandbox. */
function run(dir, body, extraEnv = {}) {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), ...extraEnv },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

function rows(dir) {
  try {
    return readFileSync(join(dir, "claude", "cc-usage", "tasks.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

const capture = (sid, provider = "claude") => `
  const { captureAccount } = await import(${JSON.stringify(stateModule)});
  captureAccount(${JSON.stringify(sid)}, "/tmp/proj", ${JSON.stringify(provider)});
`;

test("captureAccount writes one row, then stays silent while the account is unchanged", () => {
  const dir = sandbox();
  try {
    setAccount(dir, "first@nnb24.de");
    run(dir, capture("sess-1"));
    run(dir, capture("sess-1"));
    run(dir, capture("sess-1"));
    const acct = rows(dir).filter((r) => r.account);
    assert.equal(acct.length, 1, "repeat captures must not append duplicate rows");
    assert.equal(acct[0].account, "first@nnb24.de");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-session /login is recorded as a new row that wins by timestamp", () => {
  const dir = sandbox();
  try {
    setAccount(dir, "old@nnb24.de");
    run(dir, capture("sess-2"));
    setAccount(dir, "new@nnb24.de");
    run(dir, capture("sess-2"));

    const acct = rows(dir).filter((r) => r.account);
    assert.equal(acct.length, 2);
    assert.deepEqual(acct.map((r) => r.account), ["old@nnb24.de", "new@nnb24.de"]);
    // loadSessionAccounts() takes the latest ts per session, so the session ends
    // up attributed to the account actually in use at the end.
    assert.ok(acct[1].ts >= acct[0].ts, "the newer row must not sort before the older one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching back to a previous account still records a row", () => {
  const dir = sandbox();
  try {
    setAccount(dir, "a@nnb24.de");
    run(dir, capture("sess-3"));
    setAccount(dir, "b@nnb24.de");
    run(dir, capture("sess-3"));
    setAccount(dir, "a@nnb24.de");
    run(dir, capture("sess-3"));
    const acct = rows(dir).filter((r) => r.account).map((r) => r.account);
    assert.deepEqual(acct, ["a@nnb24.de", "b@nnb24.de", "a@nnb24.de"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Codex row never suppresses a Claude capture for the same session id", () => {
  const dir = sandbox();
  try {
    setAccount(dir, "shared@nnb24.de");
    // A pre-existing Codex row with the SAME account and session id: provider
    // isolation must still let the Claude capture through.
    appendFileSync(
      join(dir, "claude", "cc-usage", "tasks.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1, provider: "codex", sessionId: "sess-4",
        account: "shared@nnb24.de", ts: "2026-01-01T00:00:00.000Z", src: "hook-acct",
      })}\n`,
    );
    run(dir, capture("sess-4", "claude"));
    const claudeRows = rows(dir).filter((r) => r.account && r.provider === "claude");
    assert.equal(claudeRows.length, 1, "claude capture must not be suppressed by a codex row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tail scan finds a recent row even behind megabytes of history", () => {
  const dir = sandbox();
  try {
    setAccount(dir, "first@nnb24.de");
    run(dir, capture("sess-5"));
    // ~1.5 MB of unrelated history, well past the 512 KB tail window, appended
    // AFTER the account row would push it out of range — so append filler first
    // and the account row last, mirroring reality (a session's rows are recent).
    const filler = `${JSON.stringify({
      schemaVersion: 1, provider: "claude", sessionId: "other", jira: "BI-1",
      cwd: "/tmp/other", ts: "2026-01-01T00:00:00.000Z", src: "hook",
    })}\n`.repeat(6000);
    appendFileSync(join(dir, "claude", "cc-usage", "tasks.jsonl"), filler);
    run(dir, capture("sess-5"));
    // The account row aged out of the tail window, so a re-record is expected and
    // harmless — what must NOT happen is a wrong account or a crash.
    const acct = rows(dir).filter((r) => r.account);
    assert.ok(acct.length >= 1);
    assert.ok(acct.every((r) => r.account === "first@nnb24.de"));

    // Now the account row IS inside the window: no duplicate.
    const before = rows(dir).filter((r) => r.account).length;
    run(dir, capture("sess-5"));
    assert.equal(rows(dir).filter((r) => r.account).length, before, "in-window repeat must not append");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promptSubmit captures the account even when the project filter short-circuits", () => {
  const dir = sandbox();
  try {
    setAccount(dir, "drifted@nnb24.de");
    // CC_USAGE_PROJECT names a DIFFERENT project than cwd, so promptSubmit
    // returns null early. The account capture sits ahead of that guard on
    // purpose — an account switch matters even in a session we do not attribute.
    const out = run(dir, `
      const { promptSubmit } = await import(${JSON.stringify(hooksModule)});
      const r = promptSubmit({ session_id: "sess-6", cwd: "/tmp/some-other-project", prompt: "hallo" });
      process.stdout.write(JSON.stringify(r));
    `, { CC_USAGE_PROJECT: "not-this-one", CLAUDE_CODE_SESSION_ID: "sess-6" });
    assert.equal(out, "null", "project filter should still short-circuit the hint");
    const acct = rows(dir).filter((r) => r.account);
    assert.equal(acct.length, 1, "account must be captured despite the early return");
    assert.equal(acct[0].account, "drifted@nnb24.de");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
