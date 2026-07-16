#!/usr/bin/env bash
# Local Jira context cache for /task. Stores per key the WORK CONTEXT the user
# needs to start a task (summary, description/AC, status, type, parent, updated)
# so it isn't re-fetched via the MCP every session. Freshness is decided by the
# caller: probe the issue's `updated` timestamp (one tiny field) and only re-fetch
# the full context when it changed — a true incremental refresh.
#
#   jira-cache.sh get KEY            -> prints the cached JSON, or "MISS"
#   echo '<json>' | jira-cache.sh put KEY   -> stores that JSON blob under KEY
#
# Not sensitive (issue keys/titles/descriptions only). Per-user under ~/.claude.
set -euo pipefail

if [[ "${1:-}" == "put" ]]; then
  BLOB="$(cat)"                       # JSON from stdin (handles long descriptions)
else
  BLOB=""
fi

BLOB="$BLOB" node - "$@" <<'EOF'
const fs = require("fs"), os = require("os"), path = require("path");
const CC = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const FILE = path.join(CC, "cc-usage", "jira-cache.json");
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };

const [cmd, key] = process.argv.slice(2);
if (!cmd || !key) { process.stdout.write("MISS"); process.exit(0); }

if (cmd === "get") {
  const e = load()[key];
  process.stdout.write(e ? JSON.stringify(e) : "MISS");
} else if (cmd === "put") {
  let issue;
  try { issue = JSON.parse(process.env.BLOB || "{}"); } catch { process.stdout.write("bad-json"); process.exit(1); }
  const db = load();
  db[key] = { ...issue, syncedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db));
  process.stdout.write("ok");
} else {
  process.stdout.write("MISS");
}
EOF
