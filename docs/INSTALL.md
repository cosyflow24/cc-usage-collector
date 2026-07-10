# Install / update / uninstall (colleagues)

The three client skills — **usage**, **jira**, **estimate** — install, update, and
remove independently. One entrypoint manages all three: `skill/cc-suite.sh`.

> You only need the colleague distribution repo (`cosyflow24/cc-usage-collector`),
> not the private monorepo. Clone it once; `cc-suite` lives at `skill/cc-suite.sh`.

## First time

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git
cd cc-usage-collector

# everything, or pick modules
bash skill/cc-suite.sh install all
# jira with the daily LaunchAgents:
bash skill/cc-suite.sh install jira -- --schedule
```

Then enroll for uploads once (usage module): run `install.sh` at the repo root, which
resolves your OAuth email and registers your account — see the collector README.

Tip: alias it — `alias cc-suite='bash ~/cc-usage-collector/skill/cc-suite.sh'`.

## Commands

| Command | Does |
|---|---|
| `cc-suite status` | which modules are installed + version vs repo |
| `cc-suite install [all\|usage\|jira\|estimate]` | install those modules |
| `cc-suite install jira -- --schedule` | pass args after `--` to the module's installer |
| `cc-suite update` | `git pull` + re-install whatever is already installed |
| `cc-suite uninstall [modules] [--purge]` | remove; `--purge` also deletes state |

## What each module installs

| Module | Command(s) / hooks | Namespace | Default |
|---|---|---|---|
| **usage** | SessionStart/End hooks, `/task`, `/burn`; daily upload | `~/.claude/cc-usage/` | on |
| **jira** | `/daily-fallback`, `/onhold`; Phase 2 hooks + LaunchAgents | `~/.claude/cc-jira/` | **all behaviors OFF** (opt-in per `config.json`) |
| **estimate** | `/estimate` | `~/.claude/cc-estimate/` | on |

The **jira** module ships every automation OFF. Turn behaviors on in
`~/.claude/cc-jira/config.json` (`startInArbeit`, `idleOnHold`, `eodDraft`,
`dailyReconcile`) once you've read what each does.

## Updating

```bash
cc-suite update      # pulls the repo, re-runs the installed modules' installers
```

Installers are idempotent — re-running never duplicates hooks or clobbers your
`config.json`. `cc-suite status` shows if your installed version lags the repo.

## Uninstalling

```bash
cc-suite uninstall jira            # remove one module (keeps its config/state)
cc-suite uninstall jira --purge    # also delete ~/.claude/cc-jira
cc-suite uninstall all --purge     # remove everything
```

Each uninstaller removes only its own hooks/commands/LaunchAgents (marker-scoped),
restores `settings.json` from its backup, and leaves the other modules and the
cc-usage collector untouched. If you ever enabled the jira Phase-4 **server-side**
Jira rule (not shipped by default), disable it in the Jira automation UI too — it
lives on the server, not on your machine.

## Requirements

- Node 22+, `git`, the Atlassian MCP connected in Claude Code (for jira/estimate).
- macOS for the jira LaunchAgents (`--schedule`); on Linux add the equivalent cron
  entries the installer prints.
