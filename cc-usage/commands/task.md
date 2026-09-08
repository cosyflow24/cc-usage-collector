---
description: Attribute the current Claude Code or Codex session to an existing Jira key (cc-usage metadata only)
allowed-tools: Bash(sh:*)
---

# /cc-usage:task

Record usage attribution only. This command must never read, create, edit,
transition, comment on, or authenticate to Jira. It needs no Jira CLI, API token,
MCP, or cached Jira identity.

The argument is `last`, `none`, or **any text that contains one or two Jira keys** —
a bare key (`BI-151`), a browse URL (`https://urari.atlassian.net/browse/BI-151`), or
a key inside a sentence. **Extract the key(s) first with the pattern
`[A-Z][A-Z0-9]+-[0-9]+` (any project prefix: BI, KI, ITS, KID, …), then run
`cc-usage task` with only the extracted, validated value(s)** — never pass the raw
URL, sentence, or shell metacharacters to the shell:

- `last` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task last`
- `none` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task none`
- input yielding exactly one key → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task <KEY>`
- input yielding two keys `TASK EPIC` → run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" task <TASK> <EPIC>`

For two keys, the FIRST match is the task and the SECOND is the epic unless the user
says otherwise. If the user asks you to figure out which key is the Epic (or whether a
key is a Task/Bug/Story/sub-task), you MAY look that up through the separate company
Jira plugin and reorder accordingly — but `/cc-usage:task` itself still records only
the key(s); it never reads, creates, edits, or authenticates to Jira.

If the input yields NO key — free text, a description of new work, or shell
metacharacters with no `[A-Z][A-Z0-9]+-[0-9]+` match — do NOT run the command. Explain
that `/cc-usage:task` only records an EXISTING key (`/cc-usage:task KI-123`,
`/cc-usage:task last`, or `/cc-usage:task none`); creating a NEW issue is done through
the separate company Jira plugin first, then `/cc-usage:task <the new KEY>`. Do not
invent or create a key.

Confirm only what `cc-usage task` printed, in the user's language.
