import { createClient } from "@supabase/supabase-js";
import { isWorkAccount } from "./config.ts";
import type { AnalysisResult } from "./types.ts";

/** Build a Supabase client from env, or null if not configured. */
export function supabaseFromEnv() {
  const url = process.env.SUPABASE_URL;
  // Service-role key: server-side only, never ship to the browser.
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Map analysis → DB rows and upsert. Idempotent on (user, session_id)/(user, day). */
export async function upload(result: AnalysisResult): Promise<{ sessions: number; daily: number }> {
  const sb = supabaseFromEnv();
  if (!sb) {
    throw new Error(
      "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.",
    );
  }

  // Same wire policy as upload.ts: non-work-account sessions never leave the
  // machine — filter before mapping, on both rows sets.
  const sessionRows = result.sessions.filter((s) => isWorkAccount(s.user)).map((s) => ({
    user_id: s.user,
    session_id: s.sessionId,
    project: s.project,
    git_branch: s.gitBranch,
    jira_key: s.jiraKey,
    epic_key: s.epicKey,
    epic_summary: s.epicSummary,
    message_count: s.messageCount,
    models: s.models,
    model_usage: s.modelUsage,
    input_tokens: s.totals.inputTokens,
    output_tokens: s.totals.outputTokens,
    cache_creation_tokens: s.totals.cacheCreationTokens,
    cache_read_tokens: s.totals.cacheReadTokens,
    total_tokens: s.totals.totalTokens,
    notional_cost_usd: s.notionalCostUsd,
    // Reuse the existing active_ms column (coarse: quarter-hour granularity).
    active_ms: Math.round(s.activeTimeHours * 3_600_000),
  }));

  const dailyRows = result.daily.filter((d) => isWorkAccount(d.user)).map((d) => ({
    user_id: d.user,
    day: d.day,
    sessions: d.sessions,
    model_usage: d.modelUsage,
    input_tokens: d.totals.inputTokens,
    output_tokens: d.totals.outputTokens,
    cache_creation_tokens: d.totals.cacheCreationTokens,
    cache_read_tokens: d.totals.cacheReadTokens,
    total_tokens: d.totals.totalTokens,
    notional_cost_usd: d.notionalCostUsd,
    active_ms: Math.round(d.activeTimeHours * 3_600_000),
  }));

  if (sessionRows.length) {
    const { error } = await sb
      .from("cc_sessions")
      .upsert(sessionRows, { onConflict: "user_id,session_id" });
    if (error) throw new Error(`cc_sessions upsert failed: ${error.message}`);
  }
  if (dailyRows.length) {
    const { error } = await sb
      .from("cc_daily")
      .upsert(dailyRows, { onConflict: "user_id,day" });
    if (error) throw new Error(`cc_daily upsert failed: ${error.message}`);
  }

  return { sessions: sessionRows.length, daily: dailyRows.length };
}
