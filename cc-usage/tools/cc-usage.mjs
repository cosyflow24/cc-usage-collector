#!/usr/bin/env node
// Unified cc-usage CLI. One dependency-free ESM entry point over the collector
// bundle + OS-keyring credentials + the Claude Code/Codex hooks. Mirrors nnb-jira's
// tools/jira.mjs packaging (dispatch, options(), hiddenQuestion(), launcher).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  STATE_DIR, DEFAULT_INGEST_URL, DEFAULT_WORK_DOMAIN,
  jsonConfigFile, readConfig, writeConfig, readOauthEmail,
  readCodexOauthEmail,
  providerInstalled,
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
  loadCredentials, runCollector, runCollectorDetached, bundlePath,
} from "./core/collector.mjs";
import { sessionStart, promptSubmit } from "./core/hooks.mjs";
import { runUpdateWorker } from "./core/autoupdate.mjs";
import { refreshOpenIssues } from "./core/issues.mjs";
import { attributionVerdict, verifyToken } from "./core/verify.mjs";
import { findSessions, renderContext } from "./core/context.mjs";
import { resolveRuntime } from "./resolver.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
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
  // Live pre-check BEFORE storing (family pattern): a rejected token never
  // lands in the keyring; an unreachable dashboard is tolerated (offline
  // login) and re-checked by doctor later.
  const check = await verifyToken(ingestUrl, token);
  if (check.verdict === "rejected") {
    fail(`the dashboard rejected this token — re-enroll at ${enrollUrl(ingestUrl)}`, 2);
  }
  if (check.verdict === "unreachable") {
    process.stderr.write("WARNING: could not reach the dashboard to verify the token; storing anyway — run cc-usage doctor once online.\n");
  } else if (check.enrolledEmails.length) {
    out(`Token verified — uploads as: ${check.enrolledEmails.join(", ")}`);
    // "Verified" is about the TOKEN, not about whether this machine can
    // actually upload. Enrolling a shared account without the operator field
    // produces a token the dashboard accepts and then 403s on every upload —
    // so login used to print a clean success at the exact moment the user got
    // stuck, and they only found out if they later thought to run doctor. Same
    // verdict function doctor uses, so the two cannot drift.
    const domain = cfg.workDomain || DEFAULT_WORK_DOMAIN;
    for (const [provider, me] of [["Claude", readOauthEmail()], ["Codex", readCodexOauthEmail()]]) {
      if (!me) continue;
      const verdict = attributionVerdict({
        me,
        provider,
        domain,
        operator: check.operator,
        enrolledEmails: check.enrolledEmails,
        sharedAccounts: check.sharedAccounts,
        sharedKnown: check.sharedKnown,
      });
      if (verdict.level !== "ok") process.stderr.write(`${verdict.message}\n`);
      else out(verdict.message);
    }
  }
  const email = cfg.email || check.enrolledEmails[0] || readOauthEmail() || readCodexOauthEmail() || "default";
  const where = storeToken(email, token);
  writeConfig({
    ingestUrl,
    email,
    project: cfg.project,
    user: cfg.user,
    workDomain: cfg.workDomain,
  });
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

async function sessions(args) {
  const { positional, values } = options(args, { "--json": "!json" });
  const selector = positional.join(" ").trim();
  if (!selector) fail("usage: cc-usage sessions <session-id|Jira-key|project> [--json]");
  const found = await findSessions(selector);
  if (values.json) {
    out(JSON.stringify(found.map(({ file: _file, ...row }) => row), null, 2));
    return;
  }
  if (!found.length) fail(`no local session found for ${selector}`, 2);
  for (const row of found) {
    out(`${row.provider}:${row.sessionId}\t${row.jira || "unassigned"}\t${row.cwd || "unknown"}\t${row.timestamp || ""}`);
  }
}

async function context(args) {
  const { positional, values } = options(args, { "--max-chars": "maxChars" });
  const selector = positional.join(" ").trim();
  if (!selector) fail("usage: cc-usage context <session-id|Jira-key|project> [--max-chars N]");
  const maxChars = values.maxChars === undefined ? undefined : Number(values.maxChars);
  if (maxChars !== undefined && (!Number.isFinite(maxChars) || maxChars < 2000)) {
    fail("--max-chars must be a number >= 2000");
  }
  out(await renderContext(selector, { maxChars }));
}

