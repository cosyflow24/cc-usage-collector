import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findSessions, renderContext } from "../cc-usage/tools/core/context.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccu-context-"));
  const claude = join(root, "claude-projects", "app");
  const codex = join(root, "codex-sessions", "2026", "08", "14");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const taskFile = join(root, "tasks.jsonl");
  writeFileSync(taskFile, [
    JSON.stringify({ sessionId: "claude-1", jira: "BI-220", cwd: "/work/app", ts: "2026-08-14T09:00:00Z" }),
    JSON.stringify({ provider: "codex", sessionId: "codex-1", jira: "BI-220", cwd: "/work/app", ts: "2026-08-14T10:00:00Z" }),
  ].join("\n") + "\n");
  writeFileSync(join(claude, "claude-1.jsonl"), [
    JSON.stringify({ timestamp: "2026-08-14T09:00:00Z", sessionId: "claude-1", cwd: "/work/app", type: "user", message: { content: "Claude question" } }),
    JSON.stringify({ timestamp: "2026-08-14T09:00:01Z", sessionId: "claude-1", cwd: "/work/app", type: "assistant", message: { content: [{ type: "text", text: "Claude answer" }] } }),
  ].join("\n") + "\n");
  writeFileSync(join(codex, "rollout-codex-1.jsonl"), [
    JSON.stringify({ timestamp: "2026-08-14T10:00:00Z", type: "session_meta", payload: { id: "codex-1", session_id: "codex-1", cwd: "/work/app" } }),
    JSON.stringify({ timestamp: "2026-08-14T10:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "HIDDEN SYSTEM" }] } }),
    JSON.stringify({ timestamp: "2026-08-14T10:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex question" }] } }),
    JSON.stringify({ timestamp: "2026-08-14T10:00:03Z", type: "response_item", payload: { type: "function_call_output", output: "SECRET TOOL OUTPUT" } }),
    JSON.stringify({ timestamp: "2026-08-14T10:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex answer" }] } }),
  ].join("\n") + "\n");
  return { root, claude, codex, taskFile };
}

test("findSessions resolves one Jira task across Claude and Codex", async () => {
  const f = fixture();
  try {
    const found = await findSessions("BI-220", {
      claudeProjectsDir: f.claude,
      codexSessionsDir: f.codex,
      tasksFile: f.taskFile,
    });
    assert.deepEqual(found.map((s) => `${s.provider}:${s.sessionId}`).sort(), [
      "claude:claude-1",
      "codex:codex-1",
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("renderContext returns local user/assistant context without system or tool payloads", async () => {
  const f = fixture();
  try {
    const text = await renderContext("BI-220", {
      claudeProjectsDir: f.claude,
      codexSessionsDir: f.codex,
      tasksFile: f.taskFile,
      maxChars: 20_000,
    });
    assert.match(text, /Claude question/);
    assert.match(text, /Claude answer/);
    assert.match(text, /Codex question/);
    assert.match(text, /Codex answer/);
    assert.doesNotMatch(text, /HIDDEN SYSTEM/);
    assert.doesNotMatch(text, /SECRET TOOL OUTPUT/);
    assert.match(text, /codex:codex-1/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
