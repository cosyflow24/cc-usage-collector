# cc-usage — collector (employee install)

Reports your **Claude Code usage** (tokens, notional cost, coarse active hours) to
the team dashboard, grouped by project / Jira task. **Usage metadata only — never
your prompts or responses, no exact clock times.** For planning and cost insight,
**not** employee surveillance.

This repository is the **collector only**. The dashboard/server code lives in a
separate private repo — you don't need it and never see it.

## Install

Open the **enrollment page** your admin gives you (e.g.
`https://cc-usage.up.railway.app/enroll`), type your **Max account** email, and
copy the ready-made one-liner. It clones this repo and installs with **your
personal upload token** already baked in:

> **Which email?** Enter your **Max** account — the short `lastname@nnb24.de` the
> company bought you, NOT your `first.last@nnb24.de` Enterprise login. Max is the
> account with opaque subscription billing, which is the whole point of tracking.
> If you sometimes switch to your Enterprise account, those sessions are simply
> skipped (its API usage is billed transparently already) — nothing breaks.

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git && cd cc-usage-collector \
  && CC_USAGE_INGEST_TOKEN='<token-from-/enroll>' bash install.sh
```

The enrollment page is **public** — no login, no shared secret. It only mints a
token bound to your own email; that token uploads usage **as you** and nothing
else, and it can be revoked individually. You never touch the dashboard.

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

Just point Claude Code at this repo and say **"update cc-usage"** — it reads
[docs/INSTALL.md](docs/INSTALL.md) and runs the right commands. Or by hand:

```bash
cd cc-usage-collector && git pull && bash install.sh
```

Installed **before 2026-07-14**? The repo history was rewritten and `git pull`
will error — run `git fetch origin && git reset --hard origin/main && bash
install.sh` instead (your token/config live in `~/.claude/cc-usage/` and
survive). Details: [docs/INSTALL.md](docs/INSTALL.md).

### Getting your own token (if you were given someone else's)

If you first installed with a **shared or someone else's** upload token, switch to
your own — one-time, ~30 seconds:

1. Open the enrollment page, enter **your** `@nnb24.de` email, copy the one-liner.
2. Run it in your existing checkout (or re-run the full clone command). The pasted
   `CC_USAGE_INGEST_TOKEN=…` **overrides** the old saved token — no manual cleanup:

   ```bash
   cd cc-usage-collector && CC_USAGE_INGEST_TOKEN='<your-new-token>' bash install.sh
   ```

From then on your usage uploads **as you**, and a plain `git pull && bash
install.sh` keeps reusing your token (no env var needed).

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
