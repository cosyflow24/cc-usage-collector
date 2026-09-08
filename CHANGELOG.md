# Changelog

## 0.7.2

- CLI 版本直接读取发布包元数据，避免 doctor 与 marketplace 版本漂移。
- 首次安装明确检查 PATH，并提供跨平台绝对 launcher 路径。

## 0.7.1

- 修复按目录静默继承旧 task、忽略新消息的问题。单独编号自动记录；句子、链接、多编号及描述交由宿主按当前意图解析，目标明确时自动更新，无需外部模型或 Jira 凭据。
- 恢复会话保留已选择的 task。目录历史仅为候选；保留不追踪和非交互模式。
- 仍按整个会话的最新 task 归属，不自动拆分历史耗时。

## 0.7.0

- The session-attribution prompt now names the ask-the-user tool the HOST
  actually has. It hardcoded "call the AskUserQuestion tool" in every variant,
  including the ones injected into Codex sessions, where no such tool exists — the
  agent was told to call something that is not there. Codex is now pointed at
  `request_user_input` (or `request_user_input_async` where the host only offers
  the sync form in Plan mode), matching the mapping this machine's Codex
  developer_instructions already prescribe. The test for it also sandboxes
  `CODEX_HOME`, because SessionStart reads `$CODEX_HOME/auth.json`.
- The worker claims each host for the day it actually runs
  (`autoupdate-done-<host>-<day>`, atomic `wx`) BEFORE installing. The daily
  marker is claimed once per worker at SessionStart, so a host that started
  after midnight belonged to the new day and was installed again by the next
  worker minutes later; recording the claim only after a successful install
  still let two live workers install the same host on the same day. The claim is
  taken immediately before the install command, after the optional marketplace
  refresh: a refresh that starts at 23:59 with the install at 00:01 belongs to
  the new day. A host whose claim for today already exists is skipped outright,
  refresh included. A test races a second worker's claim in during the refresh and
  asserts the first claim is neither overwritten nor followed by an install.
  An install claimed on one day but completed on the next (claimed 23:59:59,
  finished 00:00:01) claims the completion day as well, so the next worker on
  that day does not install the host again. The whole host update, from the
  day check to the completion claim, runs under a pid-bound install lock
  (`autoupdate-lock-<host>`): a second worker that meets a live holder waits
  for it (bounded by one install window) and then re-checks today's claim,
  instead of installing next to it across midnight or skipping and leaving the
  day without an update; a lock whose holder is dead or older than two install
  windows is broken inode-safely.
- Known limitation (accepted 2026-09-08): the day claims and the per-host
  install lock are user-space files. A worker that is suspended for many
  minutes at an arbitrary point inside the locking code (SIGSTOP, sleep) and
  resumes after another worker reclaimed its lock can run one extra
  `plugin update`/`plugin add`. The command is idempotent; the realistic cases
  (two SessionStarts a minute apart, an install straddling midnight, a crashed
  holder) are covered by tests.
- The existing autoupdate throttle test pinned only `PATH`, which is not
  isolation: `findExecutable()` falls back to absolute candidates such as
  `/opt/homebrew/bin/codex`. It now pins both host binaries, so the suite can no
  longer drive the machine's real CLI.

- Daily self-update now covers Codex as well as Claude Code. The plugin ships a
  Codex manifest and the README documents a Codex install, but the worker only
  ever ran `claude`, so every Codex install stayed pinned at its install-time
  version. Each host is updated independently: one host missing or failing never
  suppresses the other. The marketplace refresh step is not fatal: `codex plugin
  marketplace upgrade` exits non-zero on a marketplace added from a local path,
  which would otherwise abort the host before the install step ran. Each CLI call
  is capped at five minutes and killed with SIGKILL, because the default SIGTERM
  can be ignored; a killed CLI can still leave descendants holding the pipe, so
  the cap bounds the common case, not every case. The worker creates STATE_DIR
  itself so a direct `hook autoupdate-worker` call no longer loses its log.
- `.claude-plugin/marketplace.json` carried a stale `metadata.version`; it now
  tracks the plugin manifest.
- The detached update worker now has an `error` listener. `spawn()` reports
  failures such as EAGAIN asynchronously, and with no listener Node raised them
  as an uncaught exception that the surrounding try/catch could not see — it
  escaped the SessionStart hook.

Known gap, deliberately not fixed here: on Windows `where codex` resolves to
`codex.cmd`, which `execFileSync` cannot run directly, so the install step fails
there. The same has always been true for `claude.cmd`. A `cmd /s /c` wrapper was
tried and reverted — CMD re-parses its argument and drops the quoting around a
path containing spaces, and none of this can be verified from macOS. Fixing it
properly needs a Windows machine.

## Unreleased

- Auth hardening: `login` verifies the token live (read-only whoami) before
  storing — rejected tokens never reach the keyring, offline is tolerated;
  `doctor` gained the live check incl. enrolled-emails/oauth-coverage note;
  `/cc-usage-login` no longer accepts tokens in chat (terminal hidden input
  only, chat-pasted tokens are treated as burned); Windows tokens now use
  user-scoped DPAPI (ported from data-catalog).
- Unified interaction contract: drift, stale and the unattributed backstop now
  emit non-blocking AskUserQuestion instructions (clickable options mapping to
  exactly one deterministic `task` CLI call) instead of blocking bilingual text
  prompts. Headless sessions get no nudges at all. Slash commands stay as the
  manual fallback. New tests/hooks-interaction.test.mjs locks the contract.

## 0.3.2 — 2026-07-27

- Made the cached plugin subtree self-describing as ESM so the standalone
  collector executes outside the repository root.
- Extended doctor with a real standalone bundle smoke test.

## 0.3.1 — 2026-07-27

- Removed the legacy Jira automation audit uploader and direct database fallback.
- Kept employee uploads on the documented ingest API with an explicit wire projection.
- Removed personal local time transforms from the employee upload path.
- Fixed the packaged CLI for Node 26 by emitting exactly one shebang.
- Versioned local Jira task bindings as schema version 1 for safe optional consumers.
