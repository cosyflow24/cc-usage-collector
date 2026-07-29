---
description: Attribute the current Claude Code session to an existing Jira key (cc-usage metadata only)
allowed-tools: Bash(bash:*)
---

# /cc-usage:task

Record usage attribution only. This command must never read, create, edit,
transition, comment on, or authenticate to Jira. It needs no Jira CLI, API token,
MCP, or cached Jira identity.

The attribution is recorded **deterministically** by the line below: it runs
`set-task.sh` with your argument the moment `/cc-usage:task` is invoked, so binding never
depends on the assistant choosing to act. `set-task.sh` itself validates the
argument (`last`, `none`, a `KEY`, or `TASK EPIC`) and rejects anything else.

!`bash ~/.claude/cc-usage/bin/set-task.sh $ARGUMENTS 2>&1 || true`

Now report to the user, in their language, exactly what `set-task.sh` printed above:

- Success (`session attributed to …` or `marked not tracked`): confirm it, nothing more.
- `not a Jira key: …`: the argument was not an existing key. Explain that `/cc-usage:task` only
  records an EXISTING key (`/cc-usage:task KI-123`, `/cc-usage:task last`, or `/cc-usage:task none`) and that
  creating a NEW issue is done through the separate company Jira plugin first — then
  run `/cc-usage:task <the new KEY>`. Do not invent, validate, or create a key yourself.
- `no previous task recorded` or the usage text: ask the user to pass an explicit key.

Do not infer whether a key is a Task, Epic, Story, Bug, or sub-task.
