#!/usr/bin/env node
// Unified cc-usage CLI. One dependency-free ESM entry point over the collector
// bundle + OS-keyring credentials + the Claude Code hooks. Mirrors nnb-jira's
// tools/jira.mjs packaging (dispatch, options(), hiddenQuestion(), launcher).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  STATE_DIR, DEFAULT_INGEST_URL, jsonConfigFile, readConfig, writeConfig, readOauthEmail,
  resolverPath, registryFile,
} from "./core/config.mjs";
import {
  storeToken, loadToken, removeToken, secretDescription,
} from "./core/keyring.mjs";
import { setTask } from "./core/state.mjs";
import {
  installLauncher, launcherPath, ownsLauncher,
} from "./core/launcher.mjs";
import {
  loadCredentials, runCollector, bundlePath,
} from "./core/collector.mjs";
import { sessionStart, promptSubmit } from "./core/hooks.mjs";
import { runUpdateWorker } from "./core/autoupdate.mjs";
import { resolveRuntime } from "./resolver.mjs";

const VERSION = "0.5.0";
const out = (value = "") => process.stdout.write(`${value}\n`);
const fail = (message, code = 1) => { const e = new Error(message); e.exitCode = code; throw e; };
const need = (value, message) => value || fail(message);

function options(args, spec = {}) {
  const positional = [];
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const name = spec[arg];
    if (!name) fail(`unknown option: ${arg}`);
    if (name.startsWith("!")) values[name.slice(1)] = true;
    else values[name] = need(args[i += 1], `missing value for ${arg}`);
  }
  return { positional, values };
}

async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    fail("token entry requires an interactive terminal (or pipe it with: cc-usage login --stdin)", 2);
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") { process.stdout.write("\n"); return value; }
        if (code === 3) fail("cancelled", 130); // Ctrl-C
        if (code === 127 || code === 8) value = value.slice(0, -1); // DEL / Backspace
        else if (ch >= " ") value += ch;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
}

