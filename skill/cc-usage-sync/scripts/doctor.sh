#!/usr/bin/env bash
set -euo pipefail

CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE="$CC/cc-usage"
FAIL=0

ok() { printf 'ok: %s\n' "$*"; }
bad() { printf 'fail: %s\n' "$*" >&2; FAIL=1; }

command -v node >/dev/null 2>&1 && ok "node $(node -v)" || bad "Node.js is missing"
[[ -f "$STATE/env" ]] && ok "$STATE/env" || bad "upload configuration is missing"
if [[ -f "$STATE/env" ]]; then
  grep -q '^CC_USAGE_INGEST_URL=' "$STATE/env" && ok "ingest URL configured" || bad "ingest URL missing"
  grep -q '^CC_USAGE_INGEST_TOKEN=' "$STATE/env" && ok "personal upload token configured" || bad "upload token missing"
fi
[[ -x "$STATE/bin/set-task.sh" ]] && ok "task attribution helper" || bad "task helper missing; restart Claude or reinstall"
[[ -x "$STATE/bin/sync.sh" ]] && ok "sync helper" || bad "sync helper missing; restart Claude or reinstall"

if [[ -f "$CC/settings.json" ]] && grep -q 'cc-usage' "$CC/settings.json"; then
  ok "script-install hooks detected"
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  ok "plugin runtime detected"
else
  bad "no cc-usage hook installation detected"
fi

if [[ -e "$STATE/bin/jira-cache.sh" || -e "$STATE/identity.json" ]]; then
  bad "obsolete Jira integration residue exists; restart or reinstall cc-usage"
else
  ok "no Jira credentials or integration cache"
fi

if [[ "$FAIL" == "0" ]]; then
  printf 'cc-usage doctor: healthy\n'
else
  printf 'cc-usage doctor: needs attention\n' >&2
  exit 1
fi
