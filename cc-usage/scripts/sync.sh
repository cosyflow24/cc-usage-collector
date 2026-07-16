#!/usr/bin/env bash
# Sync the last day's Claude Code usage to the team backend. Idempotent.
# Plugin SessionEnd hook + manual/cron runs.
#
# Plugin variant: runs the SELF-CONTAINED bundled collector shipped with the
# plugin (node "$CC_USAGE_PLUGIN_DIST/cli.js") — no repo, no npm install. The
# hook exports CC_USAGE_PLUGIN_DIST=${CLAUDE_PLUGIN_ROOT}/dist; a manual run can
# set it, else we resolve it relative to this script.
set -euo pipefail

DAYS="${1:-1}"
CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# Locate the bundled collector. Prefer the hook-provided dist; fall back to the
# dist next to this script's plugin root (scripts/ -> ../dist).
DIST="${CC_USAGE_PLUGIN_DIST:-}"
if [[ -z "$DIST" ]]; then
  DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dist" 2>/dev/null && pwd || true)"
fi
if [[ -z "$DIST" || ! -f "$DIST/cli.js" ]]; then
  echo "cc-usage-sync: bundled collector not found (looked in '${DIST:-unset}'). Reinstall the plugin." >&2
  exit 1
fi

# Load the per-user env (CC_USAGE_INGEST_URL/TOKEN, optionally CC_USAGE_USER /
# CC_USAGE_PROJECT). Written by /cc-usage-login. This is authoritative — there is
# no repo .env to shadow it in the plugin world.
if [[ -f "$CC/cc-usage/env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CC/cc-usage/env"
  set +a
fi

# Require an upload path: ingest API (preferred) OR direct Supabase (maintainer).
if [[ -z "${CC_USAGE_INGEST_URL:-}" || -z "${CC_USAGE_INGEST_TOKEN:-}" ]]; then
  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_KEY:-}${SUPABASE_KEY:-}" ]]; then
    echo "cc-usage-sync: no upload credentials. Run /cc-usage-login <token> first." >&2
    exit 1
  fi
fi

# Pilot scope: when CC_USAGE_PROJECT is set, only that project's sessions
# (cwd basename) are analysed/uploaded.
ARGS=(--days "$DAYS" --upload)
if [[ -n "${CC_USAGE_PROJECT:-}" ]]; then ARGS+=(--project "$CC_USAGE_PROJECT"); fi
exec node "$DIST/cli.js" "${ARGS[@]}"
