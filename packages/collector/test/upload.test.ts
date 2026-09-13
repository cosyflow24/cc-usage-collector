import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUntaggedPolicy, httpUpload, withoutUntagged } from "../src/upload.ts";
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

test("httpUpload: a session with NO readable account is not reported as 'non-work'", async () => {
  // `unknown-<provider>-account` fails isWorkAccount() exactly like a private
  // address does, so it was counted into the same bucket and reported as
  // "non-work accounts kept local" — a reassurance that is FALSE here. Those are
  // WORK sessions being lost, and this line was their only user-visible trace.
  const result: AnalysisResult = {
    user: "dev@nnb24.de",
    range: { since: "2026-07-13", until: "2026-07-14" },
    sessions: [
      { ...session, user: "unknown-claude-account", sessionId: "s-unknown" },
      { ...session, user: "someone@gmail.com", sessionId: "s-private" },
      { ...session, user: "dev@nnb24.de", sessionId: "s-work" },
    ],
    daily: [],
    modelUsage: [],
    totals,
    notionalCostUsd: 0.3,
    hasUnpricedCodex: false,
  };

  const sent: string[] = [];
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_u: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).user as string);
    return { ok: true, status: 200, text: async () => "", json: async () => ({ sessions: 1, daily: 0 }) };
  };
  const err: string[] = [];
  const prevWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (c: string) => { err.push(String(c)); return true; };
  try {
    await httpUpload(result, { url: "http://ingest.test/api/ingest", token: "t" });
  } finally {
    (globalThis as { fetch: unknown }).fetch = prevFetch;
    (process.stderr as { write: unknown }).write = prevWrite;
  }

  assert.deepEqual(sent, ["dev@nnb24.de"], "only the work account may leave the machine");
  const all = err.join("");
  assert.match(all, /1 session\(s\) on non-work accounts kept local/,
    "the gmail one is a privacy skip and keeps that wording");
  assert.match(all, /1 session\(s\) had NO readable account/,
    "the unknown one must be counted and reported SEPARATELY");
  assert.match(all, /This is not a privacy skip/,
    "and must say plainly that it is not the same thing");
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

test("httpUpload sends the collector version header only when it has one", async () => {
  const seen: (string | null)[] = [];
  const prev = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_u: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers["x-cc-usage-version"] ?? null);
    return new Response(JSON.stringify({ sessions: 1, daily: 0 }), { status: 200 });
  };
  try {
    const result = {
      user: "dev@nnb24.de",
      range: { since: "2026-07-13T00:00:00Z", until: "2026-07-14T00:00:00Z" },
      sessions: [session],
      daily: [],
    } as unknown as AnalysisResult;
    await httpUpload(result, { url: "http://127.0.0.1:9/ingest", token: "t", version: "0.9.1" });
    await httpUpload(result, { url: "http://127.0.0.1:9/ingest", token: "t" });
  } finally {
    (globalThis as { fetch: unknown }).fetch = prev;
  }
  assert.deepEqual(seen, ["0.9.1", null]);
});

test("withoutUntagged drops untagged sessions and the days left with none", () => {
  // Distinct active times on purpose: analyze() sums a day's sessions into the
  // daily row, so the mixed day's 1.25h is 0.5h tagged + 0.75h untagged. If the
  // kept row were passed through unchanged, the withheld 0.75h would still be
  // derivable as daily - sum(sessions) - and an assertion against a daily row
  // that happened to equal the session would not notice.
  const tagged = { ...session, sessionId: "s-tagged", jiraKey: "BI-1", day: "2026-07-13", activeTimeHours: 0.5 };
  // TWO kept sessions on the mixed day: with only one, a recompute that took
  // the first kept session's values instead of summing them would still pass.
  const tagged2 = { ...session, sessionId: "s-tagged2", jiraKey: "BI-2", day: "2026-07-13", activeTimeHours: 0.25 };
  const untaggedSameDay = { ...session, sessionId: "s-mixed", jiraKey: null, day: "2026-07-13", activeTimeHours: 0.75 };
  const untaggedOwnDay = { ...session, sessionId: "s-alone", jiraKey: null, day: "2026-07-14", activeTimeHours: 2 };
  const daily = (day: string, activeTimeHours: number, sessions: number) => ({
    day,
    user: "dev@nnb24.de",
    sessions,
    modelUsage: [
      ...session.modelUsage,
      { provider: "claude" as const, model: "withheld-model", ...totals, costUsd: 9, costAvailable: true },
    ],
    totals: { ...totals, totalTokens: 999 },
    notionalCostUsd: 99,
    activeTimeHours,
  });
  const result = {
    user: "dev@nnb24.de",
    range: { since: "2026-07-13T00:00:00Z", until: "2026-07-15T00:00:00Z" },
    sessions: [tagged, tagged2, untaggedSameDay, untaggedOwnDay],
    daily: [daily("2026-07-13", 1.25, 3), daily("2026-07-14", 2, 1)],
  } as unknown as AnalysisResult;

  const filtered = withoutUntagged(result);
  assert.deepEqual(filtered.sessions.map((s) => s.sessionId), ["s-tagged", "s-tagged2"]);
  assert.deepEqual(
    filtered.daily.map((d) => d.day),
    ["2026-07-13"],
    "the day that held only untagged work goes with it; the mixed day stays",
  );
  // The kept day must NOT carry the withheld session's minutes: the server
  // takes active time from the daily row as sent, so `daily - sum(sessions)`
  // would publish exactly the time this option withholds.
  const kept = filtered.daily[0]!;
  assert.equal(kept.activeTimeHours, 0.75, "active time = 0.5 + 0.25, not the day's 1.25");
  assert.equal(kept.sessions, 2, "session count is recomputed, not the day's 3");
  assert.equal(kept.totals.totalTokens, tagged.totals.totalTokens * 2, "tokens come from the kept sessions");
  assert.equal(kept.notionalCostUsd, tagged.notionalCostUsd * 2, "cost comes from the kept sessions");
  assert.deepEqual(
    kept.modelUsage.map((m) => m.model).sort(),
    ["claude-sonnet-4"],
    "the withheld session's model is not listed",
  );
  assert.equal(result.sessions.length, 4, "the input is not mutated");
  assert.equal(result.daily[0]?.activeTimeHours, 1.25, "the input daily row is not mutated");
});

