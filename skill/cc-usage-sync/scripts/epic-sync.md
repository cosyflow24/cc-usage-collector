# epic-sync (MCP-bound — runs only inside a Claude Code session)

Enrich `cc_sessions` with Jira **epic** attribution by resolving each task key's
parent epic via the **Atlassian MCP**, then caching it in `jira_issue` and
backfilling `cc_sessions.epic_key` / `cc_sessions.epic_summary`.

> **This is NOT run by the headless collector.** `cc-usage --upload` and the
> SessionEnd `sync.sh` hook never touch Jira — employee machines hold no Jira
> credentials. Epic resolution needs the Atlassian MCP, which only exists inside
> an interactive Claude Code session connected to the server-side Atlassian
> integration. Run this manually (or on a server cron'd Claude session) where
> that MCP is available.

## Prerequisites

- A Claude Code session with the **Atlassian MCP** tools available
  (`mcp__*Atlassian__getJiraIssue`, …).
- DB access via the collector's env: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
  (or `SUPABASE_KEY`). The helper below uses the same `supabaseFromEnv()` the
  collector uses. `DATABASE_URL` is the web app's path; this step uses Supabase.

## What it does (idempotent)

1. **Find unsynced task keys** — distinct `cc_sessions.jira_key` where
   `epic_key is null`, excluding any key whose `jira_issue.synced_at` is within
   the last **12h** (so re-runs are cheap and don't re-hit Jira).
2. **Resolve each key via MCP** — `getJiraIssue` to read the task's summary,
   type, status, assignee, and its **parent epic** (key + summary).
3. **Persist** — upsert `jira_issue` rows (task + epic stub) and backfill
   `cc_sessions.epic_key` / `epic_summary` for sessions whose `jira_key` matches
   and whose `epic_key` is still null (never clobbers an explicit `/task` epic).

Steps 1 and 3 are pure DB; step 2 is the only MCP-bound part.

## Procedure for the Claude session

### Step 1 — list the keys to resolve

Run this from the repo root (it prints a JSON array of task keys):

```bash
pnpm --filter @cc-usage/collector exec tsx -e '
  import { readUnsyncedTaskKeys } from "./src/epic-backfill.ts";
  const keys = await readUnsyncedTaskKeys(12); // 12h skip window
  process.stdout.write(JSON.stringify(keys));
'
```

If the array is empty, stop — nothing to sync.

### Step 2 — resolve each key via Atlassian MCP

For each key in the array, call the Atlassian MCP `getJiraIssue` tool (e.g.
`mcp__claude_ai_Atlassian__getJiraIssue` with `issueIdOrKey: "<KEY>"`). From the
response extract:

- the task's `summary`, issue `type` (`fields.issuetype.name`),
  `status` (`fields.status.name`), `assignee`
  (`fields.assignee.displayName`),
- the **parent epic**: the parent link / epic-link field (commonly
  `fields.parent` for team-managed projects, or the epic-link custom field for
  company-managed). Read the epic's `key` and `summary`. If the issue has no
  epic, record `epicKey: null`.

Build a JS object literal mapping each task key to its resolved fields, matching
the `ResolvedIssue` shape:

```
{ "<TASK-KEY>": { epicKey, epicSummary, type, status, assignee, summary }, ... }
```

Use `epicKey: null` (and `epicSummary: null`) for tasks with no epic so they
still get a `jira_issue` row and are skipped on the next 12h window.

### Step 3 — persist via the backfill helper

Write the resolved map to a temp JSON file, then call the helper. Example
(replace the inline JSON with the map you assembled in Step 2):

```bash
cat > /tmp/cc-usage-resolved.json <<'JSON'
{
  "KI-758": { "epicKey": "KI-700", "epicSummary": "Billing revamp",
              "type": "Story", "status": "In Progress",
              "assignee": "Jane Dev", "summary": "Add invoice export" }
}
JSON

pnpm --filter @cc-usage/collector exec tsx -e '
  import { readFileSync } from "node:fs";
  import { backfillEpics } from "./src/epic-backfill.ts";
  const raw = JSON.parse(readFileSync("/tmp/cc-usage-resolved.json", "utf8"));
  const map = new Map(Object.entries(raw));
  const res = await backfillEpics(map);
  console.log(JSON.stringify(res));
'
```

The helper upserts `jira_issue` (tasks + distinct epic stubs) and updates only
the still-unattributed sessions. It prints `{ issuesUpserted, sessionsUpdated }`.

### Step 4 — verify

Re-run Step 1; resolved keys should now be excluded (they have fresh
`jira_issue.synced_at` and/or `cc_sessions.epic_key` is set). The dashboard's
L2 epic view will group these tasks under their epic.

## Idempotency & safety notes

- **12h skip window** prevents re-querying Jira for keys synced recently.
- The session backfill uses `epic_key is null` as a guard, so an explicit
  per-session epic captured by `/task <TASK> <EPIC>` is never overwritten.
- No prompt/response content is read or written — only Jira metadata.
- Safe to re-run anytime; the same input rewrites the same rows.
