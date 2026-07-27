---
description: Attribute the current Claude Code session to an existing Jira key (cc-usage metadata only)
allowed-tools: Bash(bash:*)
---

# /task

Record usage attribution only. This command must never read, create, edit,
transition, comment on, or authenticate to Jira. It needs no Jira CLI, API token,
MCP, or cached Jira identity.

Accepted forms:

- `last` — run `bash ~/.claude/cc-usage/bin/set-task.sh last`.
- `none` — run `bash ~/.claude/cc-usage/bin/set-task.sh none`.
- `KEY` — validate `^[A-Z][A-Z0-9]+-[0-9]+$`, then run
  `bash ~/.claude/cc-usage/bin/set-task.sh KEY`.
- `TASK EPIC` — validate both keys, then run
  `bash ~/.claude/cc-usage/bin/set-task.sh TASK EPIC`.

Do not infer whether a key is a Task, Epic, Story, Bug, or sub-task. Do not
invent, validate, or create a key. If the user describes new work instead of
providing an existing key, explain that `/task` only records an existing key and
ask them to create the Jira issue through the separate company Jira plugin.

Confirm only what `set-task.sh` recorded, in the user's language.
