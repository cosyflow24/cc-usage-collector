import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { analyze } from "../src/analyze.ts";
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
