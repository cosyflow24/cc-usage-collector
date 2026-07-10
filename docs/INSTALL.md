# Install / update / uninstall (colleagues)

This repo installs **usage tracking** — the team-wide metric (tokens, cost,
active-time per session/project/Jira-task). Nothing else runs on your machine.

## First time

No shared secret to hand out: the **dashboard login is the gate**.

1. Open the dashboard → **Enroll a device** (`/enroll`), log in, enter your
   `@nnb24.de` Claude work email → copy the one-line command.
2. Paste it into a terminal — it clones this repo and installs with your personal
   upload token baked in:

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git && cd cc-usage-collector \
  && CC_USAGE_INGEST_TOKEN='<token-from-/enroll>' bash install.sh
```

The token uploads usage only — it is **not** the dashboard password, and it can be
revoked individually in the admin area.

## What it installs

- SessionStart/End hooks + the `/task` and `/burn` commands.
- A daily upload of your usage to the team backend.
- State lives under `~/.claude/cc-usage/`.

## Update

```bash
cd cc-usage-collector && git pull && bash install.sh   # idempotent — safe to re-run
```

`install.sh` reuses your saved token, so no re-enroll is needed.

## Uninstall

```bash
bash skill/cc-usage-sync/scripts/uninstall-hooks.sh
```

Removes the hooks + commands and restores `settings.json` from its backup.

## Requirements

Node 22+, `git`, and the Atlassian MCP connected in Claude Code (only if you use
`/task` to attribute sessions to Jira issues).
