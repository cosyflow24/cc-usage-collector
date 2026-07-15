import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readRecords } from "../src/parser.ts";

const SINCE = new Date("2026-07-13T00:00:00Z");
const UNTIL = new Date("2026-07-14T00:00:00Z");

let n = 0;
function writeLogDir(lines: unknown[]): string {
  // readRecords walks a projects dir recursively — give it dir/proj/log.jsonl.
  const dir = mkdtempSync(path.join(tmpdir(), "cc-parser-"));
  const proj = path.join(dir, `proj-${n++}`);
  mkdirSync(proj);
  writeFileSync(
    path.join(proj, "log.jsonl"),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return dir;
}

function line(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-07-13T10:00:00Z",
    sessionId: "s1",
    type: "assistant",
    requestId: "r1",
    message: {
      id: "m1",
      model: "claude-sonnet-4",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    ...over,
  };
}

test("readRecords: corrupt line is skipped, valid lines around it still parse", async () => {
  const dir = writeLogDir([
    line({ message: { id: "m1", usage: { input_tokens: 10 } } }),
    "{this is not json",
    line({ message: { id: "m2", usage: { input_tokens: 7 } } }),
  ]);
  const recs = await readRecords(SINCE, UNTIL, dir);
  assert.equal(recs.length, 2);
});

test("readRecords: a giant line (>1MB) is skipped, does not abort the file", async () => {
  // Valid JSON, but oversized — must be dropped before JSON.parse.
  const giant = JSON.stringify(line({ pad: "x".repeat(1_100_000) }));
  const dir = writeLogDir([giant, line({ message: { id: "m2", usage: {} } })]);
  const recs = await readRecords(SINCE, UNTIL, dir);
  assert.equal(recs.length, 1);
});

test("readRecords: negative token counts are clamped to 0", async () => {
  const dir = writeLogDir([
    line({
      message: {
        id: "m1",
        usage: { input_tokens: -50, output_tokens: 5, cache_read_input_tokens: -1 },
      },
    }),
  ]);
  const recs = await readRecords(SINCE, UNTIL, dir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.inputTokens, 0);
  assert.equal(recs[0]!.outputTokens, 5);
  assert.equal(recs[0]!.cacheReadTokens, 0);
});

test("readRecords: duplicate message id (same requestId) counts once", async () => {
  const dir = writeLogDir([
    line(), // m1|r1
    line({ timestamp: "2026-07-13T10:00:05Z" }), // m1|r1 again (streaming re-log) → dropped
    line({ message: { id: "m2", usage: { input_tokens: 3 } } }), // distinct id → kept
  ]);
  const recs = await readRecords(SINCE, UNTIL, dir);
  assert.equal(recs.length, 2);
  assert.equal(recs.reduce((a, r) => a + r.inputTokens, 0), 13);
});
