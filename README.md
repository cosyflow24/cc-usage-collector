# cc-usage — collector (employee install)

Reports your **Claude Code usage** (tokens, notional cost, coarse active hours) to
the team dashboard, grouped by project / Jira task. **Usage metadata only — never
your prompts or responses, no exact clock times.** For planning and cost insight,
**not** employee surveillance.

This repository is the **collector only**. The dashboard/server code lives in a
separate private repo — you don't need it and never see it.

## Install

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git
cd cc-usage-collector
bash install.sh
```

The installer is idempotent and will:

1. Check Node 22+ and pnpm — offering to install them (Homebrew/fnm, corepack) if missing.
2. Install the collector's dependencies (this repo has no dashboard, so it's small).
3. **Enroll you automatically**: it reads your Claude OAuth work-account email and
   fetches your **personal upload token** from the server. You only type the shared
   **team enrollment secret** once (ask your admin). No token is hand-distributed.
4. Wire up the Claude Code hooks and the `/task` + `/burn` commands.
5. Do a dry run (no upload) to prove parsing works.

Requirements: signed into your **@nnb24.de** work account in Claude Code (Max or
Enterprise). Personal accounts are ignored and never uploaded.

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