async function resume(args) {
  const { positional, values } = options(args, { "--exec": "!exec" });
  const selector = positional.join(" ").trim();
  if (!selector) fail("usage: cc-usage resume <session-id|Jira-key|project> [--exec]");
  const found = await findSessions(selector);
  if (!found.length) fail(`no local session found for ${selector}`, 2);
  const session = found[0];
  if (session.provider !== "codex") {
    out(await renderContext(`claude:${session.sessionId}`));
    process.stderr.write("Claude sessions cannot be resumed natively in Codex; local context was emitted instead.\n");
    return;
  }
  if (!values.exec) {
    out(`codex resume ${session.sessionId}`);
    return;
  }
  if (process.env.CODEX_THREAD_ID) {
    fail("cannot start a nested interactive Codex session; run the printed resume command in a terminal", 2);
  }
  const result = spawnSync("codex", ["resume", session.sessionId], { stdio: "inherit" });
  if (result.status !== 0) fail(`codex resume exited ${result.status ?? 1}`, result.status ?? 1);
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
    capabilities: [
      "collect", "sync", "task-attribution", "local-context", "codex-resume",
      "hooks", "burn", "keyring",
    ],
    state: { dir: STATE_DIR, schemaVersion: 1 },
  }, null, 2));
}

function migrate() {
  const { token, url } = loadCredentials({ notify: true });
  out(token ? `cc-usage: credentials ready (ingest ${url}).` : "cc-usage: no token found. Run  cc-usage login.");
}

