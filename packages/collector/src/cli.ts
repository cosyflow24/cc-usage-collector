import { Command } from "commander";
import { analyze } from "./analyze.ts";
import { fetchCcusageCost, fetchCcusageDailyTotal } from "./ccusage.ts";
import {
  loadJiraConfig,
  resolveAccountEmail,
  resolveCodexAccountEmail,
  resolveRange,
  resolveUser,
} from "./config.ts";
import { formatTable } from "./format.ts";
import { readUsageRecords } from "./parser.ts";
import { loadSessionAccounts, loadSessionTasks } from "./sidecar.ts";

const DEFAULT_IDLE_GAP_MIN = 15;

const program = new Command();
program
  .name("cc-usage")
  .description("Analyze Claude Code + Codex session logs; usage and task attribution.")
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
    const records = await readUsageRecords(since, until);

    // ccusage is the cost ORACLE (higher fidelity), but optional: null on any
    // failure → pricing.ts is the self-sufficient primary path.
    const ccusageCost = await fetchCcusageCost(since, until);

    const result = analyze(records, {
      user,
      // BOTH providers fail closed. Codex already did; Claude did not, and the
      // asymmetry was a hole: `?? user` fell back to resolveUser(), which
      // returns CC_USAGE_USER - injected by the launcher as the ENROLLED WORK
      // EMAIL (tools/core/collector.mjs). So a session whose real account could
      // not be read (~/.claude.json missing, unreadable, or a different
      // CLAUDE_CONFIG_DIR) was labelled with the work address, passed
      // isWorkAccount(), and uploaded - whatever account actually produced it.
      // Unknown now stays unknown: analyze() falls through to
      // `unknown-<provider>-account`, which the work-domain gate drops.
      // `--user` wins over THIS fallback (cli passes it for both providers
      // below); it does NOT outrank a sidecar-scoped account, which analyze()
      // resolves first — trustedScopedAccount ?? legacyClaudeAccount ??
      // providerUser. An earlier comment claimed more than the code does.
      providerUsers: opts.user ? { claude: user, codex: user } : {
        claude: resolveAccountEmail(),
        codex: resolveCodexAccountEmail(),
      },
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
      // Default (KI-764 three-state): upload ALL sessions, so untagged work
      // lands under "Unassigned" rather than being dropped and the dashboard
      // shows full per-project usage. A jira key is backfilled later via /task
      // or reclaim.
      //
      // CC_USAGE_UPLOAD_UNTAGGED=0 (config.json `uploadUntagged: false`) opts
      // OUT: those sessions stay on this machine. withoutUntagged() drops the
      // orphaned daily rows with them - see its contract.
      const uploadUntagged = process.env.CC_USAGE_UPLOAD_UNTAGGED !== "0";
      const unassigned = result.sessions.filter((s) => !s.jiraKey).length;
      let toUpload = result;
      if (unassigned > 0) {
        if (uploadUntagged) {
          process.stderr.write(`${unassigned} session(s) uploaded as Unassigned (no jira key).\n`);
        } else {
          const { withoutUntagged } = await import("./upload.ts");
          toUpload = withoutUntagged(result);
          process.stderr.write(
            `${unassigned} session(s) without a Jira key kept local (uploadUntagged: false).\n`,
          );
        }
      }
      const ingestUrl = process.env.CC_USAGE_INGEST_URL;
      const ingestToken = process.env.CC_USAGE_INGEST_TOKEN;
      if (!ingestUrl || !ingestToken) {
        throw new Error(
          "Upload is not configured. Run /cc-usage-login <token> to configure the ingest API.",
        );
      }
      const { httpUpload } = await import("./upload.ts");
      const res = await httpUpload(toUpload, {
        url: ingestUrl,
        token: ingestToken,
        version: typeof __CC_USAGE_VERSION__ === "string" ? __CC_USAGE_VERSION__ : undefined,
      });
      process.stderr.write(`Uploaded ${res.sessions} sessions, ${res.daily} daily rows.\n`);
    }
  });

// The plugin version (cc-usage/package.json), baked in by tsup's `define` at
// build time. A dev run through tsx has none and sends no version header.
declare const __CC_USAGE_VERSION__: string | undefined;

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
