---
name: cc-usage-sync
description: Sync this machine's Claude Code AI spend to the team backend. Parses
  the last day's session logs (tokens per model + notional USD cost, project, git
  branch, Jira task/epic) and uploads them. Also drives per-session task
  attribution — at each session start it asks which Jira epic/task you're on — and
  the /task command records it. Use when the user says "sync my CC usage", "upload
  usage", "record today's Claude Code spend", "attribute this session", "同步用量",
  "上传用量统计", or when a daily usage report is requested. Runs locally; metadata only.
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
   FIXED English+German message asking you to run `/task`. Injected context
   (SessionStart/additionalContext) is treated as background and was not acted on
   reliably, so we block instead. Scoped to `CC_USAGE_PROJECT` only; slash
   commands and empty prompts always pass; silent once recorded or skipped.
   It also does **drift detection**: if the git branch later points at a
   different Jira key than the one recorded, it nudges you once to `/task` switch.
   (`scripts/session-prompt.sh` is a `SessionStart` hook that only maps
   cwd→sessionId so `/task` can find the live session.)
2. **`/task` command** (`scripts/set-task.sh` + the MCP-aware command doc):
   records the answer.
   - `/task KI-758` — record a key (task or epic)
   - `/task KI-758 KI-700` — task then epic
   - `/task none` — mark this session not tracked
   Appends `{sessionId, jira, epic?, cwd, ts}` to `~/.claude/cc-usage/tasks.jsonl`.
   **Type alignment / creation (agent + Atlassian MCP):** a bare key does not
   reveal Epic vs Task. When the MCP is connected, the agent looks it up
   (issuetype) and records epic vs task+parent correctly. To start NEW work the
   agent creates the issue via MCP — a Task under an Epic, or a new Epic — then
   records it. **Never create a sub-task under a task** (tasks are the lowest
   level tracked). When the MCP is offline, the raw key is recorded and the
   epic-sync step resolves the type later.
3. **SessionEnd sync** (`scripts/sync.sh`): runs `cc-usage --days 1 --upload`
   (scoped to `CC_USAGE_PROJECT` via `--project`) in the background when a
   session ends. Idempotent on `(user_id, session_id)` / `(user_id, day)`.

Auto-capture (`scripts/capture-task.sh`) also best-effort resolves a key from
`CC_JIRA` env → `<cwd>/.ccjira` file → git branch, as a fallback when you don't
answer explicitly. There is no project→key fallback: attribution must be an
explicit `/task` or a real branch/commit signal, so this scales company-wide.

## Install

```bash
./install.sh        # from the repo root — prompts for ingest URL + token,
                    # merges hooks, installs /task, runs a dry-run.
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

## Epic sync (MCP-bound, not run by the collector)

Task/epic mapping in the dashboard is enriched from Jira (`jira_issue` table).
Epic metadata comes from the explicit `/task ... <EPIC>` capture plus an
MCP-bound epic-sync step. That step resolves each task's parent epic via the
Atlassian MCP and backfills `cc_sessions.epic_key` / `epic_summary` — it runs
**only inside a Claude Code session** with the Atlassian MCP, never from the
headless collector or the SessionEnd hook (employee machines hold no Jira
credentials). See `scripts/epic-sync.md` for the procedure; the pure-DB writes
live in `packages/collector/src/epic-backfill.ts`.

## Configuration

- `~/.claude/cc-usage/env` (written by `install.sh`): `CC_USAGE_INGEST_URL`,
  `CC_USAGE_INGEST_TOKEN`, `CC_USAGE_REPO`. Loaded by `sync.sh`.
- Identity defaults to `git config user.email`; override with `CC_USAGE_USER`.
- `CLAUDE_CONFIG_DIR` is honored throughout (defaults to `~/.claude`).
