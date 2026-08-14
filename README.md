# cc-usage — collector (employee install)

Reports your **Claude Code and Codex usage** (tokens, notional cost where a public
rate exists, coarse active hours) to
the team dashboard, grouped by project / Jira task. **Usage metadata only — never
your prompts or responses, no exact clock times.** For planning and cost insight,
**not** employee surveillance.

This repository is the **collector only**. The dashboard/server code lives in a
separate private repo — you don't need it and never see it.

It is also separate from `nnb-jira`: a Jira key here is only a usage label.
CCUsage has no Jira credentials and cannot perform Jira operations. There is no
supported `cc-usage-beta` or `nnb-jira-beta` plugin.

> **Which email?** Enter your `@nnb24.de` Claude work email. Have **two** logins
> — an **Enterprise** `first.last@nnb24.de` and a **Max** `lastname@nnb24.de`?
> Enroll the one you use most; **both are tracked automatically** — the client
> detects each session's account and uploads all of them, and your admin links
> both accounts to you in the dashboard. Nothing extra for you to do.

## Install — plugin (recommended)

Three lines in Claude Code, no terminal, no git, no npm:

```
/plugin marketplace add cosyflow24/cc-usage-collector
/plugin install cc-usage
```

Then get your personal upload token: open the **enrollment page** your admin
gives you (e.g. `https://cc-usage.up.railway.app/enroll`), enter your **Max**
email, copy the token, and run:

```
/cc-usage-login <your-token>
```

Done. Usage uploads on its own when a session ends. Update with
`claude plugin update cc-usage@cc-usage` and check locally with
`/cc-usage-doctor`. The enrollment page
is **public** (no login, no shared secret);
the token uploads **as you** only and can be revoked individually — you never
touch the dashboard.

### Codex

The same repository is also a Codex marketplace:

```bash
codex plugin marketplace add cosyflow24/cc-usage-collector
codex plugin add cc-usage@cc-usage
```

Start a new Codex thread, ask **“Set up CC Usage”**, then open `/hooks` and trust
the current CC Usage hooks. The setup skill installs the stable launcher before
it asks you to run `cc-usage login` in a normal terminal, so a fresh plugin
install never depends on a command that is not on PATH yet.

The shared hooks bind
`CODEX_THREAD_ID` directly, collect `~/.codex/sessions/**/*.jsonl`, and keep the
same metadata-only upload boundary.

## Install — script (alternative)

Prefer a terminal? The `/enroll` page also hands you a one-liner that clones this
repo and installs with your token baked in:

```bash
git clone https://github.com/cosyflow24/cc-usage-collector.git && cd cc-usage-collector \
  && CC_USAGE_INGEST_TOKEN='<token-from-/enroll>' bash install.sh
```

The installer is idempotent and will:

1. Check Node 22+ and pnpm — offering to install them (Homebrew/fnm, corepack) if missing.
2. Install the collector's dependencies (this repo has no dashboard, so it's small).
3. Save your personal upload token (from the env var above, or it prints the
   `/enroll` page URL and waits for you to paste one).
4. Wire up the Claude Code hooks and the `/cc-usage:task` + `/burn` commands.
5. Do a dry run (no upload) to prove parsing works.

Requirements: sign in with the relevant **@nnb24.de** work identity in Claude
Code and/or Codex. Each provider is resolved independently; personal-account
sessions are kept local and never uploaded.

## Already installed with the script? (switching to the plugin)

You don't have to switch — the script install keeps working. But the plugin
updates in one command and needs no terminal. **Do NOT run both**: each wires its
own hooks, so having both = every session uploads twice and asks for `/cc-usage:task`
twice. To switch cleanly:

1. Remove the script's hooks (this **keeps** your token + history in
   `~/.claude/cc-usage/`):

   ```bash
   cd cc-usage-collector && bash skill/cc-usage-sync/scripts/uninstall-hooks.sh
   ```

2. Install the plugin:

   ```
   /plugin marketplace add cosyflow24/cc-usage-collector
   /plugin install cc-usage
   ```

   Your saved token is reused — you do **not** need `/cc-usage-login` again.

## Updating

**Plugin install:**

```bash
claude plugin update cc-usage@cc-usage
```

Start a new Claude Code session and run `/cc-usage-doctor`.

**Script install:** point Claude Code at this repo and say **"update cc-usage"**
(it reads [docs/INSTALL.md](docs/INSTALL.md)), or by hand:

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
/cc-usage:task KI-758     # tag this session with an existing Jira key; no Jira connection
/cc-usage:task none       # don't track this session
/burn            # live: your current 5h rate-limit window usage + burn rate
```

The stable CLI works in both hosts:

```bash
cc-usage task BI-220                  # bind the current Claude/Codex session
cc-usage sessions BI-220 --json       # find both providers for a task
cc-usage context BI-220               # print local-only user/assistant context
cc-usage resume codex:<session-id>    # print the native codex resume command
```

In Codex, ask to load a Jira task or session ID. The bundled
`cc-usage-context` skill resolves the session and imports bounded local context.
Claude sessions are imported; Codex sessions can also be resumed natively.

The first prompt in a monitored project pauses once to ask which Jira task it's
for — just answer with `/cc-usage:task`.

`cc-usage` never authenticates to Jira and cannot create, edit, comment on, or
transition issues. Use the separate company Jira plugin for Jira work.

## Uninstalling the plugin

```bash
claude plugin uninstall cc-usage@cc-usage
claude plugin marketplace remove cc-usage  # optional: remove its marketplace too
```

This removes the plugin. Personal collector state under `~/.claude/cc-usage/`
is kept unless you explicitly use the script installer's `--purge` cleanup.

## Privacy

Uploaded: tokens, provider, notional cost where available, model, project folder,
git branch, Jira key, parent/root session IDs, agent role, and a
coarse hours-per-day estimate. **Not** stored: prompt/response content, exact
timestamps, work/attendance time. No automatic Jira worklog export, no per-person
ranking. The active-time figure is labelled "Claude-active time (estimate)" and is
explicitly **≠ working time**.

`cc-usage context` reads prompt/response text only from this machine and writes it
to stdout for the current assistant. It excludes developer/system messages and
tool payloads, never sends the text through the ingest API, and never stores a
second transcript copy.

## What it uploads to (your admin configures)

`CC_USAGE_INGEST_URL` (built in) with your personal `CC_USAGE_INGEST_TOKEN`
(enrolled for you). Tokens are per-account and individually revocable.
