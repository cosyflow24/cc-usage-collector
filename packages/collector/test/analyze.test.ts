import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/analyze.ts";
import type { UsageRecord } from "../src/types.ts";

// Timestamps deliberately have NO timezone suffix → parsed as LOCAL time, so
// localDay() buckets them deterministically regardless of the machine's TZ.
function rec(sessionId: string, iso: string): UsageRecord {
  return {
    sessionId,
    timestamp: new Date(iso),
    model: "claude-sonnet-4",
    cwd: "/w/proj",
    gitBranch: null,
    dedupeKey: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    kind: "prompt",
  };
}

test("daily rollup is per (user, day) — a mixed-account day never lumps under the first session's account", () => {
  // Two sessions on the SAME local day, each signed into a different account
  // (per-session attribution via sessionAccounts). 9 events at 4-min intervals
  // per session → each contributes 32 min of raw active time.
  const records: UsageRecord[] = [];
  for (let i = 0; i < 9; i++) {
    const mm = String(i * 4).padStart(2, "0");
    records.push(rec("s-work", `2026-07-13T10:${mm}:00`));
    records.push(rec("s-personal", `2026-07-13T14:${mm}:00`));
  }

  const result = analyze(records, {
    user: "work@nnb24.de",
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false }, // no git side effects in tests
    sessionAccounts: new Map([
      ["s-work", { account: "work@nnb24.de" }],
      ["s-personal", { account: "me@personal.dev" }],
    ]),
  });

  // One daily row PER account, not one for the day.
  assert.equal(result.daily.length, 2);
  assert.deepEqual(
    result.daily.map((d) => d.user).sort(),
    ["me@personal.dev", "work@nnb24.de"],
  );
  for (const d of result.daily) {
    assert.equal(d.day, "2026-07-13");
    assert.equal(d.sessions, 1);
    // Tokens split per account: 9 records × (10 in + 5 out) each.
    assert.equal(d.totals.inputTokens, 90);
    assert.equal(d.totals.outputTokens, 45);
    // Invariant: Σ(a user's session hours of a day) == that user's daily hours.
    const userSessions = result.sessions.filter((s) => s.user === d.user && s.day === d.day);
    const sum = userSessions.reduce((a, s) => a + s.activeTimeHours, 0);
    assert.equal(d.activeTimeHours, sum);
    // The day-timeline merge apportions the machine day (1.0h coarse) evenly:
    // both sessions have identical raw active (32 min) → 0.5h each.
    assert.equal(d.activeTimeHours, 0.5);
  }
});
