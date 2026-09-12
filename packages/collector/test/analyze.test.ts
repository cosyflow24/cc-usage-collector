import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { analyze } from "../src/analyze.ts";
import { isWorkAccount } from "../src/config.ts";
import { formatTable } from "../src/format.ts";
import { loadSessionAccounts } from "../src/sidecar.ts";
import type { UsageRecord } from "../src/types.ts";

// Timestamps deliberately have NO timezone suffix → parsed as LOCAL time, so
// localDay() buckets them deterministically regardless of the machine's TZ.
function rec(sessionId: string, iso: string): UsageRecord {
  return {
    provider: "claude",
    sessionId,
    parentSessionId: null,
    rootSessionId: sessionId,
    agentRole: null,
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

test("provider is part of session identity and daily usage stays unified", () => {
  const claude = rec("same-id", "2026-07-13T10:00:00");
  const codex: UsageRecord = {
    ...rec("same-id", "2026-07-13T10:01:00"),
    provider: "codex",
    model: "gpt-5.6-sol",
    inputTokens: 20,
    outputTokens: 7,
  };
  const result = analyze([claude, codex], {
    user: "work@nnb24.de",
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionTasks: new Map([
      ["claude:same-id", { jira: "BI-1" }],
      ["codex:same-id", { jira: "BI-2" }],
    ]),
  });

  assert.equal(result.sessions.length, 2);
  assert.deepEqual(
    result.sessions.map((s) => `${s.provider}:${s.sessionId}:${s.jiraKey}`).sort(),
    ["claude:same-id:BI-1", "codex:same-id:BI-2"],
  );
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0]!.sessions, 2);
  assert.equal(result.daily[0]!.totals.totalTokens, 42);
  assert.equal(result.daily[0]!.hasUnpricedCodex, true);
  assert.equal(result.hasUnpricedCodex, true);
  assert.equal(result.modelUsage.find((m) => m.provider === "codex")?.costAvailable, false);
  assert.match(formatTable(result), /Claude-only|—/);
  assert.doesNotMatch(formatTable(result), /gpt-5\.6-sol\s+\$0\.00/);
});

test("provider-specific account fallback does not assign Codex to Claude", () => {
  const claude = rec("claude-id", "2026-07-13T10:00:00");
  const codex: UsageRecord = {
    ...rec("codex-id", "2026-07-13T10:01:00"),
    provider: "codex",
    model: "gpt-5.6-sol",
  };
  const result = analyze([claude, codex], {
    user: "fallback@nnb24.de",
    providerUsers: {
      claude: "claude@nnb24.de",
      codex: "codex@personal.dev",
    },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
  });
  assert.deepEqual(
    result.sessions.map((session) => `${session.provider}:${session.user}`).sort(),
    ["claude:claude@nnb24.de", "codex:codex@personal.dev"],
  );
});

