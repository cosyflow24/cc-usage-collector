---
description: Attribute the current Claude Code session to an existing Jira key (cc-usage metadata only)
allowed-tools: Bash(sh:*)
---

# /cc-usage:task

Record usage attribution only. This command must never read, create, edit,
transition, comment on, or authenticate to Jira. It needs no Jira CLI, API token,
MCP, or cached Jira identity.

The argument is exactly one of: `last`, `none`, a single Jira KEY, or `TASK EPIC`
(two keys). **Validate it first, then run `cc-usage task` with only the validated
value(s)** — never pass raw, unvalidated, or free-text input to the shell:

- `last` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task last`
- `none` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task none`
- a KEY matching `^[A-Z][A-Z0-9]+-[0-9]+$` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task <KEY>`
- two such KEYs `TASK EPIC` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task <TASK> <EPIC>`

If the argument is anything else — free text, a description of new work, or shell
metacharacters — do NOT run the command. Explain that `/cc-usage:task` only records
an EXISTING key (`/cc-usage:task KI-123`, `/cc-usage:task last`, or
`/cc-usage:task none`); creating a NEW issue is done through the separate company
Jira plugin first, then `/cc-usage:task <the new KEY>`. Do not infer whether a key
is a Task, Epic, Story, Bug, or sub-task, and do not invent, validate against Jira,
or create a key.

Confirm only what `cc-usage task` printed, in the user's language.
