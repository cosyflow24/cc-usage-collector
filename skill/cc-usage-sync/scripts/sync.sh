#!/usr/bin/env bash
# Sync the last day's Claude Code usage to the team backend. Idempotent.
# Used as the SessionEnd hook and for manual / cron runs.
#
# Resolves the cc-usage repo robustly (copied scripts live in ~/.claude, not the
# repo), loads the user env file, then runs the collector with --upload.
set -euo pipefail

DAYS="${1:-1}"
CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# Load the per-user env file written by install.sh (CC_USAGE_INGEST_URL/TOKEN,
# optionally SUPABASE_* / CC_USAGE_USER). Repo .env can still override below.
if [[ -f "$CC/cc-usage/env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CC/cc-usage/env"
  set +a
fi

# Resolve the repo root. Order:
#   1. CC_USAGE_REPO env (set by install.sh in the env file)
#   2. two levels up from this script (when run from the repo checkout)
#   3. give up with a clear message
ROOT=""
if [[ -n "${CC_USAGE_REPO:-}" && -f "$CC_USAGE_REPO/pnpm-workspace.yaml" ]]; then
  ROOT="$CC_USAGE_REPO"
else
  GUESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd || true)"
  if [[ -n "$GUESS" && -f "$GUESS/pnpm-workspace.yaml" ]]; then
    ROOT="$GUESS"
  fi
fi

if [[ -z "$ROOT" ]]; then
  echo "cc-usage-sync: cannot locate the cc-usage repo. Set CC_USAGE_REPO in $CC/cc-usage/env" >&2
  exit 1
fi
cd "$ROOT"

# Repo .env (dev machines) is convenient, but the installed per-user env must stay
# AUTHORITATIVE — so source repo .env here, then RE-APPLY the user env last. This
# keeps a stale repo token from shadowing the enrolled per-account token.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [[ -f "$CC/cc-usage/env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CC/cc-usage/env"
  set +a
fi

# Require an upload path: ingest API (preferred) OR direct Supabase.
if [[ -z "${CC_USAGE_INGEST_URL:-}" || -z "${CC_USAGE_INGEST_TOKEN:-}" ]]; then
  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_KEY:-}${SUPABASE_KEY:-}" ]]; then
    echo "cc-usage-sync: set CC_USAGE_INGEST_URL + CC_USAGE_INGEST_TOKEN (run install.sh)" >&2
    exit 1
  fi
fi

# NOTE: `pnpm <script> -- ARGS` forwards a literal `--` to the script, which
# commander treats as an options terminator (so --upload/--days get ignored and
# nothing uploads). Run the CLI directly to avoid that.
cd "$ROOT/packages/collector"
# Pilot scope: when CC_USAGE_PROJECT is set, only that project's sessions
# (cwd basename) are analysed/uploaded — e.g. CC_USAGE_PROJECT=cc-usage.
ARGS=(--days "$DAYS" --upload)
if [[ -n "${CC_USAGE_PROJECT:-}" ]]; then ARGS+=(--project "$CC_USAGE_PROJECT"); fi
exec npx tsx src/cli.ts "${ARGS[@]}"
