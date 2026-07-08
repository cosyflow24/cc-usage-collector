import { supabaseFromEnv } from "./supabase.ts";

/**
 * Epic backfill — pure DB writes, NO Atlassian MCP.
 *
 * The MCP round-trips (getJiraIssue per task key) happen in the Claude Code
 * session that drives the epic-sync step (see
 * skill/cc-usage-sync/scripts/epic-sync.md). That session collects the parent
 * epic + metadata for each task into a Map and then calls into this helper to
 * persist it. Keeping the writes here means the headless collector never needs
 * Jira credentials and the MCP-bound logic stays in the interactive session.
 *
 * Two effects per task key:
 *   1. upsert a `cc_jira_issue` row (the cached Jira dimension)
 *   2. backfill `cc_sessions.epic_key` / `cc_sessions.epic_summary` for every
 *      session whose `jira_key` matches that task
 *
 * Idempotent: re-running with the same input rewrites the same rows. The 12h
 * skip-window is enforced upstream (by readUnsyncedTaskKeys excluding keys
 * synced recently), not here — this helper always writes what it is given.
 */

/** Resolved Jira metadata for one task key (gathered via MCP in the session). */
export interface ResolvedIssue {
  /** Parent epic key, or null when the task has no epic. */
  epicKey: string | null;
  /** Parent epic summary, or null. */
  epicSummary: string | null;
  /** Issue type (Story, Task, Bug, …). */
  type: string | null;
  /** Workflow status (To Do, In Progress, Done, …). */
  status: string | null;
  /** Assignee display name / account id. */
  assignee: string | null;
  /** The task's own summary. */
  summary: string | null;
}

export interface BackfillResult {
  /** cc_jira_issue rows upserted (task rows + distinct epic rows). */
  issuesUpserted: number;
  /** cc_sessions rows whose epic_key/epic_summary were updated. */
  sessionsUpdated: number;
}

/** Build a cc_jira_issue row from a task key + its resolved metadata. */
function taskRow(key: string, r: ResolvedIssue) {
  return {
    key,
    type: r.type,
    summary: r.summary,
    epic_key: r.epicKey,
    epic_summary: r.epicSummary,
    status: r.status,
    assignee: r.assignee,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Persist resolved issues. Returns counts of rows written.
 *
 * @param resolved Map<taskKey, ResolvedIssue> assembled from MCP getJiraIssue calls.
 */
export async function backfillEpics(
  resolved: Map<string, ResolvedIssue>,
): Promise<BackfillResult> {
  if (resolved.size === 0) return { issuesUpserted: 0, sessionsUpdated: 0 };

  const sb = supabaseFromEnv();
  if (!sb) {
    throw new Error(
      "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY).",
    );
  }

  // Upsert task rows, plus a stub row per distinct epic so the epic key resolves
  // even before the epic itself is synced as a task. Task rows win on conflict
  // (they carry richer metadata), so write epic stubs first.
  const epicRows = new Map<
    string,
    { key: string; type: string; summary: string | null; synced_at: string }
  >();
  for (const r of resolved.values()) {
    if (r.epicKey && !epicRows.has(r.epicKey)) {
      epicRows.set(r.epicKey, {
        key: r.epicKey,
        type: "Epic",
        summary: r.epicSummary,
        synced_at: new Date().toISOString(),
      });
    }
  }

  if (epicRows.size > 0) {
    const { error } = await sb
      .from("cc_jira_issue")
      .upsert([...epicRows.values()], { onConflict: "key", ignoreDuplicates: true });
    if (error) throw new Error(`cc_jira_issue (epics) upsert failed: ${error.message}`);
  }

  const taskRows = [...resolved.entries()].map(([key, r]) => taskRow(key, r));
  const { error: taskErr } = await sb
    .from("cc_jira_issue")
    .upsert(taskRows, { onConflict: "key" });
  if (taskErr) throw new Error(`cc_jira_issue (tasks) upsert failed: ${taskErr.message}`);

  // Backfill cc_sessions for each task that resolved to an epic. We only touch
  // sessions whose jira_key matches and whose epic_key is still null, so an
  // explicit per-session epic (from /task) is never overwritten.
  let sessionsUpdated = 0;
  for (const [key, r] of resolved) {
    if (!r.epicKey) continue;
    const { data, error } = await sb
      .from("cc_sessions")
      .update({ epic_key: r.epicKey, epic_summary: r.epicSummary })
      .eq("jira_key", key)
      .is("epic_key", null)
      .select("session_id");
    if (error) throw new Error(`cc_sessions backfill failed for ${key}: ${error.message}`);
    sessionsUpdated += data?.length ?? 0;
  }

  return {
    issuesUpserted: epicRows.size + taskRows.length,
    sessionsUpdated,
  };
}

/**
 * Read distinct task keys that still need an epic resolved: cc_sessions rows
 * with a jira_key but no epic_key, excluding keys whose cc_jira_issue row was
 * synced within the last `skipHours` (default 12h) — that makes the sync
 * idempotent and cheap to re-run.
 *
 * Pure DB read; the Claude session feeds these keys to MCP getJiraIssue.
 */
export async function readUnsyncedTaskKeys(skipHours = 12): Promise<string[]> {
  const sb = supabaseFromEnv();
  if (!sb) {
    throw new Error(
      "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY).",
    );
  }

  // Candidate task keys: have a jira_key, missing epic_key.
  const { data: sessRows, error: sessErr } = await sb
    .from("cc_sessions")
    .select("jira_key")
    .not("jira_key", "is", null)
    .is("epic_key", null);
  if (sessErr) throw new Error(`cc_sessions scan failed: ${sessErr.message}`);

  const candidates = new Set<string>();
  for (const row of sessRows ?? []) {
    const key = (row as { jira_key: string | null }).jira_key;
    if (key) candidates.add(key);
  }
  if (candidates.size === 0) return [];

  // Drop keys synced within the skip window.
  const cutoff = new Date(Date.now() - skipHours * 60 * 60 * 1000).toISOString();
  const { data: freshRows, error: freshErr } = await sb
    .from("cc_jira_issue")
    .select("key")
    .gte("synced_at", cutoff)
    .in("key", [...candidates]);
  if (freshErr) throw new Error(`cc_jira_issue freshness check failed: ${freshErr.message}`);

  for (const row of freshRows ?? []) {
    candidates.delete((row as { key: string }).key);
  }
  return [...candidates].sort();
}