function readStdin() { try { return readFileSync(0, "utf8"); } catch { return ""; } }
function enrollUrl(ingestUrl) {
  try { return `${new URL(ingestUrl).origin}/enroll`; } catch { return `${DEFAULT_INGEST_URL.replace(/\/api\/ingest$/, "")}/enroll`; }
}
function openUrl(url) {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd.exe" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try { spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- subcommands
async function login(args) {
  const { values } = options(args, { "--stdin": "!stdin", "--url": "url", "--no-open": "!noOpen" });
  const cfg = readConfig();
  const ingestUrl = values.url || cfg.ingestUrl || DEFAULT_INGEST_URL;
  let token;
  if (values.stdin) {
    token = readStdin().trim();
  } else {
    const enroll = enrollUrl(ingestUrl);
    if (!values.noOpen) openUrl(enroll);
    out(`Get your upload token from the enrollment page (enter your @nnb24.de Max email):\n${enroll}\n`);
    token = (await hiddenQuestion("cc-usage upload token (input hidden): ")).trim();
  }
  if (!/^ccu_[A-Za-z0-9_-]+$/.test(token)) fail("that does not look like a cc-usage token (expected ccu_...)", 1);
  const email = cfg.email || readOauthEmail() || "default"; // stable, non-empty keyring account
  const where = storeToken(email, token);
  writeConfig({ ingestUrl, email, project: cfg.project });
  installLauncher();
  out(`\ncc-usage: token stored in ${where}. Usage now uploads on session end and daily.`);
  out("Run  cc-usage doctor  to verify, or  cc-usage sync  for an immediate upload.");
}

function syncArgs(days, dryRun) {
  const cfg = readConfig();
  const list = ["--days", String(days)];
  if (!dryRun) list.push("--upload");
  if (cfg.project) list.push("--project", cfg.project);
  return list;
}
function sync(args) {
  const { values } = options(args, { "--days": "days", "--dry-run": "!dryRun" });
  return runCollector(syncArgs(values.days || "1", !!values.dryRun));
}
function collect(args) { return runCollector(args); }

function task(args) {
  const [key, epic] = args.filter((a) => !a.startsWith("-"));
  if (!key) fail("usage: cc-usage task <last|none|KEY> [EPIC]");
  out(setTask(key, epic, process.cwd()));
}

function burn() {
  out(`burn · ${(process.cwd().split("/").pop() || "")} · ${new Date().toTimeString().slice(0, 5)}`);
  out();
  const flags = ["-y", "ccusage@latest", "blocks", "--active", "--token-limit", "max"];
  const r = spawnSync("npx", flags, { stdio: "inherit" });
  if (r.status !== 0) spawnSync("npx", ["-y", "ccusage@latest", "blocks", "--active"], { stdio: "inherit" });
}

function showConfig() {
  const cfg = readConfig();
  out("cc-usage configuration:");
  out(`  Ingest URL: ${cfg.ingestUrl}`);
  out(`  Email:      ${cfg.email || "(unset)"}`);
  out(`  Project:    ${cfg.project || "(all)"}`);
  out(`  Token:      ${loadToken(cfg) ? "set (hidden)" : "not set"}`);
  out(`  Secret:     ${secretDescription()}`);
  out(`  Config:     ${jsonConfigFile}`);
}

function contract() {
  out(JSON.stringify({
    schemaVersion: 1,
    name: "cc-usage",
    version: VERSION,
    capabilities: ["collect", "sync", "task-attribution", "hooks", "burn", "keyring"],
    state: { dir: STATE_DIR, schemaVersion: 1 },
  }, null, 2));
}

function migrate() {
  const { token, url } = loadCredentials({ notify: true });
  out(token ? `cc-usage: credentials ready (ingest ${url}).` : "cc-usage: no token found. Run  cc-usage login.");
}

function doctor() {
  let bad = 0;
  const ok = (m) => out(`ok: ${m}`);
  const nope = (m) => { out(`fail: ${m}`); bad += 1; };

  const node = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  ok(`node ${node.stdout?.trim() || "?"}`);

  const bundle = bundlePath();
  if (existsSync(bundle)) {
    const smoke = spawnSync(process.execPath, [bundle, "--help"], { stdio: "ignore" });
    if (smoke.status === 0) ok("collector bundle"); else nope("collector bundle present but --help failed");
  } else nope(`collector bundle missing (${bundle})`);

  const cfg = readConfig();
  ok(`ingest URL ${cfg.ingestUrl}`);
  if (loadToken(cfg)) ok("upload token set (hidden)"); else nope("no upload token — run cc-usage login");
  out(`     secret: ${secretDescription()}`);
  if (existsSync(jsonConfigFile)) ok(`config ${jsonConfigFile}`); else out("     (no config.json yet)");

  try { mkdirSync(STATE_DIR, { recursive: true }); ok(`state dir ${STATE_DIR}`); } catch { nope(`state dir not writable: ${STATE_DIR}`); }

  const launcher = launcherPath();
  if (existsSync(launcher)) { if (ownsLauncher(launcher)) ok(`launcher ${launcher}`); else nope(`foreign launcher at ${launcher}`); }
  else out("     (launcher not installed — run cc-usage login or cc-usage refresh)");

  if (existsSync(resolverPath)) ok(`resolver ${resolverPath}`);
  else nope(`resolver copy missing (${resolverPath}) — start a Claude session to regenerate`);
  const runtime = resolveRuntime();
  if (runtime) ok(`runtime ${runtime.version} at ${runtime.root}`);
  else nope("no valid plugin runtime registered — start a Claude session, or reinstall the plugin");

  const legacyEnv = join(STATE_DIR, "env");
  if (existsSync(legacyEnv) && /CC_USAGE_INGEST_TOKEN=\S/.test(readFileSync(legacyEnv, "utf8"))) {
    out("     note: plaintext token still in env — it migrates to the keyring on the next sync.");
  }
  const plist = join(homedir(), "Library", "LaunchAgents", "com.nnb24.cc-usage-sync.plist");
  if (existsSync(plist)) {
    const compat = join(STATE_DIR, "bin", "sync.sh");
    if (!existsSync(compat)) {
      out("     LaunchAgent present; open one Claude session so the compat bin/sync.sh regenerates.");
    } else if (readFileSync(compat, "utf8").includes(resolverPath)) {
      out("     LaunchAgent present; bin/sync.sh points at the stable resolver.");
    } else {
      nope("bin/sync.sh still points at a versioned path — start a Claude session to heal it");
    }
  }

  out(bad ? `cc-usage doctor: ${bad} issue(s)` : "cc-usage doctor: healthy");
  if (bad) process.exit(1);
}

function uninstall(args) {
  const { values } = options(args, { "--purge": "!purge", "--yes": "!yes" });
  const launcher = launcherPath();
  if (existsSync(launcher) && ownsLauncher(launcher)) { rmSync(launcher, { force: true }); out(`Removed launcher: ${launcher}`); }
  else if (existsSync(launcher)) out(`Kept unrecognized launcher: ${launcher}`);
  if (values.purge) {
    if (!values.yes) fail("re-run with --purge --yes to remove the stored token + config", 2);
    const cfg = readConfig();
    removeToken(cfg.email);
    rmSync(jsonConfigFile, { force: true });
    rmSync(resolverPath, { force: true });
    rmSync(registryFile, { force: true });
    rmSync(join(STATE_DIR, "bin", "sync.sh"), { force: true });
    out("Removed keyring token + config.json + resolver/registry/sync shim. Usage history (tasks.jsonl) was kept.");
  }
  out("Note: to also remove the daily job: launchctl bootout gui/$UID/com.nnb24.cc-usage-sync && rm ~/Library/LaunchAgents/com.nnb24.cc-usage-sync.plist");
}

function runHook(sub, payload) {
  if (sub === "session-start") { const o = sessionStart(payload); if (o) process.stdout.write(JSON.stringify(o)); return; }
  if (sub === "prompt-submit") { const o = promptSubmit(payload); if (o) process.stdout.write(JSON.stringify(o)); return; }
  if (sub === "autoupdate-worker") { runUpdateWorker(); return; }
  if (sub === "session-end") { runCollector(syncArgs("1", false), { quiet: true }); }
}

function help(topic) {
  if (topic) { out(`See: cc-usage ${topic} --help (or the plugin SKILL.md).`); return; }
  out(`cc-usage ${VERSION}
  login [--stdin] [--url URL] [--no-open]   store the ingest token in the OS keyring
  sync [--days N] [--dry-run]               upload the last N days of usage
  collect [collector args...]               run the analyzer directly (passthrough)
  task <last|none|KEY> [EPIC]               attribute this session to a Jira key
  burn                                      live 5h rate-limit window view
  doctor                                    health check (no upload)
  config | contract | migrate               show config / capabilities / migrate token
  refresh | uninstall [--purge --yes]       relink / remove the launcher
  hook <session-start|prompt-submit|session-end>   internal (called by hooks.json)`);
}

// -------------------------------------------------------------------- dispatch
async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (command === "hook") {
    // Hooks must NEVER fail the session: own try/catch → always exit 0.
    const sub = args.shift();
    let payload = {};
    try { payload = JSON.parse(readStdin() || "{}"); } catch { payload = {}; }
    try { runHook(sub, payload); } catch (error) {
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        const errFile = join(STATE_DIR, "hook.err");
        try { chmodSync(errFile, 0o600); } catch { /* not created yet */ } // tighten before writing
        appendFileSync(errFile, `${new Date().toISOString()} ${sub}: ${error.message}\n`, { mode: 0o600 });
      } catch { /* ignore */ }
    }
    // Do NOT process.exit() here — that can truncate a buffered stdout write and
    // corrupt the hook JSON. Returning lets the event loop drain stdout, then exit 0.
    process.exitCode = 0;
    return;
  }

  if (!command || ["--help", "-h", "help"].includes(command)) return help(args[0]);
  if (args.includes("--help") || args.includes("-h")) return help(command);
  if (command === "login") return login(args);
  if (command === "sync") process.exit(sync(args));
  if (command === "collect") process.exit(collect(args));
  if (command === "task") return task(args);
  if (command === "burn") return burn();
  if (command === "doctor") return doctor();
  if (command === "config") return showConfig();
  if (command === "contract") return contract();
  if (command === "migrate") return migrate();
  if (command === "refresh") { installLauncher(); return; }
  if (command === "uninstall") return uninstall(args);
  fail(`unknown command: ${command} (try: cc-usage help)`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(error.exitCode || 1);
}