test("missing CLAUDE identity fails closed too, instead of borrowing the enrolled work email", () => {
  // The asymmetry this pins: Codex already failed closed, Claude did not.
  // cli.ts used `resolveAccountEmail() ?? user`, and `user` is resolveUser(),
  // which returns CC_USAGE_USER — injected by the launcher as the ENROLLED WORK
  // EMAIL. So a session whose real account could not be read was labelled with
  // the work address, passed the work-domain gate, and uploaded, whatever
  // account actually produced it. `user` here is deliberately a work address:
  // the test is worthless if the fallback would have been rejected anyway.
  const claude = rec("claude-id", "2026-07-13T10:00:00");
  const result = analyze([claude], {
    user: "enrolled@nnb24.de",
    providerUsers: { claude: null, codex: null },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(
    result.sessions[0]!.user, "unknown-claude-account",
    "an unreadable account must stay unknown, never become the enrolled work email",
  );
  assert.equal(
    isWorkAccount(result.sessions[0]!.user), false,
    "and the work-domain gate must therefore drop it",
  );
});

test("an explicit --user wins over the fail-closed default (but not over a sidecar)", () => {
  // `--user` is a human declaration, not a guess. cli.ts passes
  // { claude: user, codex: user } in that case; this pins that it still works.
  // It does NOT outrank a session-scoped sidecar account — analyze() resolves
  // trustedScopedAccount first — and the second half of this test pins that,
  // because the comment in cli.ts used to claim otherwise.
  const claude = rec("claude-id", "2026-07-13T10:00:00");
  const result = analyze([claude], {
    user: "declared@nnb24.de",
    providerUsers: { claude: "declared@nnb24.de", codex: "declared@nnb24.de" },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
  });
  assert.equal(result.sessions[0]!.user, "declared@nnb24.de");

  const withSidecar = analyze([claude], {
    user: "declared@nnb24.de",
    providerUsers: { claude: "declared@nnb24.de", codex: "declared@nnb24.de" },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionAccounts: new Map([
      ["claude:claude-id", [{ account: "actually@nnb24.de", providerVerified: true }]],
    ]),
  });
  assert.equal(
    withSidecar.sessions[0]!.user, "actually@nnb24.de",
    "the account observed DURING the session outranks --user",
  );
});

test("missing Codex identity fails closed instead of borrowing the Claude account", () => {
  const codex: UsageRecord = {
    ...rec("codex-id", "2026-07-13T10:01:00"),
    provider: "codex",
    model: "gpt-5.6-sol",
  };
  const result = analyze([codex], {
    user: "claude@nnb24.de",
    providerUsers: { claude: "claude@nnb24.de", codex: null },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    // Bare legacy rows and pre-fix provider-scoped rows both belong to Claude.
    sessionAccounts: new Map([
      ["codex-id", [{ account: "claude@nnb24.de" }]],
      ["codex:codex-id", [{ account: "claude@nnb24.de" }]],
    ]),
  });
  assert.equal(result.sessions[0]?.user, "unknown-codex-account");
});

test("verified historical Codex identity remains valid after the account signs out", () => {
  const codex: UsageRecord = {
    ...rec("codex-id", "2026-07-13T10:01:00"),
    provider: "codex",
    model: "gpt-5.6-sol",
  };
  const result = analyze([codex], {
    user: "claude@nnb24.de",
    providerUsers: { claude: "claude@nnb24.de", codex: null },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionAccounts: new Map([[
      "codex:codex-id",
      [{ account: "codex@nnb24.de", providerVerified: true }],
    ]]),
  });
  assert.equal(result.sessions[0]?.user, "codex@nnb24.de");
});

test("sidecar identity source flows through loader into fail-closed analysis", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-usage-sidecar-"));
  const claudeDir = path.join(dir, "claude");
  const codexDir = path.join(dir, "codex");
  const file = path.join(claudeDir, "cc-usage", "tasks.jsonl");
  try {
    mkdirSync(path.join(claudeDir, "cc-usage"), { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      provider: "codex", sessionId: "old", account: "claude@nnb24.de",
      ts: "2026-07-13T09:00:00Z", src: "hook-acct",
    })}\n`);
    const jwt = `header.${Buffer.from(JSON.stringify({ email: "codex@nnb24.de" })).toString("base64url")}.sig`;
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({ tokens: { id_token: jwt } }),
    );
    const hookModule = new URL("../../../cc-usage/tools/core/hooks.mjs", import.meta.url).href;
    const captured = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { sessionStart } = await import(${JSON.stringify(hookModule)});
      sessionStart({ session_id: "verified", cwd: "/work" });
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "1",
        CC_USAGE_NO_AUTOUPDATE: "1",
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: codexDir,
        CODEX_THREAD_ID: "verified",
        // SessionStart schedules a DETACHED open-issue refresh. Unpinned, this
        // test found the developer's real nnb-jira on PATH and fired a live
        // query at the company Jira, leaving a stray child behind every run.
        CC_USAGE_NNB_JIRA_BIN: "/nonexistent/nnb-jira",
        CC_USAGE_NO_ISSUE_CACHE: "1",
      },
    });
    assert.equal(captured.status, 0, captured.stderr);
    const sessionAccounts = loadSessionAccounts(file);
    const records: UsageRecord[] = [
      { ...rec("old", "2026-07-13T10:00:00"), provider: "codex", model: "gpt-5.6-sol" },
      { ...rec("verified", "2026-07-13T10:01:00"), provider: "codex", model: "gpt-5.6-sol" },
    ];
    const result = analyze(records, {
      user: "claude@nnb24.de",
      providerUsers: { claude: "claude@nnb24.de", codex: null },
      since: new Date("2026-07-13T00:00:00"),
      until: new Date("2026-07-14T00:00:00"),
      idleGapMs: 30 * 60_000,
      jira: { scanCommits: false },
      sessionAccounts,
    });
    assert.deepEqual(
      result.sessions.map((session) => `${session.sessionId}:${session.user}`).sort(),
      ["old:unknown-codex-account", "verified:codex@nnb24.de"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      ["s-work", [{ account: "work@nnb24.de" }]],
      ["s-personal", [{ account: "me@personal.dev" }]],
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

// A session that switches accounts mid-flight must be SPLIT, not re-labelled.
//
// Re-labelling the whole session is worse than the bug it replaced: the first
// account has already uploaded the session's running total, so moving the grown
// total to the second account leaves BOTH rows in the database and every period
// rollup counts the work twice.
test("a mid-session account switch splits the session instead of moving all of it", () => {
  const before = rec("s-switch", "2026-07-13T10:00:00");
  const after = { ...rec("s-switch", "2026-07-13T12:00:00"), inputTokens: 100, outputTokens: 50 };
  const result = analyze([before, after], {
    user: "old@nnb24.de",
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionAccounts: new Map([[
      "claude:s-switch",
      [
        { account: "old@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() },
        { account: "new@nnb24.de", ts: new Date("2026-07-13T11:00:00").toISOString() },
      ],
    ]]),
  });

  const users = result.sessions.map((s) => s.user).sort();
  assert.deepEqual(users, ["new@nnb24.de", "old@nnb24.de"], "one summary per account");
  assert.equal(result.sessions.length, 2);

  // Each segment carries only ITS OWN records — the whole point. Summing the
  // segments must equal the session's real usage, never more.
  const old = result.sessions.find((s) => s.user === "old@nnb24.de")!;
  const fresh = result.sessions.find((s) => s.user === "new@nnb24.de")!;
  assert.equal(old.totals.inputTokens, 10);
  assert.equal(fresh.totals.inputTokens, 100);
  assert.equal(
    old.totals.totalTokens + fresh.totals.totalTokens,
    (10 + 5) + (100 + 50),
    "segments must sum to the session's real usage, not double it",
  );

  // Daily rows follow the same split, so the period rollup cannot double-count.
  assert.equal(result.daily.length, 2);
  assert.deepEqual(result.daily.map((d) => d.user).sort(), ["new@nnb24.de", "old@nnb24.de"]);
});

test("a session that never switched stays a single summary", () => {
  const result = analyze([rec("s-stable", "2026-07-13T10:00:00")], {
    user: "only@nnb24.de",
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionAccounts: new Map([[
      "claude:s-stable",
      [{ account: "only@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() }],
    ]]),
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.user, "only@nnb24.de");
});

test("re-recording the same account does not split the session", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccu-tl-"));
  try {
    const file = path.join(dir, "tasks.jsonl");
    // The hook writes on change only, but a race or a restored backup can leave
    // duplicates. Two identical accounts are ONE segment, not two.
    writeFileSync(file, [
      JSON.stringify({ schemaVersion: 1, provider: "claude", sessionId: "s-dup", account: "a@nnb24.de", ts: "2026-07-13T09:00:00.000Z" }),
      JSON.stringify({ schemaVersion: 1, provider: "claude", sessionId: "s-dup", account: "a@nnb24.de", ts: "2026-07-13T10:00:00.000Z" }),
    ].join("\n"));
    const timeline = loadSessionAccounts(file).get("claude:s-dup");
    assert.equal(timeline?.length, 1, "identical consecutive accounts collapse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the account timeline is ordered by ts, not by file order", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccu-tl2-"));
  try {
    const file = path.join(dir, "tasks.jsonl");
    // Written out of order (clock adjustment / concurrent appends). The consumer
    // must still see the real sequence, or a switch is applied backwards.
    writeFileSync(file, [
      JSON.stringify({ schemaVersion: 1, provider: "claude", sessionId: "s-ooo", account: "second@nnb24.de", ts: "2026-07-13T11:00:00.000Z" }),
      JSON.stringify({ schemaVersion: 1, provider: "claude", sessionId: "s-ooo", account: "first@nnb24.de", ts: "2026-07-13T09:00:00.000Z" }),
    ].join("\n"));
    const timeline = loadSessionAccounts(file).get("claude:s-ooo");
    assert.deepEqual(timeline?.map((a) => a.account), ["first@nnb24.de", "second@nnb24.de"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Splitting a session must not multiply what the session actually consumed.
// Both of these were real: active time was keyed by session id, so each segment
// received the whole session's hours; and dropping ccusage's numbers pushed the
// segments onto pricing.ts, which resolves some dated model ids to a cheaper
// generation and understated cost roughly threefold.
const switchTimeline = new Map([[
  "claude:s-cost",
  [
    { account: "a@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() },
    { account: "b@nnb24.de", ts: new Date("2026-07-13T11:00:00").toISOString() },
  ],
]]);

function costRun(sessionAccounts: Map<string, { account: string; ts?: string }[]> | undefined) {
  // Two records per side of the switch, close enough together to produce active
  // time (a gap wider than idleGapMs counts as away and yields zero hours).
  const mk = (iso: string) => ({
    ...rec("s-cost", iso),
    model: "claude-opus-4-1-20250805",
    inputTokens: 500_000,
    outputTokens: 0,
  });
  const usage = {
    model: "claude-opus-4-1-20250805",
    provider: "claude" as const,
    inputTokens: 2_000_000,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 2_000_000,
    costUsd: 30,
    costAvailable: true,
  };
  return analyze(
    [
      mk("2026-07-13T10:00:00"), mk("2026-07-13T10:10:00"),   // account A
      mk("2026-07-13T11:10:00"), mk("2026-07-13T11:20:00"),   // account B
    ],
    {
    user: "a@nnb24.de",
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionAccounts,
    ccusageCost: new Map([["s-cost", {
      totalCostUsd: 30,
      totals: { inputTokens: 2_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 2_000_000 },
      models: [usage],
    }]]),
    },
  );
}

test("splitting a session preserves ccusage's authoritative cost", () => {
  const whole = costRun(undefined);
  const split = costRun(switchTimeline);

  assert.equal(whole.sessions.length, 1);
  assert.equal(split.sessions.length, 2);

  const wholeCost = whole.sessions.reduce((a, s) => a + s.notionalCostUsd, 0);
  const splitCost = split.sessions.reduce((a, s) => a + s.notionalCostUsd, 0);
  assert.equal(wholeCost, 30, "sanity: unsplit uses ccusage's number");
  assert.equal(
    splitCost, 30,
    "a split must apportion the authoritative cost, never re-price with the fallback table",
  );

  const wholeTokens = whole.sessions.reduce((a, s) => a + s.totals.totalTokens, 0);
  const splitTokens = split.sessions.reduce((a, s) => a + s.totals.totalTokens, 0);
  assert.equal(splitTokens, wholeTokens, "tokens must not change by splitting");
});

test("splitting a session does not multiply its active time", () => {
  const whole = costRun(undefined);
  const split = costRun(switchTimeline);

  const wholeHours = whole.sessions.reduce((a, s) => a + s.activeTimeHours, 0);
  const splitHours = split.sessions.reduce((a, s) => a + s.activeTimeHours, 0);
  assert.ok(wholeHours > 0, "sanity: the fixture has active time");
  assert.equal(
    splitHours, wholeHours,
    "segments must divide the session's hours, not each receive all of them",
  );

  // And the daily rollup must agree with the sum of its segments.
  const dailyHours = split.daily.reduce((a, d) => a + d.activeTimeHours, 0);
  assert.equal(dailyHours, splitHours);
});

test("collapsing repeats keeps the strongest identity evidence, not the first row", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccu-verify-"));
  try {
    const file = path.join(dir, "tasks.jsonl");
    // Codex recorded an unverified row first, then a verified one. Keeping only
    // the earlier row would send this segment down the fail-closed path and
    // attribute real usage to "unknown-codex-account".
    writeFileSync(file, [
      JSON.stringify({ schemaVersion: 1, provider: "codex", sessionId: "s-v", account: "c@nnb24.de", ts: "2026-07-13T09:00:00.000Z" }),
      JSON.stringify({ schemaVersion: 1, provider: "codex", sessionId: "s-v", account: "c@nnb24.de", identitySource: "codex-id-token", ts: "2026-07-13T09:30:00.000Z" }),
    ].join("\n"));
    const timeline = loadSessionAccounts(file).get("codex:s-v");
    assert.equal(timeline?.length, 1, "same account collapses to one segment");
    assert.equal(timeline?.[0]?.providerVerified, true, "verification must survive the collapse");
    assert.equal(timeline?.[0]?.ts, "2026-07-13T09:00:00.000Z", "segment still starts at the first row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two segments that resolve to the SAME identity keep their own hours", () => {
  // Both accounts are unverified Codex rows, so both segments resolve to
  // "unknown-codex-account". Keying segment bookkeeping by the resolved user
  // made the second overwrite the first.
  const mk = (iso: string): UsageRecord => ({
    ...rec("s-collide", iso),
    provider: "codex",
    model: "gpt-5.6-sol",
  });
  // Deliberately unequal segment durations: with equal ones a collision still
  // satisfies conservation by accident.
  const recs = [
    mk("2026-07-13T10:00:00"), mk("2026-07-13T10:10:00"), mk("2026-07-13T10:25:00"),
    mk("2026-07-13T11:10:00"), mk("2026-07-13T11:15:00"),
  ];
  const base = {
    user: "fallback@nnb24.de",
    providerUsers: { claude: "c@nnb24.de", codex: null },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
  };
  const whole = analyze(recs, base);
  const split = analyze(recs, {
    ...base,
    sessionAccounts: new Map([[
      "codex:s-collide",
      [
        { account: "x@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() },
        { account: "y@nnb24.de", ts: new Date("2026-07-13T11:00:00").toISOString() },
      ],
    ]]),
  });

  // Both segments resolve to one identity, and the server keys sessions by
  // (user_id, session_id) — so two rows there are ONE row, and the second upload
  // would overwrite the first. They must be merged locally instead.
  assert.equal(split.sessions.length, 1, "segments sharing an identity are merged, not sent twice");
  assert.equal(new Set(split.sessions.map((s) => s.user)).size, 1);

  // Compare against the UNSPLIT run, not against this run's own daily total.
  // On a collision the daily rollup is computed from the same clobbered grouping,
  // so it drops by exactly as much as the segments do and the two agree while
  // both are wrong — which is how the first version of this test passed.
  const wholeHours = whole.sessions.reduce((a, s) => a + s.activeTimeHours, 0);
  const splitHours = split.sessions.reduce((a, s) => a + s.activeTimeHours, 0);
  assert.ok(wholeHours > 0, "sanity: the fixture has active time");
  assert.equal(
    splitHours, wholeHours,
    "splitting must not lose hours when both segments resolve to the same identity",
  );
  // Tokens must survive the same way.
  assert.equal(
    split.sessions.reduce((a, s) => a + s.totals.totalTokens, 0),
    whole.sessions.reduce((a, s) => a + s.totals.totalTokens, 0),
  );
});

test("apportioning a split conserves the authoritative token count exactly", () => {
  // One token per field: rounding each segment independently turned 1 into 1+1.
  const mk = (iso: string): UsageRecord => ({
    ...rec("s-round", iso), model: "claude-sonnet-4", inputTokens: 1, outputTokens: 0,
  });
  const result = analyze(
    [mk("2026-07-13T10:00:00"), mk("2026-07-13T11:10:00")],
    {
      user: "a@nnb24.de",
      since: new Date("2026-07-13T00:00:00"),
      until: new Date("2026-07-14T00:00:00"),
      idleGapMs: 30 * 60_000,
      jira: { scanCommits: false },
      sessionAccounts: new Map([[
        "claude:s-round",
        [
          { account: "a@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() },
          { account: "b@nnb24.de", ts: new Date("2026-07-13T11:00:00").toISOString() },
        ],
      ]]),
      ccusageCost: new Map([["s-round", {
        totalCostUsd: 3,
        totals: { inputTokens: 3, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 4 },
        models: [{
          model: "claude-sonnet-4", provider: "claude" as const,
          inputTokens: 3, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0,
          totalTokens: 4, costUsd: 3, costAvailable: true,
        }],
      }]]),
    },
  );
  assert.equal(result.sessions.length, 2);
  const sum = (f: (s: (typeof result.sessions)[number]) => number) =>
    result.sessions.reduce((a, s) => a + f(s), 0);
  assert.equal(sum((s) => s.totals.inputTokens), 3, "input must sum to the authoritative 3");
  assert.equal(sum((s) => s.totals.outputTokens), 1, "output must sum to the authoritative 1");
  assert.equal(sum((s) => s.totals.totalTokens), 4);
  assert.equal(Math.round(sum((s) => s.notionalCostUsd) * 100) / 100, 3);
});

test("apportioning conserves across THREE segments, not just two", () => {
  // Two-segment conservation was satisfied by "last segment takes the
  // remainder". With three, flooring each share independently loses units:
  // three thirds of 2 floor to 0 + 0 + 1.
  const mk = (iso: string): UsageRecord => ({
    ...rec("s-three", iso), model: "claude-sonnet-4", inputTokens: 1, outputTokens: 1,
  });
  const at = (h: number, m: number) =>
    `2026-07-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const result = analyze(
    [mk(at(10, 0)), mk(at(11, 10)), mk(at(12, 20))],
    {
      user: "a@nnb24.de",
      since: new Date("2026-07-13T00:00:00"),
      until: new Date("2026-07-14T00:00:00"),
      idleGapMs: 30 * 60_000,
      jira: { scanCommits: false },
      sessionAccounts: new Map([[
        "claude:s-three",
        [
          { account: "a@nnb24.de", ts: new Date(at(9, 0)).toISOString() },
          { account: "b@nnb24.de", ts: new Date(at(11, 0)).toISOString() },
          { account: "c@nnb24.de", ts: new Date(at(12, 0)).toISOString() },
        ],
      ]]),
      ccusageCost: new Map([["s-three", {
        totalCostUsd: 9,
        totals: { inputTokens: 2, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 4 },
        models: [{
          model: "claude-sonnet-4", provider: "claude" as const,
          inputTokens: 2, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0,
          totalTokens: 4, costUsd: 9, costAvailable: true,
        }],
      }]]),
    },
  );
  assert.equal(result.sessions.length, 3, "three distinct accounts, three rows");
  const sum = (f: (s: (typeof result.sessions)[number]) => number) =>
    result.sessions.reduce((a, s) => a + f(s), 0);
  assert.equal(sum((s) => s.totals.inputTokens), 2, "input must sum to the authoritative 2");
  assert.equal(sum((s) => s.totals.outputTokens), 2, "output must sum to the authoritative 2");
  assert.equal(sum((s) => s.totals.totalTokens), 4);
  assert.equal(Math.round(sum((s) => s.notionalCostUsd) * 100) / 100, 9);
});

test("a non-contiguous switch keeps each visit's own identity evidence", () => {
  // A -> B -> A. Bucketing by the account STRING merged the two A visits into
  // the first one, so a later verified capture was replaced by the earlier
  // unverified entry and that usage failed closed.
  const mk = (iso: string): UsageRecord => ({
    ...rec("s-abab", iso), provider: "codex", model: "gpt-5.6-sol",
  });
  const at = (h: number) => `2026-07-13T${String(h).padStart(2, "0")}:05:00`;
  const result = analyze([mk(at(10)), mk(at(11)), mk(at(12))], {
    user: "fallback@nnb24.de",
    providerUsers: { claude: "c@nnb24.de", codex: null },
    since: new Date("2026-07-13T00:00:00"),
    until: new Date("2026-07-14T00:00:00"),
    idleGapMs: 30 * 60_000,
    jira: { scanCommits: false },
    sessionAccounts: new Map([[
      "codex:s-abab",
      [
        { account: "a@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() },
        { account: "b@nnb24.de", providerVerified: true, ts: new Date("2026-07-13T10:30:00").toISOString() },
        { account: "a@nnb24.de", providerVerified: true, ts: new Date("2026-07-13T11:30:00").toISOString() },
      ],
    ]]),
  });
  const users = result.sessions.map((s) => s.user).sort();
  // The third visit is VERIFIED, so it must be attributed to a@ — not folded
  // back into the first, unverified visit and lost to the fallback identity.
  assert.ok(users.includes("a@nnb24.de"), `verified return visit lost: ${users.join(", ")}`);
  assert.ok(users.includes("b@nnb24.de"));
});

test("merging two visits keeps the LATER visit's project and task", () => {
  // buildSession resolves cwd/branch/task as "latest non-null wins". A merge
  // must not undo that: the merged row carries the later visit's tokens, so
  // reporting them under the earlier visit's Jira key attributes real work to
  // the wrong task.
  const mk = (iso: string, cwd: string, branch: string): UsageRecord => ({
    ...rec("s-meta", iso), provider: "codex", model: "gpt-5.6-sol", cwd, gitBranch: branch,
  });
  const result = analyze(
    [
      // Spaced UNDER idleGapMs so the fixture actually has active time; a
      // wider gap counts as away and every assertion about hours is vacuous.
      mk("2026-07-13T10:05:00", "/w/old", "feat/BI-1"),
      mk("2026-07-13T10:20:00", "/w/old", "feat/BI-1"),
      mk("2026-07-13T10:35:00", "/w/mid", "feat/BI-2"),
      mk("2026-07-13T10:50:00", "/w/mid", "feat/BI-2"),
      mk("2026-07-13T11:35:00", "/w/new", "feat/BI-3"),
      mk("2026-07-13T11:50:00", "/w/new", "feat/BI-3"),
    ],
    {
      user: "fallback@nnb24.de",
      providerUsers: { claude: "c@nnb24.de", codex: null },
      since: new Date("2026-07-13T00:00:00"),
      until: new Date("2026-07-14T00:00:00"),
      idleGapMs: 30 * 60_000,
      jira: { scanCommits: false },
      sessionAccounts: new Map([[
        "codex:s-meta",
        [
          { account: "a@nnb24.de", ts: new Date("2026-07-13T09:00:00").toISOString() },
          { account: "b@nnb24.de", ts: new Date("2026-07-13T10:30:00").toISOString() },
          { account: "a@nnb24.de", ts: new Date("2026-07-13T11:30:00").toISOString() },
        ],
      ]]),
    },
  );
  // All three visits fail closed to the same unverified Codex identity, so they
  // merge into one row.
  assert.equal(result.sessions.length, 1);
  const merged = result.sessions[0]!;
  assert.equal(merged.project, "new", "the latest visit's project must win");
  assert.equal(merged.gitBranch, "feat/BI-3", "the latest visit's branch must win");
  assert.equal(merged.messageCount, 6, "every visit's messages are counted");

  // Cost and per-model tokens must ACCUMULATE across the merged visits, not be
  // taken from whichever segment landed first.
  const unsplit = analyze(
    [
      // Spaced UNDER idleGapMs so the fixture actually has active time; a
      // wider gap counts as away and every assertion about hours is vacuous.
      mk("2026-07-13T10:05:00", "/w/old", "feat/BI-1"),
      mk("2026-07-13T10:20:00", "/w/old", "feat/BI-1"),
      mk("2026-07-13T10:35:00", "/w/mid", "feat/BI-2"),
      mk("2026-07-13T10:50:00", "/w/mid", "feat/BI-2"),
      mk("2026-07-13T11:35:00", "/w/new", "feat/BI-3"),
      mk("2026-07-13T11:50:00", "/w/new", "feat/BI-3"),
    ],
    {
      user: "fallback@nnb24.de",
      providerUsers: { claude: "c@nnb24.de", codex: null },
      since: new Date("2026-07-13T00:00:00"),
      until: new Date("2026-07-14T00:00:00"),
      idleGapMs: 30 * 60_000,
      jira: { scanCommits: false },
    },
  ).sessions[0]!;
  assert.equal(merged.totals.totalTokens, unsplit.totals.totalTokens,
    "merged tokens must equal the unsplit session's");
  assert.equal(
    Math.round(merged.notionalCostUsd * 1e6), Math.round(unsplit.notionalCostUsd * 1e6),
    "merged cost must equal the unsplit session's",
  );
  // Internal consistency, which holds even where the model has no price (Codex
  // subscription usage reports 0): the row total must equal the sum of its own
  // per-model rows. Comparing only against the unsplit run is vacuous at 0.
  assert.equal(
    Math.round(merged.notionalCostUsd * 1e6),
    Math.round(merged.modelUsage.reduce((a, m) => a + m.costUsd, 0) * 1e6),
    "the merged row's cost must equal the sum of its own model rows",
  );
  assert.equal(
    merged.totals.totalTokens,
    merged.modelUsage.reduce((a, m) => a + m.totalTokens, 0),
    "the merged row's tokens must equal the sum of its own model rows",
  );
  const mu = merged.modelUsage.find((m) => m.model === "gpt-5.6-sol")!;
  const uu = unsplit.modelUsage.find((m) => m.model === "gpt-5.6-sol")!;
  assert.equal(mu.totalTokens, uu.totalTokens, "per-model tokens must accumulate");
  assert.equal(Math.round(mu.costUsd * 1e6), Math.round(uu.costUsd * 1e6),
    "per-model cost must accumulate");
  assert.ok(merged.activeTimeHours > 0, "merged hours must not be dropped");
});
