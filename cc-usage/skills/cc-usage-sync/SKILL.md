---
name: cc-usage-sync
description: Sync this machine's Claude Code AI spend to the team backend. Parses
  the last day's session logs (tokens per model + notional USD cost, project, git
  branch, Jira task/epic) and uploads them. Also drives per-session task
  attribution — at each session start it asks which Jira epic/task you're on — and
  the /cc-usage:task command records it. Use when the user says "sync my CC usage", "upload
  usage", "record today's Claude Code spend", "attribute this session", or when
  a daily usage report is requested. Runs locally; metadata only.
allowed-tools: [Bash, Read]
---

# cc-usage-sync

Push this machine's Claude Code AI spend into the team backend, and attribute
each session to the Jira work it belongs to.

Everything runs through one CLI, `tools/cc-usage` (a dependency-free Node entry
point). The hooks call it as `cc-usage hook <event>`; you can also run it directly
from `${CLAUDE_PLUGIN_ROOT}/tools/cc-usage` or, after `cc-usage login`, as
`cc-usage` on your PATH (`~/.local/bin`).

## What it does

Reads `~/.claude/projects/**/*.jsonl`, groups by session, computes per-model
token totals + a **notional** USD cost (public API rates via ccusage — you are
on an enterprise seat and never billed per token), derives the project (from
cwd) and a Jira task/epic, then upserts into `cc_sessions` and `cc_daily`.
Only metadata is stored — never prompt or response text.

## Three moving parts

1. **Per-session task prompt** (`cc-usage hook prompt-submit`, a `UserPromptSubmit`
   hook): until the session is attributed, it `decision:block`s **once** with a
   FIXED English+German message asking you to run `/cc-usage:task`. Injected context
   (SessionStart/additionalContext) is treated as background and was not acted on
   reliably, so we block instead. Scoped to the configured project only; slash
   commands and empty prompts always pass; silent once recorded or skipped.
   It also does **drift detection**: if the git branch later points at a
   different Jira key than the one recorded, it nudges you once to `/cc-usage:task` switch.
   (`cc-usage hook session-start` is a `SessionStart` hook that maps
   cwd→sessionId so `/cc-usage:task` can find the live session, and auto-captures a
   key from the git branch when there is one.)
2. **`/cc-usage:task` command** (`cc-usage task` + a usage-only command doc):
   records the answer without connecting to Jira.
   - `/cc-usage:task KI-758` — record a key (task or epic)
   - `/cc-usage:task KI-758 KI-700` — task then epic
   - `/cc-usage:task none` — mark this session not tracked
   Appends `{schemaVersion: 1, sessionId, jira, epic?, cwd, ts}` to
   `~/.claude/cc-usage/tasks.jsonl`.
   The collector validates only key syntax. It never reads, creates, edits, or
   authenticates to Jira. If an epic is already known, pass it explicitly as the
   second key; backend enrichment can add metadata later.
3. **SessionEnd sync** (`cc-usage hook session-end` → `cc-usage sync`): runs
   `cc-usage --days 1 --upload` (scoped via `--project` when configured) when a
   session ends. Idempotent on `(user_id, session_id)` / `(user_id, day)`.

Auto-capture (part of `hook session-start`) also best-effort resolves a key from
`CC_JIRA` env → `<cwd>/.ccjira` file → git branch, as a fallback when you don't
answer explicitly. There is no project→key fallback: attribution must be an
explicit `/cc-usage:task` or a real branch/commit signal, so this scales company-wide.

## Install & login

Install the plugin from the team marketplace (`/plugin`), then log in once — the
token is stored in the OS keyring (macOS Keychain), never a plaintext file:

```bash
# interactive (hidden input), from a terminal:
cc-usage login
# or via the slash command with a token from the /enroll page:
#   /cc-usage:cc-usage-login ccu_...
```

`cc-usage login` also installs the `~/.local/bin/cc-usage` launcher. After a
plugin upgrade, run `cc-usage refresh` to re-point it (the SessionStart hook also
self-heals it). `cc-usage doctor` checks the whole install without uploading.

## Manual / preview

```bash
# Preview the last day (no upload):
cc-usage sync --dry-run
# or the full analyzer surface:
cc-usage collect --days 7 --json

# Sync the last day now:
cc-usage sync

# Backfill N days:
cc-usage sync --days 30
```

## Jira boundary

The employee collector stores Jira keys only as usage labels. Jira enrichment
belongs to the admin backend or the separate company Jira plugin. This plugin
ships no Jira credentials, MCP dependency, Jira API client, or write workflow.

## Configuration

- Token: OS keyring (macOS Keychain, service `cc-usage-ingest-token`); see
  `cc-usage config`. Pre-plugin plaintext `~/.claude/cc-usage/env` tokens are
  migrated into the keyring automatically on the first sync.
- Non-secret config: `~/.config/cc-usage/config.json` (ingest URL, email, project).
- Identity defaults to the Claude oauth email; override with `CC_USAGE_USER`.
- `CLAUDE_CONFIG_DIR` is honored throughout (state stays in `<dir>/cc-usage`).
