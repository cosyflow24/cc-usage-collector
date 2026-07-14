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

### `git pull` fails? (history was rewritten in July 2026)

If you installed **before 2026-07-14**, the repo history was rewritten and a
plain `git pull` errors with *"fatal: refusing to merge unrelated histories"*
or *"Your branch and 'origin/main' have diverged"*. Reset onto the new history
— your token and config live in `~/.claude/cc-usage/`, **not** in this folder,
so nothing is lost:

```bash
cd cc-usage-collector
git fetch origin && git reset --hard origin/main
bash install.sh          # re-wires hooks, reuses your saved token
```

Fully clean alternative (same result, fresh folder):

```bash
bash skill/cc-usage-sync/scripts/uninstall-hooks.sh   # keeps ~/.claude/cc-usage config
cd .. && rm -rf cc-usage-collector
git clone https://github.com/cosyflow24/cc-usage-collector.git && cd cc-usage-collector
bash install.sh          # finds your saved token → runs unattended, no re-enroll
```

## Uninstall

```bash
bash skill/cc-usage-sync/scripts/uninstall-hooks.sh
```

Removes the hooks + commands and restores `settings.json` from its backup.

## Requirements

Node 22+, `git`, and the Atlassian MCP connected in Claude Code (only if you use
`/task` to attribute sessions to Jira issues).
