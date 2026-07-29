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

# Locate the bundled collector. Prefer the hook-provided dist; else resolve it
# relative to this script's REAL location. A manual/skill run usually invokes this
# via a symlink (~/.claude/cc-usage/bin/sync.sh -> <plugin>/scripts/sync.sh), so we
# must follow the symlink chain before ../dist — otherwise ../dist resolves to the
# bin dir and the collector is reported "not found (looked in 'unset')".
DIST="${CC_USAGE_PLUGIN_DIST:-}"
if [[ -z "$DIST" ]]; then
  self="${BASH_SOURCE[0]}"
  hops=0
  # Bound the walk (SYMLOOP_MAX is ~32) so a symlink cycle can't spin forever;
  # if we hit the cap the ../dist resolve below just fails gracefully.
  while [[ -L "$self" ]] && (( hops++ < 40 )); do
    link="$(readlink "$self")"
    if [[ "$link" = /* ]]; then self="$link"; else self="$(cd "$(dirname "$self")" && cd "$(dirname "$link")" && pwd)/$(basename "$link")"; fi
  done
  # Still a symlink → chain too deep/cyclic; leave DIST empty so the not-found
  # guard below reports it instead of guessing from a half-resolved path.
  if [[ -L "$self" ]]; then DIST=""; else DIST="$(cd "$(dirname "$self")/../dist" 2>/dev/null && pwd || true)"; fi
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

# Require the employee-safe ingest API. Database credentials never belong in
# the collector plugin.
if [[ -z "${CC_USAGE_INGEST_URL:-}" || -z "${CC_USAGE_INGEST_TOKEN:-}" ]]; then
  echo "cc-usage-sync: no upload credentials. Run /cc-usage-login <token> first." >&2
  exit 1
fi

# Pilot scope: when CC_USAGE_PROJECT is set, only that project's sessions
# (cwd basename) are analysed/uploaded.
ARGS=(--days "$DAYS" --upload)
if [[ -n "${CC_USAGE_PROJECT:-}" ]]; then ARGS+=(--project "$CC_USAGE_PROJECT"); fi
exec node "$DIST/cli.js" "${ARGS[@]}"
