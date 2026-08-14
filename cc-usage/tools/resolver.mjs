#!/usr/bin/env node
// Stable CLI resolver. The bin wrapper and the LaunchAgent's sync.sh call a
// COPY of this file in STATE_DIR — never a versioned plugin path, which goes
// stale the moment an auto-update lands and the old cache is collected.
// Each SessionStart registers the plugin root the host actually loaded and
// validated; this resolver picks the highest valid SemVer at call time and
// execs its tools/cc-usage.mjs.
//
// Self-contained on purpose: it is copied out of the plugin and must keep
// working after that plugin version is gone. No imports from core/, no
// credentials, no collector logic.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function stateDir() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cc-usage");
}
function registryFile() {
  return join(stateDir(), "runtime-registry.json");
}

// Full SemVer 2.0 compare (prerelease-aware). Returns -1/0/1.
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : (pb ? -1 : 0);
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) {
    // A release outranks any of its prereleases.
    return pa.pre.length ? -1 : (pb.pre.length ? 1 : 0);
  }
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// A registered root is usable only if the plugin is really there and intact.
// dist/cli.js is required too: the daily LaunchAgent calls `sync`, which needs
// the collector bundle — a root without it would resolve and then fail.
export function validateRoot(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    if (manifest.name !== "cc-usage") return null;
    if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ""))) return null;
    if (!existsSync(join(root, "tools", "cc-usage.mjs"))) return null;
    if (!existsSync(join(root, "dist", "cli.js"))) return null;
    return String(manifest.version);
  } catch {
    return null;
  }
}

export function resolveRuntime(registryPath = registryFile()) {
  let entries = [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    if (Array.isArray(parsed.entries)) entries = parsed.entries;
  } catch { /* empty/missing registry -> fail closed below */ }
  // MOST RECENTLY REGISTERED wins; SemVer only breaks ties. Every SessionStart
  // registers the root the host actually loaded, so "newest registration" means
  // "what Claude is really running" and the choice self-corrects after an
  // update. Ranking by version instead would let a one-off higher-versioned root
  // (e.g. a dev checkout) pin the runtime — including the unattended daily sync
  // — forever, which is strictly worse than following the host.
  let best = null;
  for (const entry of entries) {
    if (!entry || typeof entry.root !== "string") continue;
    const version = validateRoot(entry.root);
    if (!version) continue;
    const candidate = { root: entry.root, version, registeredAt: String(entry.registeredAt || "") };
    if (!best
      || candidate.registeredAt > best.registeredAt
      || (candidate.registeredAt === best.registeredAt
          && compareSemver(candidate.version, best.version) > 0)) {
      best = candidate;
    }
  }
  return best;
}

function main() {
  const runtime = resolveRuntime();
  if (!runtime) {
    const msg = "cc-usage: no installed plugin runtime found (plugin uninstalled or cache cleaned).\n"
      + "Fix: start a Claude Code or Codex session (the plugin's SessionStart hook re-registers itself),\n"
      + "or reinstall the cc-usage plugin.\n";
    process.stderr.write(msg);
    // The daily LaunchAgent runs unattended — leave a trace doctor can surface,
    // otherwise collection stops silently.
    try { appendFileSync(join(stateDir(), "hook.err"), `${new Date().toISOString()} ${msg}`); } catch { /* best effort */ }
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [join(runtime.root, "tools", "cc-usage.mjs"), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status === null ? 1 : result.status);
}

// Import-safe: run only when executed directly (tests import the helpers,
// their argv[1] is the test file).
if (process.argv[1] && process.argv[1].endsWith("resolver.mjs")) main();
