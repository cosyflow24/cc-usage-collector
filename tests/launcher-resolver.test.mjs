// Resolver + launcher-heal + autoupdate-throttle tests. Everything runs in a
// sandboxed CLAUDE_CONFIG_DIR / CC_USAGE_BIN_DIR so no real install is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compareSemver, validateRoot, resolveRuntime } from "../cc-usage/tools/resolver.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const realPlugin = join(repoRoot, "cc-usage");
const ccUsageMjs = join(realPlugin, "tools", "cc-usage.mjs");

function sandbox() { return mkdtempSync(join(tmpdir(), "ccu-test-")); }

// A minimal on-disk plugin root that validateRoot() accepts.
function fakeRoot(base, name, version, { bundle = true } = {}) {
  const root = join(base, name);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "cc-usage", version }));
  writeFileSync(join(root, "tools", "cc-usage.mjs"), "// stub\n");
  if (bundle) { mkdirSync(join(root, "dist"), { recursive: true }); writeFileSync(join(root, "dist", "cli.js"), "// stub\n"); }
  return root;
}

function writeRegistry(dir, roots) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runtime-registry.json"), JSON.stringify({
    schemaVersion: 1,
    entries: roots.map((r, i) => ({
      root: r, version: "x", registeredAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    })),
  }));
}

// Run the real SessionStart hook against a sandboxed environment.
function runSessionStart(sb, env = {}) {
  return spawnSync(process.execPath, [ccUsageMjs, "hook", "session-start"], {
    input: JSON.stringify({ session_id: "t1", cwd: sb }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: sb,
      CC_USAGE_BIN_DIR: join(sb, "bin"),
      CC_USAGE_NO_AUTOUPDATE: "1",
      CC_USAGE_HEADLESS: "1",
      CC_USAGE_REGISTER_DEV: "1", // the repo checkout is a git tree; opt in for tests
      ...env,
    },
  });
}

test("compareSemver orders releases and prereleases", () => {
  assert.equal(compareSemver("0.5.0", "0.4.9") > 0, true);
  assert.equal(compareSemver("2.10.0", "2.9.0") > 0, true);
  assert.equal(compareSemver("0.5.0", "0.5.0-beta.1") > 0, true, "release beats its prerelease");
  assert.equal(compareSemver("0.5.0-beta.10", "0.5.0-beta.2") > 0, true, "numeric prerelease ids compare numerically");
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});

test("validateRoot rejects wrong name, bad version, and a missing collector bundle", () => {
  const sb = sandbox();
  assert.equal(validateRoot(fakeRoot(sb, "good", "0.5.0")), "0.5.0");
  assert.equal(validateRoot(fakeRoot(sb, "nobundle", "0.5.0", { bundle: false })), null);
  assert.equal(validateRoot(join(sb, "does-not-exist")), null);
  const bad = fakeRoot(sb, "badver", "0.5.0");
  writeFileSync(join(bad, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cc-usage", version: "nope" }));
  assert.equal(validateRoot(bad), null);
  const foreign = fakeRoot(sb, "foreign", "0.5.0");
  writeFileSync(join(foreign, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "other", version: "0.5.0" }));
  assert.equal(validateRoot(foreign), null);
});

test("resolveRuntime skips dead and half-built roots", () => {
  const sb = sandbox();
  const older = fakeRoot(sb, "v040", "0.4.0");
  const newer = fakeRoot(sb, "v050", "0.5.0");
  const broken = fakeRoot(sb, "vbroken", "9.9.9", { bundle: false }); // newest, but unusable
  const gone = join(sb, "collected-by-cache-gc");                     // newest, but deleted
  writeRegistry(sb, [older, newer, broken, gone]);
  const got = resolveRuntime(join(sb, "runtime-registry.json"));
  assert.equal(got.root, newer, "falls back to the newest root that actually validates");
});

test("SemVer breaks ties only when registration timestamps are identical", () => {
  const sb = sandbox();
  const low = fakeRoot(sb, "tie-low", "0.4.0");
  const high = fakeRoot(sb, "tie-high", "0.5.0");
  const ts = "2026-02-02T00:00:00.000Z";
  mkdirSync(sb, { recursive: true });
  writeFileSync(join(sb, "runtime-registry.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [{ root: low, version: "x", registeredAt: ts }, { root: high, version: "x", registeredAt: ts }],
  }));
  assert.equal(resolveRuntime(join(sb, "runtime-registry.json")).root, high);
});

