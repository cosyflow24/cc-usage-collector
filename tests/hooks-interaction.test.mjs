import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

function seedDeclared(base, sid, jira, { ageHours = 0, provider = "claude" } = {}) {
  // Mirror the tasks.jsonl row shape (schemaVersion 1).
  const dir = join(base, "claude", "cc-usage");
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageHours * 3600000).toISOString();
  writeFileSync(join(dir, "tasks.jsonl"),
    `${JSON.stringify({ schemaVersion: 1, provider, sessionId: sid, jira, cwd: base, ts, src: "test" })}\n`);
}

const rows = (base) => {
  try { return readFileSync(join(base, "claude", "cc-usage", "tasks.jsonl"), "utf8").trim().split("\n").map(JSON.parse); }
  catch { return []; }
};

for (const provider of ["claude", "codex"]) {
  test(`${provider}: standalone key replaces previous task without duplicating history`, () => {
    const base = mkdtempSync(join(tmpdir(), "ccu-task-"));
    try {
      seedDeclared(base, "sid", "KI-123", { provider });
      const env = { CODEX_THREAD_ID: provider === "codex" ? "sid" : "" };
      const payload = { session_id: "sid", cwd: base, prompt: "bi-456" };
      assert.equal(runPromptSubmit(base, payload, { env }), null);
      assert.equal(rows(base).at(-1).jira, "BI-456");
      assert.equal(rows(base).at(-1).provider, provider);
      const count = rows(base).length;
      runPromptSubmit(base, payload, { env });
      assert.equal(rows(base).length, count);
      assert.equal(JSON.stringify(rows(base)).includes("prompt" + '\":'), false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

for (const prompt of [
  "帮我修复 BI-456", "处理 https://jira.example/browse/BI-456",
  "不要做 KI-123，改做 BI-456", "不要做 BI-456",
  "比较 KI-123 和 BI-456", "改做我们刚讨论的登录修复",
]) {
  test(`host interprets current request without blindly rebinding: ${prompt}`, () => {
    const base = mkdtempSync(join(tmpdir(), "ccu-task-"));
    try {
      seedDeclared(base, "sid", "KI-123");
      const out = runPromptSubmit(base, { session_id: "sid", cwd: base, prompt });
      const context = out.hookSpecificOutput.additionalContext;
      assert.equal(out.decision, undefined);
      assert.match(context, /CURRENT user request/);
      assert.match(context, /automatically/);
      assert.match(context, /never invent a Jira key/);
      assert.match(context, /negated tasks/);
      if (prompt.includes("BI-456")) assert.match(context, /Candidate keys.*BI-456/);
      assert.equal(rows(base).length, 1);
      assert.equal(rows(base)[0].jira, "KI-123");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

test("Codex semantic clarification uses its own tool", () => {
  const base = mkdtempSync(join(tmpdir(), "ccu-task-"));
  try {
    const out = runPromptSubmit(base, { session_id: "sid", cwd: base, prompt: "下一项" },
      { env: { CODEX_THREAD_ID: "sid" } });
    assert.match(out.hookSpecificOutput.additionalContext, /request_user_input/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /AskUserQuestion/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

for (const mode of ["none", "legacy-none", "headless", "slash", "scope"]) {
  test(`${mode} remains silent and writes no task`, () => {
    const base = mkdtempSync(join(tmpdir(), "ccu-task-"));
    try {
      const asked = join(base, "claude", "cc-usage", "asked");
      mkdirSync(asked, { recursive: true });
      if (mode.includes("none")) writeFileSync(join(asked, mode === "none" ? "claude-sid" : "sid"), "skip");
      const env = { CODEX_THREAD_ID: "", ...(mode === "headless" ? { CC_USAGE_HEADLESS: "1" } : {}),
        ...(mode === "scope" ? { CC_USAGE_PROJECT: "another-project" } : {}) };
      const out = runPromptSubmit(base, { session_id: "sid", cwd: base,
        prompt: mode === "slash" ? "/task BI-456" : "BI-456" }, { env });
      assert.equal(out, null);
      assert.equal(rows(base).length, 0);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

for (const resumed of [false, true]) {
  test(`session start ${resumed ? "preserves explicit selection" : "does not inherit another session's task"}`, () => {
    const base = mkdtempSync(join(tmpdir(), "ccu-start-"));
    try {
      seedDeclared(base, resumed ? "sid" : "old-sid", "KI-123");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        const { sessionStart } = await import(${JSON.stringify(`file://${hooksModule}`)});
        process.stdout.write(JSON.stringify(sessionStart({session_id:"sid",cwd:${JSON.stringify(base)}})));
      `], { encoding: "utf8", env: { ...process.env,
        CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"),
        CC_USAGE_CONFIG_DIR: join(base, "config"), CC_USAGE_CONFIG_FILE: join(base, "config", "config.json"),
        CC_USAGE_BIN_DIR: join(base, "bin"), CC_USAGE_NO_AUTOUPDATE: "1", CODEX_THREAD_ID: "",
        CC_JIRA: resumed ? "BI-456" : "", CC_EPIC: "", CC_USAGE_PROJECT: "",
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(rows(base).filter((r) => r.jira).length, 1);
      assert.equal(rows(base)[0].jira, "KI-123");
      assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /not evidence/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
