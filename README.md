# cc-usage — collector (employee install)

Reports your **Claude Code usage** (tokens, notional cost, coarse active hours) to
the team dashboard, grouped by project / Jira task. **Usage metadata only — never
your prompts or responses, no exact clock times.** For planning and cost insight,
**not** employee surveillance.

This repository is the **collector only**. The dashboard/server code lives in a
separate private repo — you don't need it and never see it.

## Install

Easiest: open the dashboard → **Enroll a device** (`/enroll`), log in, enter your
`@nnb24.de` work email, and copy the ready-made one-liner — it clones this repo and
installs with your **personal upload token** already baked in:

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git && cd cc-usage-collector \
  && CC_USAGE_INGEST_TOKEN='<token-from-/enroll>' bash install.sh
```

There is **no shared secret** to ask anyone for — the dashboard login is the gate,
and your token can be revoked individually.

The installer is idempotent and will:

1. Check Node 22+ and pnpm — offering to install them (Homebrew/fnm, corepack) if missing.
2. Install the collector's dependencies (this repo has no dashboard, so it's small).
3. Save your personal upload token (from the env var above, or it prints the
   `/enroll` page URL and waits for you to paste one).
4. Wire up the Claude Code hooks and the `/task` + `/burn` commands.
5. Do a dry run (no upload) to prove parsing works.

Requirements: signed into your **@nnb24.de** work account in Claude Code (Max or
Enterprise). Personal accounts are ignored and never uploaded.

## Updating

```bash
cd cc-usage-collector && git pull && bash install.sh
```

Installed **before 2026-07-14**? The repo history was rewritten and `git pull`
will error — run `git fetch origin && git reset --hard origin/main && bash
install.sh` instead (your token/config live in `~/.claude/cc-usage/` and
survive). Details: [docs/INSTALL.md](docs/INSTALL.md).

## Daily use

Nothing to do — usage uploads on its own when a session ends. Two commands:

```bash
/task KI-758     # tag this session to a Jira task (reads Jira; changes nothing there)
/task none       # don't track this session
/burn            # live: your current 5h rate-limit window usage + burn rate
```

The first prompt in a monitored project pauses once to ask which Jira task it's
for — just answer with `/task`.

## Privacy

Stored: tokens, notional cost, model, project folder, git branch, Jira key, and a
coarse hours-per-day estimate. **Not** stored: prompt/response content, exact
timestamps, work/attendance time. No automatic Jira worklog export, no per-person
ranking. The active-time figure is labelled "Claude-active time (estimate)" and is
explicitly **≠ working time**.

## What it uploads to (your admin configures)

`CC_USAGE_INGEST_URL` (built in) with your personal `CC_USAGE_INGEST_TOKEN`
(enrolled for you). Tokens are per-account and individually revocable.
