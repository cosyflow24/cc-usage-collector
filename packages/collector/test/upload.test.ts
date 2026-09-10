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
  provider: "claude",
  sessionId: "s1",
  parentSessionId: null,
  rootSessionId: "s1",
  agentRole: null,
  user: "dev@nnb24.de", // work domain → passes the upload gate
  project: "proj",
  gitBranch: "main",
  jiraKey: null,
  epicKey: null,
  epicSummary: null,
  day: "2026-07-13",
  messageCount: 3,
  models: ["claude-sonnet-4"],
  modelUsage: [{
    provider: "claude",
    model: "claude-sonnet-4",
    ...totals,
    costUsd: 0.1,
    costAvailable: true,
  }],
  totals,
  notionalCostUsd: 0.1,
  costAvailable: true,
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
        modelUsage: [{
          provider: "claude",
          model: "claude-sonnet-4",
          ...totals,
          costUsd: 0.1,
          costAvailable: true,
          secret: "x",
        } as never],
        totals,
        notionalCostUsd: 0.1,
        hasUnpricedCodex: false,
        activeTimeHours: 0.5,
      },
    ],
    modelUsage: [],
    totals,
    notionalCostUsd: 0.1,
    hasUnpricedCodex: false,
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
      "activeTimeHours", "agentRole", "day", "epicKey", "epicSummary", "gitBranch", "jiraKey",
      "messageCount", "modelUsage", "models", "notionalCostUsd", "parentSessionId",
      "project", "provider", "rootSessionId", "sessionId", "totals", "user",
    ],
  );
});

test("httpUpload: one account's server error does not cost the others their upload", async () => {
  // The shared-account trigger surfaces as HTTP 500 from an older ingest build.
  // Throwing on the first bad bucket aborted the whole run, so every account
  // after it went unsent — and with no retry queue, anything outside the next
  // run's --days window then needed a manual re-upload.
  const attempted: string[] = [];
  const result: AnalysisResult = {
    user: "dev@nnb24.de",
    range: { since: "2026-07-13", until: "2026-07-14" },
    sessions: [
      { ...session, user: "shared@nnb24.de", sessionId: "s-shared" },
      { ...session, user: "dev@nnb24.de", sessionId: "s-dev" },
    ],
    daily: [],
    modelUsage: [],
    totals,
    notionalCostUsd: 0.2,
    hasUnpricedCodex: false,
  };

  const fetchImpl = async (_url: string, init: { body: string }) => {
    const who = JSON.parse(init.body).user as string;
    attempted.push(who);
    return who === "shared@nnb24.de"
      ? { ok: false, status: 500, text: async () => "upsert failed", json: async () => ({}) }
      : { ok: true, status: 200, text: async () => "", json: async () => ({ sessions: 1, daily: 0 }) };
  };

  const prev = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchImpl;
  let threw: string | null = null;
  try {
    await httpUpload(result, { url: "http://ingest.test/api/ingest", token: "t" });
  } catch (e) {
    threw = (e as Error).message;
  } finally {
    (globalThis as { fetch: unknown }).fetch = prev;
  }

  assert.ok(
    attempted.includes("dev@nnb24.de"),
    `the healthy account must still be uploaded; only attempted: ${attempted.join(", ")}`,
  );
  assert.ok(threw, "the run must still fail, or a real outage looks like success");
  assert.match(threw ?? "", /shared@nnb24\.de \(500\)/);
});
