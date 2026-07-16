#!/usr/bin/env bash
# One-time-per-session bridge: symlink the plugin's scripts into the historical
# ~/.claude/cc-usage/bin/ path. The /task + /burn commands and inter-script calls
# reference that stable path; symlinking preserves every existing reference with
# zero rewrites, and a plugin update is picked up automatically (symlinks follow
# ${CLAUDE_PLUGIN_ROOT}). Idempotent, silent, never fails the session.
set -euo pipefail
CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BIN="$CC/cc-usage/bin"
SRC="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts"
mkdir -p "$BIN" 2>/dev/null || exit 0
for f in "$SRC"/*.sh; do
  [[ -e "$f" ]] || continue
  ln -sf "$f" "$BIN/$(basename "$f")" 2>/dev/null || true
done
# Also expose the bundled collector for a manual `bash ~/.claude/cc-usage/bin/sync.sh`.
printf 'CC_USAGE_PLUGIN_DIST=%q\n' "${CLAUDE_PLUGIN_ROOT:-}/dist" > "$CC/cc-usage/plugin-dist.env" 2>/dev/null || true
exit 0
