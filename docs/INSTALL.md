# Install / update / uninstall (colleagues)

This repo installs **usage tracking** — the team-wide metric (tokens, cost,
active-time per session/project/Jira-task). Nothing else runs on your machine.

> Use your **Max** account email everywhere below (short `lastname@nnb24.de`, the
> extra one the company bought — not your `first.last@nnb24.de` Enterprise login).

## First time — plugin (recommended)

No terminal. In Claude Code:

```
/plugin marketplace add cosyflow24/cc-usage-collector
/plugin install cc-usage
```

Then get your token: open the **public** enrollment page your admin gives you
(e.g. `https://cc-usage.up.railway.app/enroll`), enter your Max email, copy the
token, and run:

```
/cc-usage-login <your-token>
```

Update any time: `/plugin update`.

## First time — script (alternative)

The `/enroll` page also hands you a one-liner for the terminal:

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git && cd cc-usage-collector \
  && CC_USAGE_INGEST_TOKEN='<token-from-/enroll>' bash install.sh
```

The token uploads usage **as you** only — it is **not** the dashboard password
(you never get one), it can only report metadata for your own account, and it can
be revoked individually. If you were handed someone else's token, re-enroll with
your own email and re-run — the new token overrides the old one.

## What it installs

- SessionStart/End hooks + the `/task` and `/burn` commands.
- A daily upload of your usage to the team backend.
- State lives under `~/.claude/cc-usage/`.

## Switching from the script install to the plugin

Optional — the script keeps working. But **never run both**: each wires its own
hooks, so both together = double uploads and a doubled `/task` prompt. To switch:

1. Remove the script hooks (keeps your token + history under `~/.claude/cc-usage/`):

   ```bash
   cd cc-usage-collector && bash skill/cc-usage-sync/scripts/uninstall-hooks.sh
   ```

2. `/plugin marketplace add cosyflow24/cc-usage-collector` → `/plugin install cc-usage`.
   Your saved token is reused — no `/cc-usage-login` needed.

## Update

**Plugin:** `/plugin update`. **Script:**

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