test("withoutUntagged is a no-op when every session carries a key", () => {
  const result = {
    user: "dev@nnb24.de",
    range: { since: "2026-07-13T00:00:00Z", until: "2026-07-14T00:00:00Z" },
    sessions: [{ ...session, jiraKey: "BI-1" }],
    daily: [{
      day: "2026-07-13",
      user: "dev@nnb24.de",
      sessions: 1,
      modelUsage: [...session.modelUsage],
      totals,
      notionalCostUsd: 0.1,
      activeTimeHours: 0.5,
    }],
  } as unknown as AnalysisResult;
  const filtered = withoutUntagged(result);
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.daily.length, 1);
});

test("an empty jira key counts as untagged, not as a key", () => {
  const result = {
    user: "dev@nnb24.de",
    range: { since: "2026-07-13T00:00:00Z", until: "2026-07-14T00:00:00Z" },
    sessions: [{ ...session, sessionId: "s-empty", jiraKey: "" }],
    daily: [{
      day: "2026-07-13",
      user: "dev@nnb24.de",
      sessions: 1,
      modelUsage: [...session.modelUsage],
      totals,
      notionalCostUsd: 0.1,
      activeTimeHours: 0.5,
    }],
  } as unknown as AnalysisResult;
  const filtered = withoutUntagged(result);
  assert.equal(filtered.sessions.length, 0);
  assert.equal(filtered.daily.length, 0);
});

test("the upload policy reads the env var, and only \"0\" opts out", () => {
  // The CLI wiring is the whole enforcement point of the setting, so the
  // decision lives in a function and is tested rather than trusted.
  function one(jiraKey: string | null): AnalysisResult {
    return {
      user: "dev@nnb24.de",
      range: { since: "2026-07-13T00:00:00Z", until: "2026-07-14T00:00:00Z" },
      sessions: [{ ...session, jiraKey }],
      daily: [{
        day: "2026-07-13",
        user: "dev@nnb24.de",
        sessions: 1,
        modelUsage: [...session.modelUsage],
        totals,
        notionalCostUsd: 0.1,
        activeTimeHours: 0.5,
      }],
    } as unknown as AnalysisResult;
  }
  const prev = process.env.CC_USAGE_UPLOAD_UNTAGGED;
  try {
    const cases: [string | undefined, number][] = [["0", 0], ["1", 1], [undefined, 1], ["false", 1]];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.CC_USAGE_UPLOAD_UNTAGGED;
      else process.env.CC_USAGE_UPLOAD_UNTAGGED = value;
      assert.equal(
        applyUntaggedPolicy(one(null)).sessions.length,
        expected,
        `CC_USAGE_UPLOAD_UNTAGGED=${String(value)}`,
      );
    }
    process.env.CC_USAGE_UPLOAD_UNTAGGED = "0";
    assert.equal(applyUntaggedPolicy(one("BI-1")).sessions.length, 1, "a tagged session always uploads");
  } finally {
    if (prev === undefined) delete process.env.CC_USAGE_UPLOAD_UNTAGGED;
    else process.env.CC_USAGE_UPLOAD_UNTAGGED = prev;
  }
});
