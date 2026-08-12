import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The unified interaction contract (2026-08-12): every nudge is a
// non-blocking AskUserQuestion instruction, never `decision: "block"`.
// Run the hook handlers in a child process with isolated state dirs.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hooksModule = join(root, "cc-usage", "tools", "core", "hooks.mjs");

function runPromptSubmit(base, payload, { env = {} } = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { promptSubmit } = await import(${JSON.stringify(`file://${hooksModule}`)});
    const out = promptSubmit(${JSON.stringify(payload)});
    process.stdout.write(JSON.stringify(out));
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(base, "claude"),
      CC_USAGE_CONFIG_DIR: join(base, "config"),
      CC_USAGE_CONFIG_FILE: join(base, "config", "config.json"),
      CC_USAGE_PROJECT: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || "null");
}

function seedDeclared(base, sid, jira, { ageHours = 0 } = {}) {
  // Mirror the tasks.jsonl row shape (schemaVersion 1).
  const dir = join(base, "claude", "cc-usage");
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageHours * 3600000).toISOString();
  writeFileSync(join(dir, "tasks.jsonl"),
    `${JSON.stringify({ schemaVersion: 1, sessionId: sid, jira, cwd: base, ts, src: "test" })}\n`);
}

test("stale nudge is a non-blocking AskUserQuestion instruction", () => {
  const base = mkdtempSync(join(tmpdir(), "ccu-hooks-"));
  try {
    seedDeclared(base, "sid-1", "KI-123", { ageHours: 30 });
    const out = runPromptSubmit(base, { session_id: "sid-1", cwd: base, prompt: "hello" });
    assert.ok(out, "expected a nudge");
    assert.equal(out.decision, undefined, "must not block");
    const context = out.hookSpecificOutput?.additionalContext || "";
    assert.match(context, /Stale attribution/);
    assert.match(context, /AskUserQuestion/);
    assert.match(context, /KI-123/);
    assert.match(context, /task none/);
    // Asked at most once per day: second call stays silent.
    const again = runPromptSubmit(base, { session_id: "sid-1", cwd: base, prompt: "hello again" });
    assert.equal(again, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unattributed backstop instructs AskUserQuestion instead of blocking", () => {
  const base = mkdtempSync(join(tmpdir(), "ccu-hooks-"));
  try {
    // Burn the grace prompts, then expect the single AskUserQuestion backstop.
    let out = null;
    for (let i = 0; i < 4; i += 1) {
      out = runPromptSubmit(base, { session_id: "sid-2", cwd: base, prompt: `p${i}` });
      if (out) break;
    }
    assert.ok(out, "expected the backstop nudge after grace");
    assert.equal(out.decision, undefined, "must not block");
    const context = out.hookSpecificOutput?.additionalContext || "";
    assert.match(context, /not attributed/);
    assert.match(context, /AskUserQuestion/);
    assert.match(context, /None/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("headless sessions get no nudges at all", () => {
  const base = mkdtempSync(join(tmpdir(), "ccu-hooks-"));
  try {
    seedDeclared(base, "sid-3", "KI-123", { ageHours: 48 });
    const out = runPromptSubmit(base, { session_id: "sid-3", cwd: base, prompt: "hello" },
      { env: { CLAUDE_HEADLESS: "1", CI: "1" } });
    assert.equal(out, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
