import assert from "node:assert/strict";
import { test } from "node:test";
import { httpUpload } from "../src/upload.ts";
import type { AnalysisResult, SessionSummary, TokenTotals } from "../src/types.ts";

const totals: TokenTotals = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 15,
};

const session: SessionSummary = {
  sessionId: "s1",
  user: "dev@nnb24.de", // work domain → passes the upload gate
  project: "proj",
  gitBranch: "main",
  jiraKey: null,
  epicKey: null,
  epicSummary: null,
  day: "2026-07-13",
  messageCount: 3,
  models: ["claude-sonnet-4"],
  modelUsage: [{ model: "claude-sonnet-4", ...totals, costUsd: 0.1 }],
  totals,
  notionalCostUsd: 0.1,
  activeTimeHours: 0.5,
};

test("httpUpload: wire payload is an explicit projection — fields outside the ingest contract never ship", async () => {
  // Simulate a future refactor accidentally attaching content to the in-memory
  // objects. The wire projection must strip it.
  const leakySession = { ...session, content: "SECRET PROMPT" } as unknown as SessionSummary;
  const result: AnalysisResult = {
    user: "dev@nnb24.de",
    range: { since: "2026-07-13T00:00:00Z", until: "2026-07-14T00:00:00Z" },
    sessions: [leakySession],
    daily: [
      {
        day: "2026-07-13",
        user: "dev@nnb24.de",
        sessions: 1,
        modelUsage: [{ model: "claude-sonnet-4", ...totals, costUsd: 0.1, secret: "x" } as never],
        totals,
        notionalCostUsd: 0.1,
        activeTimeHours: 0.5,
      },
    ],
    modelUsage: [],
    totals,
    notionalCostUsd: 0.1,
  };

  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ sessions: 1, daily: 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await httpUpload(result, { url: "http://ingest.test/api/ingest", token: "t" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(bodies.length, 1);
  assert.ok(!bodies[0]!.includes("SECRET"), "smuggled session field must not cross the wire");
  assert.ok(!bodies[0]!.includes("secret"), "smuggled nested field must not cross the wire");
  const wire = JSON.parse(bodies[0]!) as { sessions: Record<string, unknown>[] };
  assert.deepEqual(
    Object.keys(wire.sessions[0]!).sort(),
    [
      "activeTimeHours", "day", "epicKey", "epicSummary", "gitBranch", "jiraKey",
      "messageCount", "modelUsage", "models", "notionalCostUsd", "project",
      "sessionId", "totals", "user",
    ],
  );
});
