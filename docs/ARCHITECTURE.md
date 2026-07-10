# cc-usage — modules, repos, and distribution

Three concerns, one dev monorepo, one colleague-facing distribution repo. This
document is the authoritative arrangement; skills and READMEs point here.

## The three concerns

| # | Concern (DE) | What it does | Lives in |
|---|--------------|--------------|----------|
| 1 | **Usage / Verbrauch** | Measure tokens, cost, active-time per session/project/Jira-task; upload to Supabase; show the dashboard. | `packages/collector`, `apps/web`, `supabase`, `skill/cc-usage-sync` |
| 2 | **Jira-Disziplin** | Keep every ticket in a valid status daily (In Arbeit / On Hold), forced daily reconciliation. | `skill/cc-jira-discipline` |
| 3 | **Schätzung / Estimate** | Propose an Ursprüngliche Schätzung (calibrated PERT) + score estimate-vs-actual on the dashboard. | `packages/cc-estimate` (engine), `skill/cc-estimate` (command), `apps/web/app/accuracy` |

The data loop: **estimate → status → measure → score → recalibrate.**

## Why NOT three separate repos

The instinct is one repo per concern. Don't — it fragments what is genuinely shared
and coupled:

- The three skills share client plumbing: `~/.claude/cc-usage/tasks.jsonl` (session→KEY
  binding), `jira-cache.sh`, the ingest env, the Atlassian MCP cloudId convention. Three
  repos would either duplicate this or need a shared-lib repo + cross-repo versioning.
- The **estimate engine** (`packages/cc-estimate`) reads collector output and feeds the
  dashboard accuracy page — it is coupled to concern #1 on the server side. Splitting it
  out means maintaining a versioned cross-repo contract for no real gain.
- **Independent install / update / uninstall is already achieved** at the *skill* level
  (each has its own `install.sh` / `uninstall.sh` and its own `~/.claude/<ns>/` namespace).
  You get modularity without repo fragmentation.
- Industry norm: monorepo for development, a thin distribution layer for install. This is
  exactly how the collector was first split out.

**Modularity lives at the skill granularity, not the repo granularity.** Each skill
installs, updates, and uninstalls on its own; none depends on another being installed.

## The two repos

### `cosyflow24/cc-usage` — private monorepo (dev source of truth)

Everything, evolving atomically:

```
packages/collector        usage measurement engine (TS)
packages/cc-estimate      PERT estimate engine (TS, tested)
apps/web                  Next.js dashboard (private — has cost data) → Railway
supabase/migrations       shared DB schema
skill/cc-usage-sync       usage sync skill (source)
skill/cc-jira-discipline  Jira-status skill (source)
skill/cc-estimate         estimate command skill (source)
```

Private because the dashboard exposes company cost/usage. This is where Claude works and
where all cross-module changes land in one commit.

### `cosyflow24/cc-usage-collector` — colleague-facing distribution

The installable **client** bundle each developer clones. Synced from the monorepo (the
same `git archive HEAD` flow that seeded it), NOT hand-edited:

```
packages/collector        collector runtime
skill/cc-usage-sync       + install.sh / uninstall.sh
skill/cc-jira-discipline  + install.sh / uninstall.sh
skill/cc-estimate         + install.sh / uninstall.sh
cc-suite                  top-level install / update / uninstall / status manager
```

No `apps/web`, no `supabase`, no dashboard code (that's the whole reason the collector was
split off in the first place — colleagues must not see dashboard internals).

## Install / update / uninstall (for colleagues)

One entrypoint, `cc-suite`, dispatches to each skill's own installer. See
[INSTALL.md](./INSTALL.md). Each skill:

- installs into its own `~/.claude/<namespace>/` (`cc-usage`, `cc-jira`, `cc-estimate`),
- writes a `VERSION` marker so `cc-suite update` / `status` can compare,
- is fully reversible via its `uninstall.sh` (removes hooks/commands/LaunchAgents/state).

`cc-suite update` = `git pull` the distribution repo + re-run the installed skills'
idempotent `install.sh`. `cc-suite status` shows which of the three are installed and at
what version.

## Sync monorepo → distribution

The distribution repo is a **derived artifact**. Never commit skill/collector changes
directly to `cc-usage-collector`; change them in the monorepo, then sync (script:
`scripts/sync-collector.sh`, TODO — currently the `git archive HEAD` flow). This keeps a
single source of truth and prevents drift (the two `cc-usage-sync` copies are already
kept identical this way).

## If you still want repo-per-module later

Only worth it if a module gets an *external* audience (open-sourced, or consumed by
another team). At that point, split the leaf that has no inbound coupling first —
`cc-jira-discipline` is the cleanest candidate (it only reads cc-usage state, nothing
depends on it). `cc-estimate` should stay near the dashboard until the accuracy loop
stabilizes.
