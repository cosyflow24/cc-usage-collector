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
  const env = { CC_USAGE_NO_AUTOUPDATE: "", PATH: join(sb, "empty-bin"), HOME: join(sb, "nohome") };
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
