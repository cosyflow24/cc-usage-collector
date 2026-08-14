import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readCodexRecords } from "../src/codex-parser.ts";

const SINCE = new Date("2026-08-14T09:00:00Z");
const UNTIL = new Date("2026-08-14T11:00:00Z");

function writeRollout(lines: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-codex-parser-"));
  const nested = path.join(dir, "2026", "08", "14");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    path.join(nested, "rollout-test.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return dir;
}

function row(timestamp: string, type: string, payload: unknown): unknown {
  return { timestamp, type, payload };
}

test("readCodexRecords: converts cumulative snapshots to non-overlapping token deltas", async () => {
  const dir = writeRollout([
    row("2026-08-14T10:00:00Z", "session_meta", {
      id: "codex-child",
      session_id: "codex-root",
      parent_thread_id: "codex-root",
      cwd: "/work/app",
      agent_role: "worker",
    }),
    row("2026-08-14T10:00:01Z", "turn_context", {
      model: "gpt-5.6-sol",
      cwd: "/work/app",
    }),
    row("2026-08-14T10:00:02Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }),
    row("2026-08-14T10:00:03Z", "response_item", {
      type: "function_call",
      call_id: "call-1",
      name: "exec_command",
    }),
    row("2026-08-14T10:00:04Z", "response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: "ok",
    }),
    row("2026-08-14T10:00:05Z", "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 3,
          total_tokens: 110,
        },
      },
    }),
    row("2026-08-14T10:00:06Z", "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 150,
          cached_input_tokens: 60,
          cache_write_input_tokens: 10,
          output_tokens: 18,
          reasoning_output_tokens: 5,
          total_tokens: 168,
        },
      },
    }),
  ]);

  const records = await readCodexRecords(SINCE, UNTIL, dir);
  assert.deepEqual([...new Set(records.map((r) => r.provider))], ["codex"]);
  assert.deepEqual([...new Set(records.map((r) => r.sessionId))], ["codex-child"]);
  assert.deepEqual([...new Set(records.map((r) => r.rootSessionId))], ["codex-root"]);
  assert.deepEqual([...new Set(records.map((r) => r.parentSessionId))], ["codex-root"]);
  assert.deepEqual([...new Set(records.map((r) => r.agentRole))], ["worker"]);
  assert.deepEqual(records.map((r) => r.kind), ["prompt", "tool_use", "tool_result", "answer", "answer"]);

  assert.equal(records.reduce((sum, r) => sum + r.inputTokens, 0), 80);
  assert.equal(records.reduce((sum, r) => sum + r.cacheReadTokens, 0), 60);
  assert.equal(records.reduce((sum, r) => sum + r.cacheCreationTokens, 0), 10);
  assert.equal(records.reduce((sum, r) => sum + r.outputTokens, 0), 18);
  assert.equal(
    records.reduce(
      (sum, r) => sum + r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens,
      0,
    ),
    168,
  );
});

test("readCodexRecords: ignores malformed/decreasing snapshots instead of subtracting usage", async () => {
  const dir = writeRollout([
    row("2026-08-14T10:00:00Z", "session_meta", { id: "s1", cwd: "/work/app" }),
    row("2026-08-14T10:00:01Z", "turn_context", { model: "gpt-5.6-sol" }),
    row("2026-08-14T10:00:02Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 } },
    }),
    row("2026-08-14T10:00:03Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 } },
    }),
    row("2026-08-14T10:00:04Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: "bad", output_tokens: -1 } },
    }),
  ]);
  const records = await readCodexRecords(SINCE, UNTIL, dir);
  assert.equal(records.length, 1);
  assert.deepEqual(
    records[0] && {
      input: records[0].inputTokens,
      cache: records[0].cacheReadTokens,
      output: records[0].outputTokens,
    },
    { input: 15, cache: 5, output: 4 },
  );
});