async function doctor() {
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
  const token = loadToken(cfg);
  if (token) ok("upload token set (hidden)"); else nope("no upload token — run cc-usage login");
  out(`     secret: ${secretDescription()}`);
  // WHICH ACCOUNT IS THIS MACHINE SIGNED IN TO. Checked here, ABOVE the live
  // dashboard call, because it is a fact about this machine: an offline or
  // unreachable dashboard must not hide it. Both hosts, because this plugin
  // ships a Codex manifest and a Codex-only install is a real shape - reading
  // only ~/.claude.json gave those colleagues "not signed in" and a healthy
  // exit code.
  // PER PROVIDER, not "neither of them". An earlier version failed only when
  // BOTH identities were unreadable — so a machine with a readable Codex login
  // and an unreadable Claude one printed a Codex verdict, said nothing at all
  // about Claude, and exited 0 with "healthy", while every Claude session was
  // dropped as `unknown-claude-account` and uploaded nowhere. Narrowing the
  // blast radius of a silent-total-loss bug is not fixing it.
  //
  // `providerInstalled` separates "this host is not on this machine" (nothing to
  // report) from "this host is here but its account cannot be read" (every one
  // of its sessions is unattributable and therefore never uploaded).
  const providers = [
    ["Claude", "claude", readOauthEmail()],
    ["Codex", "codex", readCodexOauthEmail()],
  ];
  const signedIn = providers.filter(([, , email]) => email).map(([label, , email]) => [label, email]);
  if (token) {
    for (const [label, key, email] of providers) {
      if (email || !providerInstalled(key)) continue;
      nope(
        `${label} is installed here but its account cannot be read. Since 0.9.0 a session `
        + "whose account is unknown is never uploaded (that is deliberate — it could be a "
        + `private account), so every ${label} session on this machine is dropped and `
        + "uploads NOTHING. Sign in again "
        + (key === "codex" ? "with `codex login`" : "with `/login` in Claude Code")
        + ", then re-run this check.",
      );
    }
    if (!signedIn.length && !providers.some(([, key]) => providerInstalled(key))) {
      nope(
        "no Claude or Codex account file found on this machine, so nothing can be attributed "
        + "and nothing will be uploaded. Sign in to at least one host, then re-run this check.",
      );
    }
  }

  if (token) {
    // Live introspection (read-only whoami): rejected = real failure;
    // unreachable = neutral (never a reason to drop the token).
    const live = await verifyToken(cfg.ingestUrl, token);
    if (live.verdict === "ok") {
      ok(`live check: token accepted (uploads as: ${live.enrolledEmails.join(", ") || "?"})`);
      // WHO the usage lands under. On a shared Claude account the account email
      // is not a person, so this line is the only place a user can see whether
      // their work is being recorded under them or is about to be rejected.
      if (live.operator) {
        // Precise wording on purpose: for a PERSONAL account the row is
        // attributed through the account-to-employee mapping, not through this
        // value, so calling it "attributed to" would be wrong there.
        ok(`token belongs to: ${live.operator} (decides attribution on a shared account)`);
      }
      // The verdict a new colleague actually needs, DECIDED rather than
      // described. Until the dashboard reported which accounts are shared, this
      // could only recite "fine for a personal account, fatal for a shared one"
      // and leave the reader to work out which they had - so a setup that would
      // 403 on every upload still printed "cc-usage doctor: healthy". The
      // decision itself is a pure function so it can be tested without a
      // dashboard; this only renders it.
      // BOTH hosts, not just Claude. This plugin ships a Codex manifest and the
      // README documents a Codex install, so a Codex-only colleague is a real
      // install shape - and reading only ~/.claude.json gave them me === "",
      // the "not signed in" note, and `cc-usage doctor: healthy` followed by
      // silent 403s on every upload. That is the exact failure this verdict
      // exists to end, and it was fixed for one provider only.
      const domain = cfg.workDomain || DEFAULT_WORK_DOMAIN;
      for (const [provider, me] of signedIn) {
        const verdict = attributionVerdict({
          me,
          provider,
          domain,
          operator: live.operator,
          enrolledEmails: live.enrolledEmails,
          sharedAccounts: live.sharedAccounts,
          sharedKnown: live.sharedKnown,
        });
        if (verdict.level === "fail") nope(verdict.message);
        else if (verdict.level === "ok") ok(verdict.message);
        else out(`     ${verdict.message}`);
      }
    } else if (live.verdict === "rejected") {
      nope("live check: the dashboard rejected the token — re-enroll and run cc-usage login");
    } else {
      out("     live check: dashboard unreachable (offline?) — token kept, try again later.");
    }
  }
  if (existsSync(jsonConfigFile)) ok(`config ${jsonConfigFile}`); else out("     (no config.json yet)");

  try { mkdirSync(STATE_DIR, { recursive: true }); ok(`state dir ${STATE_DIR}`); } catch { nope(`state dir not writable: ${STATE_DIR}`); }

  const launcher = launcherPath();
  if (existsSync(launcher)) { if (ownsLauncher(launcher)) ok(`launcher ${launcher}`); else nope(`foreign launcher at ${launcher}`); }
  else out("     (launcher not installed — run cc-usage login or cc-usage refresh)");

  if (existsSync(resolverPath)) ok(`resolver ${resolverPath}`);
  else nope(`resolver copy missing (${resolverPath}) — run cc-usage refresh from the installed plugin`);
  const runtime = resolveRuntime();
  if (runtime) ok(`runtime ${runtime.version} at ${runtime.root}`);
  else nope("no valid plugin runtime registered — run cc-usage refresh, or reinstall the plugin");

  const legacyEnv = join(STATE_DIR, "env");
  if (existsSync(legacyEnv) && /CC_USAGE_INGEST_TOKEN=\S/.test(readFileSync(legacyEnv, "utf8"))) {
    out("     note: plaintext token still in env — it migrates to the keyring on the next sync.");
  }
  const plist = join(homedir(), "Library", "LaunchAgents", "com.nnb24.cc-usage-sync.plist");
  if (existsSync(plist)) {
    const compat = join(STATE_DIR, "bin", "sync.sh");
    if (!existsSync(compat)) {
      out("     LaunchAgent present; run cc-usage refresh so the compat bin/sync.sh regenerates.");
    } else if (readFileSync(compat, "utf8").includes(resolverPath)) {
      out("     LaunchAgent present; bin/sync.sh points at the stable resolver.");
    } else {
      nope("bin/sync.sh still points at a versioned path — run cc-usage refresh to heal it");
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
  // Detached child spawned by scheduleRefresh(): refills the open-issue cache
  // out of band, so no session start ever waits on the Jira gateway.
  if (sub === "issues-refresh") { refreshOpenIssues(); return; }
  if (sub === "session-end") { runCollectorDetached(syncArgs("1", false)); }
}

function help(topic) {
  if (topic) { out(`See: cc-usage ${topic} --help (or the plugin SKILL.md).`); return; }
  out(`cc-usage ${VERSION}
  login [--stdin] [--url URL] [--no-open]   store the ingest token in the OS keyring
  sync [--days N] [--dry-run]               upload the last N days of usage
  collect [collector args...]               run the analyzer directly (passthrough)
  task <last|none|KEY> [EPIC]               attribute this session to a Jira key
  sessions <ID|KEY|project> [--json]        find matching Claude/Codex sessions
  context <ID|KEY|project> [--max-chars N]  print local-only conversation context
  resume <ID|KEY|project> [--exec]          print/run native Codex resume; import Claude context
  burn                                      live 5h rate-limit window view
  doctor                                    health check (no upload)
  config | contract | migrate               show config / capabilities / migrate token
  refresh | uninstall [--purge --yes]       relink / remove the launcher
  hook <session-start|prompt-submit|session-end|issues-refresh>   internal (called by hooks.json)`);
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
  if (command === "sessions") return sessions(args);
  if (command === "context") return context(args);
  if (command === "resume") return resume(args);
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