test("resolveRuntime fails closed when nothing valid remains", () => {
  const sb = sandbox();
  assert.equal(resolveRuntime(join(sb, "missing.json")), null);
  writeRegistry(sb, [join(sb, "ghost-a"), join(sb, "ghost-b")]);
  assert.equal(resolveRuntime(join(sb, "runtime-registry.json")), null);
});

test("SessionStart writes the resolver copy, registry, and a resolver-based launcher", () => {
  const sb = sandbox();
  const r = runSessionStart(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(sb, "cc-usage", "resolver.mjs")), "resolver copy written");
  const runtime = resolveRuntime(join(sb, "cc-usage", "runtime-registry.json"));
  assert.ok(runtime, "a runtime got registered");
  assert.equal(runtime.root, realPlugin);
  const shim = readFileSync(join(sb, "bin", "cc-usage"), "utf8");
  assert.match(shim, /Generated by cc-usage/);
  assert.match(shim, /resolver\.mjs/);
  assert.doesNotMatch(shim, /tools\/cc-usage"/, "must not point at a versioned tools path");
});

test("SessionStart heals a pre-existing versioned symlink launcher", () => {
  const sb = sandbox();
  const bin = join(sb, "bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "cc-usage");
  symlinkSync(join(realPlugin, "tools", "cc-usage"), link); // old style
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const r = runSessionStart(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lstatSync(link).isSymbolicLink(), false, "symlink replaced by a real shim");
  assert.match(readFileSync(link, "utf8"), /resolver\.mjs/);
});

test("SessionStart never touches a foreign launcher", () => {
  const sb = sandbox();
  const bin = join(sb, "bin");
  mkdirSync(bin, { recursive: true });
  const foreign = join(bin, "cc-usage");
  const body = "#!/bin/sh\n# someone else's tool\nexit 7\n";
  writeFileSync(foreign, body, { mode: 0o755 });
  const r = runSessionStart(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(foreign, "utf8"), body, "foreign file untouched byte-for-byte");
});

test("the LaunchAgent compat shim points at the resolver, not a versioned path", () => {
  const sb = sandbox();
  runSessionStart(sb);
  const sync = readFileSync(join(sb, "cc-usage", "bin", "sync.sh"), "utf8");
  assert.match(sync, /resolver\.mjs/);
  assert.doesNotMatch(sync, /tools\/cc-usage\.mjs/);
});

test("autoupdate: opt-out writes no day marker; otherwise exactly one per day", () => {
  const optOut = sandbox();
  runSessionStart(optOut); // CC_USAGE_NO_AUTOUPDATE=1 by default in the helper
  const askedOptOut = join(optOut, "cc-usage", "asked");
  const outMarkers = existsSync(askedOptOut)
    ? readdirSync(askedOptOut).filter((f) => f.startsWith("autoupdate")) : [];
  assert.deepEqual(outMarkers, [], "opt-out must not claim a day");

  const sb = sandbox();
  // Enabled, but point PATH at nothing so no real update can run.
  // Emptying PATH is not isolation: findExecutable() falls back to absolute
  // candidates such as /opt/homebrew/bin/codex and would drive the machine's real
  // CLI against the developer's real install. Pin both binaries instead.
  const env = {
    CC_USAGE_NO_AUTOUPDATE: "",
    PATH: join(sb, "empty-bin"),
    HOME: join(sb, "nohome"),
    CC_USAGE_CLAUDE_BIN: join(sb, "nonexistent-claude"),
    CC_USAGE_CODEX_BIN: join(sb, "nonexistent-codex"),
  };
  runSessionStart(sb, env);
  runSessionStart(sb, env);
  const markers = readdirSync(join(sb, "cc-usage", "asked")).filter((f) => f.startsWith("autoupdate"));
  assert.equal(markers.length, 1, "atomic O_EXCL claim allows exactly one attempt per day");
  assert.match(markers[0], /^autoupdate-\d{4}-\d{2}-\d{2}$/);
});

test("headless SessionStart emits no AskUserQuestion instruction", () => {
  const sb = sandbox();
  const r = runSessionStart(sb, { CC_USAGE_HEADLESS: "1" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout || "", /AskUserQuestion/);
});

test("resolveRuntime follows the most recently registered root, not the highest version", () => {
  const sb = sandbox();
  const devHigh = fakeRoot(sb, "dev-0.9.0", "0.9.0");
  const releaseLow = fakeRoot(sb, "rel-0.5.0", "0.5.0");
  // devHigh registered first (older timestamp), releaseLow second.
  writeRegistry(sb, [devHigh, releaseLow]);
  const got = resolveRuntime(join(sb, "runtime-registry.json"));
  assert.equal(got.root, releaseLow, "what the host loaded last must win");
});

test("reconcile refuses to register a git checkout unless opted in", () => {
  const sb = sandbox();
  const r = spawnSync(process.execPath, [ccUsageMjs, "hook", "session-start"], {
    input: JSON.stringify({ session_id: "t2", cwd: sb }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: sb,
      CC_USAGE_BIN_DIR: join(sb, "bin"),
      CC_USAGE_NO_AUTOUPDATE: "1",
      CC_USAGE_HEADLESS: "1",
      CC_USAGE_REGISTER_DEV: "", // opt OUT — this repo IS a git checkout
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(sb, "cc-usage", "runtime-registry.json")), false,
    "a dev checkout must not become the unattended runtime");
});

test("sync.sh is not written when the resolver copy is missing", () => {
  const sb = sandbox();
  runSessionStart(sb);
  const syncPath = join(sb, "cc-usage", "bin", "sync.sh");
  // A LEGACY shim that differs from what regenCompatSync would write, so the
  // content-compare cannot mask a missing guard.
  const before = "#!/bin/bash\n# Regenerated by cc-usage (plugin). legacy\n"
    + "exec node /old/versioned/0.4.2/tools/cc-usage.mjs sync --days \"${1:-1}\"\n";
  writeFileSync(syncPath, before, { mode: 0o755 });
  // Simulate a reconcile that bailed: the resolver copy is gone.
  rmSync(join(sb, "cc-usage", "resolver.mjs"), { force: true });
  const r = spawnSync(process.execPath, [ccUsageMjs, "hook", "session-start"], {
    input: JSON.stringify({ session_id: "t3", cwd: sb }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: sb,
      CC_USAGE_BIN_DIR: join(sb, "bin"),
      CC_USAGE_NO_AUTOUPDATE: "1",
      CC_USAGE_HEADLESS: "1",
      CC_USAGE_REGISTER_DEV: "", // reconcile bails -> resolver stays absent
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(syncPath, "utf8"), before,
    "an existing working shim must survive a bailed reconcile");
});

test("healWrappers does not clobber a DANGLING foreign symlink", () => {
  const sb = sandbox();
  const bin = join(sb, "bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "cc-usage");
  symlinkSync(join(sb, "some", "other", "tool"), link); // foreign + dangling
  runSessionStart(sb);
  assert.equal(lstatSync(link).isSymbolicLink(), true, "foreign dangling symlink left alone");
});

test("interactive SessionStart DOES emit the AskUserQuestion instruction", () => {
  const sb = sandbox();
  const r = runSessionStart(sb, { CC_USAGE_HEADLESS: "", CI: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout || "", /AskUserQuestion/,
    "positive control: the headless test must not pass vacuously");
});

test("isDevCheckout: dev tree yes, install path inside a dotfiles git repo NO", async () => {
  const { isDevCheckout } = await import("../cc-usage/tools/core/launcher.mjs");
  const sb = sandbox();

  // Layout A — real install: config dir IS a dotfiles git repo (common!), the
  // plugin sits 5 levels below it. Regression: an earlier 6-level walk found
  // that .git and silently disabled reconcile for such users.
  mkdirSync(join(sb, "cfg", ".git"), { recursive: true });
  const installed = join(sb, "cfg", "plugins", "cache", "cc-usage", "cc-usage", "0.5.0");
  mkdirSync(installed, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(sb, "cfg");
  assert.equal(isDevCheckout(installed), false, "an installed plugin must still register");

  // Layout B — developer checkout: <repo>/.git with the plugin one level down.
  const repo = join(sb, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const devPlugin = join(repo, "cc-usage");
  mkdirSync(devPlugin, { recursive: true });
  assert.equal(isDevCheckout(devPlugin), true, "a git checkout must not become the runtime");

  // Layout C — a .git-bearing dir that is NOT the config dir, 4 levels above the
  // plugin. Fails iff the walk limit is widened again (pins the depth on its own,
  // independently of the CLAUDE_CONFIG_DIR check).
  const deep = join(sb, "deepRepo");
  mkdirSync(join(deep, ".git"), { recursive: true });
  const deepPlugin = join(deep, "a", "b", "c", "cc-usage");
  mkdirSync(deepPlugin, { recursive: true });
  assert.equal(isDevCheckout(deepPlugin), false, "walk must stay shallow (root + 2 ancestors)");

  // Opt-in escape hatch.
  process.env.CC_USAGE_REGISTER_DEV = "1";
  assert.equal(isDevCheckout(devPlugin), false, "CC_USAGE_REGISTER_DEV overrides");
  delete process.env.CC_USAGE_REGISTER_DEV;
  delete process.env.CLAUDE_CONFIG_DIR;
});

// Runs in a child process with a sandboxed CLAUDE_CONFIG_DIR. config.mjs reads
// CLAUDE_CONFIG_DIR at module load, and earlier tests in this file have already
// imported it, so setting the env var in-process would not move STATE_DIR — the
// worker would append its fake FAILED lines to the real ~/.claude/cc-usage log.
function runWorkerProbe(sb, executables) {
  const script = `
    import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
    const calls = [];
    const execute = (binary, args) => {
      calls.push(binary + " " + args.join(" "));
      if (binary === "CLAUDE" && args[1] === "update") { const e = new Error("boom"); e.stderr = "boom"; throw e; }
      // Mirrors the real \`codex plugin marketplace upgrade\` on a local marketplace.
      if (args[1] === "marketplace") { const e = new Error("not a Git marketplace"); e.stderr = "not a Git marketplace"; throw e; }
      return "";
    };
    const results = runUpdateWorker({ executables: ${JSON.stringify(executables)}, execute });
    process.stdout.write(JSON.stringify({ results, calls }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: sb,
      CC_USAGE_NO_AUTOUPDATE: "",
      // Pin both host binaries at the process boundary. Emptying PATH is not
      // isolation: findExecutable() falls back to absolute candidates such as
      // /usr/local/bin/codex and would reach the machine's real CLI.
      CC_USAGE_CLAUDE_BIN: "/nonexistent/claude",
      CC_USAGE_CODEX_BIN: "/nonexistent/codex",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("autoupdate worker: both hosts run; a failing host never suppresses the other", () => {
  const sb = sandbox();
  try {
  const { results, calls } = runWorkerProbe(sb, { claude: "CLAUDE", codex: "CODEX" });

  assert.equal(results.claude, false, "claude reports failure");
  assert.equal(results.codex, true, "codex still ran to completion");
  assert.ok(calls.includes("CODEX plugin marketplace upgrade cc-usage"), "codex refreshes the marketplace");
  // A failing marketplace refresh must NOT abort the host: the install still runs.
  assert.ok(calls.includes("CODEX plugin add cc-usage@cc-usage"), "codex re-adds the plugin despite the failed refresh");
  assert.ok(calls.includes("CLAUDE plugin update cc-usage@cc-usage"), "claude reaches its install step too");

  // The log must be the sandboxed one, never the user's real state dir.
  const log = readFileSync(join(sb, "cc-usage", "autoupdate.log"), "utf8");
  assert.match(log, /FAILED claude plugin update/);
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: a host that is not installed is skipped, not failed", () => {
  const sb = sandbox();
  try {
    const { results, calls } = runWorkerProbe(sb, { claude: "OK", codex: "" });

    assert.equal(results.codex, null, "absent host yields null, not false");
    assert.equal(results.claude, true);
    assert.ok(!calls.some((c) => c.startsWith("CODEX")), "no calls for an absent host");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("the ask-the-user instruction names the tool the HOST actually has", () => {
  const sbC = sandbox();
  const sbX = sandbox();
  try {
    // Same de-headless switches the positive-control test above uses.
    const env = { CC_USAGE_HEADLESS: "", CI: "", CC_USAGE_NO_AUTOUPDATE: "1" };
    const claude = runSessionStart(sbC, env);
    // currentProvider() only believes CODEX_THREAD_ID when it matches the hook
    // payload's session id, and runSessionStart sends "t1".
    // CODEX_HOME must be sandboxed too: sessionStart -> captureAccount reads
    // $CODEX_HOME/auth.json, i.e. the developer's real Codex login otherwise.
    const codex = runSessionStart(sbX, { ...env, CODEX_THREAD_ID: "t1", CODEX_HOME: join(sbX, "codex-home") });

    assert.match(claude.stdout || "", /AskUserQuestion/, "Claude Code is told to use AskUserQuestion");
    // Codex has no AskUserQuestion. Naming it there left the agent improvising.
    assert.doesNotMatch(codex.stdout || "", /AskUserQuestion/, "Codex must not be told to call AskUserQuestion");
    assert.match(codex.stdout || "", /request_user_input/, "Codex is told to use request_user_input");
    assert.match(codex.stdout || "", /request_user_input_async/, "with the async form as the documented fallback");
  } finally {
    rmSync(sbC, { recursive: true, force: true });
    rmSync(sbX, { recursive: true, force: true });
  }
});

test("autoupdate worker: a host that ran after midnight is not installed again the same new day", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      const calls = [];
      const execute = (b, a) => { calls.push(b + " " + a.join(" ")); return ""; };
      // claude installs at 23:59; the clock then crosses midnight, so codex
      // starts (and installs) at 00:01. The clock is read more than once per
      // host, so model it as time that advances, not as a list of ticks.
      let t = new Date(Date.UTC(2026, 8, 7, 23, 59));
      const execute2 = (b, a) => { const r = execute(b, a); if (b === "C" && a[1] === "update") t = new Date(Date.UTC(2026, 8, 8, 0, 1)); return r; };
      runUpdateWorker({ executables: { claude: "C", codex: "X" }, execute: execute2, clock: () => t });
      const n1 = calls.length;
      runUpdateWorker({ executables: { claude: "", codex: "X" }, execute, clock: () => new Date(Date.UTC(2026, 8, 8, 0, 10)) });
      process.stdout.write(JSON.stringify({ n1, n2: calls.length }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    const { n1, n2 } = JSON.parse(r.stdout);
    assert.equal(n1, 4, "both hosts ran once");
    assert.equal(n2, 4, "codex, recorded under 2026-09-08, is not run again at 00:10");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: the day claim is taken atomically BEFORE installing", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { existsSync } from "node:fs";
      const claim = ${JSON.stringify(join(sb, "cc-usage", "autoupdate-done-codex-2026-09-08"))};
      let seenDuringInstall = null;
      const execute = (b, a) => { if (b === "X" && a[1] === "add") seenDuringInstall = existsSync(claim); return ""; };
      runUpdateWorker({ executables: { claude: "", codex: "X" }, execute, clock: () => new Date(Date.UTC(2026, 8, 8, 0, 1)) });
      process.stdout.write(JSON.stringify({ seenDuringInstall }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).seenDuringInstall, true, "claim exists while the install runs, not only after");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: the day claim uses the INSTALL time, not the refresh time", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { existsSync } from "node:fs";
      const dir = ${JSON.stringify(join(sb, "cc-usage"))};
      // The refresh runs at 23:59 and takes the clock past midnight; the install
      // happens at 00:01. The claim must carry the INSTALL day.
      let t = new Date(Date.UTC(2026, 8, 7, 23, 59));
      const calls = [];
      runUpdateWorker({ executables: { claude: "", codex: "X" }, execute: (b, a) => { calls.push(a[1]); if (a[1] === "marketplace") t = new Date(Date.UTC(2026, 8, 8, 0, 1)); return ""; }, clock: () => t });
      const claimedNewDay = existsSync(dir + "/autoupdate-done-codex-2026-09-08");
      const claimedOldDay = existsSync(dir + "/autoupdate-done-codex-2026-09-07");
      // 00:16 the same new day: must not install again
      const before = calls.length;
      runUpdateWorker({ executables: { claude: "", codex: "X" }, execute: (b, a) => { calls.push(a[1]); return ""; }, clock: () => new Date(Date.UTC(2026, 8, 8, 0, 16)) });
      process.stdout.write(JSON.stringify({ claimedNewDay, claimedOldDay, again: calls.length - before }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.claimedNewDay, true, "claimed under the install day");
    assert.equal(out.claimedOldDay, false, "not under the refresh day");
    assert.equal(out.again, 0, "no second install on the new day");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: an install claimed on one day but COMPLETED on the next is claimed under both days", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { existsSync } from "node:fs";
      const dir = ${JSON.stringify(join(sb, "cc-usage"))};
      // claimed at 23:59:59, the install command returns at 00:00:01
      let t = new Date(Date.UTC(2026, 8, 7, 23, 59, 59));
      const calls = [];
      runUpdateWorker({ executables: { claude: "", codex: "X" }, execute: (b, a) => { calls.push(a[1]); if (a[1] === "add") t = new Date(Date.UTC(2026, 8, 8, 0, 0, 1)); return ""; }, clock: () => t });
      const claimDay = existsSync(dir + "/autoupdate-done-codex-2026-09-07");
      const doneDay = existsSync(dir + "/autoupdate-done-codex-2026-09-08");
      const before = calls.length;
      runUpdateWorker({ executables: { claude: "", codex: "X" }, execute: (b, a) => { calls.push(a[1]); return ""; }, clock: () => new Date(Date.UTC(2026, 8, 8, 0, 16)) });
      process.stdout.write(JSON.stringify({ claimDay, doneDay, again: calls.length - before }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.claimDay, true, "claimed under the claim day");
    assert.equal(out.doneDay, true, "claimed under the completion day");
    assert.equal(out.again, 0, "no second install on the completion day");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: a live install lock is WAITED for, then today's claim is honoured (no second install)", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { writeFileSync, utimesSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
      const dir = ${JSON.stringify(join(sb, "cc-usage"))};
      mkdirSync(dir, { recursive: true });
      const t0 = new Date(Date.UTC(2026, 8, 8, 0, 0, 30));
      let t = t0;
      // worker A (alive: this very process) took the lock at 23:59:59 and is still installing
      const lock = dir + "/autoupdate-lock-codex";
      writeFileSync(lock, String(process.pid));
      utimesSync(lock, new Date(Date.UTC(2026, 8, 7, 23, 59, 59)), new Date(Date.UTC(2026, 8, 7, 23, 59, 59)));
      const calls = []; let waits = 0;
      const r = runUpdateWorker({
        executables: { claude: "", codex: "X" },
        execute: (b, a) => { calls.push(a[1]); return ""; },
        clock: () => t,
        wait: () => { waits += 1; t = new Date(t.getTime() + 2000); if (waits === 3) { writeFileSync(dir + "/autoupdate-done-codex-2026-09-08", "A"); unlinkSync(lock); } },
      });
      process.stdout.write(JSON.stringify({ waits, adds: calls.filter((c) => c === "add").length, result: r.codex, lockLeft: existsSync(lock) }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.waits, 3, "waited for the live holder instead of skipping");
    assert.equal(out.adds, 0, "A finished today: no second install");
    assert.equal(out.result, true);
    assert.equal(out.lockLeft, false, "our own lock is released");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: an unreadable lock on one host is given up on quickly and never starves the other host", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { mkdirSync } from "node:fs";
      const dir = ${JSON.stringify(join(sb, "cc-usage"))};
      mkdirSync(dir, { recursive: true });
      // a DIRECTORY at the lock path: wx fails with EEXIST, reading it fails (EISDIR), unlink fails — forever
      mkdirSync(dir + "/autoupdate-lock-claude");
      const calls = []; let waits = 0;
      const t0 = Date.now();
      const r = runUpdateWorker({ executables: { claude: "C", codex: "X" }, execute: (b, a) => { calls.push(b + ":" + a[1]); return ""; }, clock: () => new Date(Date.UTC(2026, 8, 8, 12, 0)), wait: () => { waits += 1; } });
      process.stdout.write(JSON.stringify({ claude: r.claude, codex: r.codex, codexInstalls: calls.filter((c) => c === "X:add").length, claudeInstalls: calls.filter((c) => c === "C:update").length, ms: Date.now() - t0, waits }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr || String(r.signal));
    const out = JSON.parse(r.stdout);
    assert.equal(out.claude, null, "claude given up on");
    assert.equal(out.claudeInstalls, 0);
    assert.equal(out.codex, true); assert.equal(out.codexInstalls, 1, "codex still updated");
    assert.ok(out.ms < 5000, `bounded, took ${out.ms} ms`);
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: a dead holder's lock is broken and the host installs once; a holder that never yields is given up on", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { writeFileSync, utimesSync, mkdirSync, existsSync, rmSync } from "node:fs";
      const dir = ${JSON.stringify(join(sb, "cc-usage"))};
      mkdirSync(dir, { recursive: true });
      const lock = dir + "/autoupdate-lock-codex";
      const at = new Date(Date.UTC(2026, 8, 8, 12, 0, 0));
      writeFileSync(lock, "999999"); utimesSync(lock, at, at);
      const calls = [];
      const dead = runUpdateWorker({ executables: { claude: "", codex: "X" }, execute: (b, a) => { calls.push(a[1]); return ""; }, clock: () => at, isAlive: () => false, wait: () => { throw new Error("must not wait for a dead holder"); } });
      const installsAfterDead = calls.filter((c) => c === "add").length;
      // fresh state: a LIVE holder that never releases; the clock advances 3 min per poll
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      writeFileSync(lock, String(process.pid)); utimesSync(lock, at, at);
      let t = at; let waits = 0;
      const stuck = runUpdateWorker({ executables: { claude: "", codex: "X" }, execute: (b, a) => { calls.push(a[1]); return ""; }, clock: () => t, wait: () => { waits += 1; t = new Date(t.getTime() + 3 * 60_000); } });
      process.stdout.write(JSON.stringify({ dead: dead.codex, installsAfterDead, stuck: stuck.codex, adds: calls.filter((c) => c === "add").length, waits, lockKept: existsSync(lock) }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dead, true); assert.equal(out.installsAfterDead, 1, "stale lock broken, installed once");
    assert.equal(out.stuck, null, "gave up on a holder that never yields");
    assert.equal(out.adds, 1, "no install next to a live holder");
    assert.ok(out.waits >= 3 && out.waits <= 5, `bounded wait, got ${out.waits}`);
    assert.equal(out.lockKept, true, "a live holder's lock is never removed");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});

test("autoupdate worker: a claim taken by another worker DURING the refresh is exclusive — no second install", () => {
  const sb = sandbox();
  try {
    const script = `
      import { runUpdateWorker } from ${JSON.stringify(join(realPlugin, "tools", "core", "autoupdate.mjs"))};
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
      const dir = ${JSON.stringify(join(sb, "cc-usage"))};
      mkdirSync(dir, { recursive: true });
      const claim = dir + "/autoupdate-done-codex-2026-09-08";
      const calls = [];
      // Worker B starts with no claim present (fast path does not fire). While
      // B refreshes the marketplace, worker A takes today's claim. B's own claim
      // must then fail with EEXIST — never overwrite A's file, never install.
      const execute = (b, a) => { calls.push(a[1]); if (a[1] === "marketplace") writeFileSync(claim, "A"); return ""; };
      const r = runUpdateWorker({ executables: { claude: "", codex: "X" }, execute, clock: () => new Date(Date.UTC(2026, 8, 8, 0, 5)) });
      process.stdout.write(JSON.stringify({ installs: calls.filter((c) => c === "add").length, claimStillA: readFileSync(claim, "utf8") === "A", codex: r.codex }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sb, CC_USAGE_NO_AUTOUPDATE: "",
        CC_USAGE_CLAUDE_BIN: "/nonexistent/claude", CC_USAGE_CODEX_BIN: "/nonexistent/codex" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.installs, 0, "B must not install over A's claim");
    assert.equal(out.claimStillA, true, "B must not overwrite A's claim (wx, not w)");
    assert.equal(out.codex, true, "B reports the host as already done");
  } finally { rmSync(sb, { recursive: true, force: true }); }
});
