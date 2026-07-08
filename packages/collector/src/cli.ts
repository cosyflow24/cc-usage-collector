#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { analyze } from "./analyze.ts";
import { fetchCcusageCost, fetchCcusageDailyTotal } from "./ccusage.ts";
import {
  isWorkAccount,
  loadJiraConfig,
  resolveAccountEmail,
  resolveRange,
  resolveUser,
} from "./config.ts";
import { formatTable } from "./format.ts";
import { readRecords } from "./parser.ts";
import { loadSessionAccounts, loadSessionTasks } from "./sidecar.ts";

const DEFAULT_IDLE_GAP_MIN = 15;

const program = new Command();
program
  .name("cc-usage")
  .description("Analyze Claude Code session logs; notional cost + token attribution.")
  .option("-s, --since <iso>", "start of range (ISO date/datetime)")
  .option("-u, --until <iso>", "end of range (ISO date/datetime)")
  .option("-d, --days <n>", "look back N local days (default: 1 = yesterday)")
  .option("--user <id>", "override user identity (default: git email)")
  .option("--idle-gap <min>", "idle gap minutes for active time", String(DEFAULT_IDLE_GAP_MIN))
  .option("--project <name>", "only include sessions from this project (cwd basename)")
  .option("--no-commit-scan", "do not scan git commits for Jira keys")
  .option("--json", "output JSON instead of a table")
  .option("--upload", "upsert results (prefers ingest URL+token, else Supabase)")
  .option(
    "--ccusage-check",
    "reconcile our notional total against `npx ccusage daily` and print the delta",
  )
  .action(async (opts) => {
    const user = opts.user ?? resolveUser();
    const { since, until } = resolveRange(opts);
    const idleGapMs = Number.parseInt(opts.idleGap, 10) * 60_000;
    if (!Number.isFinite(idleGapMs) || idleGapMs <= 0) {
      throw new Error(`invalid --idle-gap: ${opts.idleGap}`);
    }

    const jira = loadJiraConfig();
    if (opts.commitScan === false) jira.scanCommits = false;

    const sessionTasks = loadSessionTasks();
    const sessionAccounts = loadSessionAccounts();
    const records = await readRecords(since, until);

    // ccusage is the cost ORACLE (higher fidelity), but optional: null on any
    // failure → pricing.ts is the self-sufficient primary path.
    const ccusageCost = await fetchCcusageCost(since, until);

    const result = analyze(records, {
      user,
      since,
      until,
      idleGapMs,
      jira,
      project: opts.project,
      sessionTasks,
      sessionAccounts,
      ccusageCost,
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatTable(result)}\n`);
    }

    if (opts.ccusageCheck) {
      const ccTotal = await fetchCcusageDailyTotal(since, until);
      if (ccTotal === null) {
        process.stderr.write("ccusage-check: ccusage unavailable (skipped).\n");
      } else {
        const delta = result.notionalCostUsd - ccTotal;
        const pct = ccTotal > 0 ? (delta / ccTotal) * 100 : 0;
        process.stderr.write(
          `ccusage-check: ours $${result.notionalCostUsd.toFixed(2)} vs ` +
            `ccusage $${ccTotal.toFixed(2)} (delta $${delta.toFixed(2)}, ${pct.toFixed(1)}%)` +
            `${Math.abs(pct) > 5 ? " — DRIFT >5%, sync-check pricing.ts rates" : ""}\n`,
        );
      }
    }

    if (opts.upload) {
      // POLICY: only report when signed into a work account. A developer on a
      // personal Claude account is never uploaded.
      const account = resolveAccountEmail();
      if (!isWorkAccount(account)) {
        const who = account ?? "no account found";
        const domain = process.env.CC_USAGE_WORK_DOMAIN ?? "nnb24.de";
        process.stderr.write(
          `Skipping upload: '${who}' is not a @${domain} work account. ` +
            "Sign into your work account in Claude Code to report usage.\n",
        );
        return;
      }

      // Upload ALL sessions (KI-764 three-state): untagged work lands under
      // "Unassigned" instead of being dropped, so the dashboard shows full
      // per-project usage. A jira key is backfilled later via /task or reclaim.
      const toUpload = result;
      const unassigned = result.sessions.filter((s) => !s.jiraKey).length;
      if (unassigned > 0) {
        process.stderr.write(`${unassigned} session(s) uploaded as Unassigned (no jira key).\n`);
      }
      const ingestUrl = process.env.CC_USAGE_INGEST_URL;
      const ingestToken = process.env.CC_USAGE_INGEST_TOKEN;
      let res: { sessions: number; daily: number };
      if (ingestUrl && ingestToken) {
        const { httpUpload } = await import("./upload.ts");
        res = await httpUpload(toUpload, { url: ingestUrl, token: ingestToken });
      } else {
        // Fallback: direct Supabase write (requires SUPABASE_* locally).
        const { upload } = await import("./supabase.ts");
        res = await upload(toUpload);
      }
      process.stderr.write(`Uploaded ${res.sessions} sessions, ${res.daily} daily rows.\n`);
    }
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
