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

## What it does

Reads `~/.claude/projects/**/*.jsonl`, groups by session, computes per-model
token totals + a **notional** USD cost (public API rates via ccusage — you are
on an enterprise seat and never billed per token), derives the project (from
cwd) and a Jira task/epic, then upserts into `cc_sessions` and `cc_daily`.
Only metadata is stored — never prompt or response text.

## Three moving parts

1. **Per-session task prompt** (`scripts/ask-task.sh`, a `UserPromptSubmit`
   hook): until the session is attributed, it `decision:block`s **once** with a
   FIXED English+German message asking you to run `/cc-usage:task`. Injected context
   (SessionStart/additionalContext) is treated as background and was not acted on
   reliably, so we block instead. Scoped to `CC_USAGE_PROJECT` only; slash
   commands and empty prompts always pass; silent once recorded or skipped.
   It also does **drift detection**: if the git branch later points at a
   different Jira key than the one recorded, it nudges you once to `/cc-usage:task` switch.
   (`scripts/session-prompt.sh` is a `SessionStart` hook that only maps
   cwd→sessionId so `/cc-usage:task` can find the live session.)
2. **`/cc-usage:task` command** (`scripts/set-task.sh` + a usage-only command doc):
   records the answer without connecting to Jira.
   - `/cc-usage:task KI-758` — record a key (task or epic)
   - `/cc-usage:task KI-758 KI-700` — task then epic
   - `/cc-usage:task none` — mark this session not tracked
   Appends `{schemaVersion: 1, sessionId, jira, epic?, cwd, ts}` to
   `~/.claude/cc-usage/tasks.jsonl`.
   The collector validates only key syntax. It never reads, creates, edits, or
   authenticates to Jira. If an epic is already known, pass it explicitly as the
   second key; backend enrichment can add metadata later.
3. **SessionEnd sync** (`scripts/sync.sh`): runs `cc-usage --days 1 --upload`
   (scoped to `CC_USAGE_PROJECT` via `--project`) in the background when a
   session ends. Idempotent on `(user_id, session_id)` / `(user_id, day)`.

Auto-capture (`scripts/capture-task.sh`) also best-effort resolves a key from
`CC_JIRA` env → `<cwd>/.ccjira` file → git branch, as a fallback when you don't
answer explicitly. There is no project→key fallback: attribution must be an
explicit `/cc-usage:task` or a real branch/commit signal, so this scales company-wide.

## Install

```bash
./install.sh        # from the repo root — prompts for ingest URL + token,
                    # merges hooks, installs /cc-usage:task, runs a dry-run.
```

Hooks-only re-install: `bash skill/cc-usage-sync/scripts/install-hooks.sh`.

Uninstall (removes only cc-usage hooks/scripts, keeps config): `bash skill/cc-usage-sync/scripts/uninstall-hooks.sh` (add `--purge` to also drop `~/.claude/cc-usage`).

## Manual / preview

```bash
# Preview the last day (no upload):
pnpm --filter @cc-usage/collector start -- --days 1

# Sync the last day:
bash ~/.claude/cc-usage/bin/sync.sh

# Backfill N days:
pnpm --filter @cc-usage/collector start -- --days 30 --upload
```

## Jira boundary

The employee collector stores Jira keys only as usage labels. Jira enrichment
belongs to the admin backend or the separate company Jira plugin. This plugin
ships no Jira credentials, MCP dependency, Jira API client, or write workflow.

## Configuration

- `~/.claude/cc-usage/env` (written by `install.sh`): `CC_USAGE_INGEST_URL`,
  `CC_USAGE_INGEST_TOKEN`, `CC_USAGE_REPO`. Loaded by `sync.sh`.
- Identity defaults to `git config user.email`; override with `CC_USAGE_USER`.
- `CLAUDE_CONFIG_DIR` is honored throughout (defaults to `~/.claude`).
