#!/usr/bin/env bash
# Remove cc-usage hooks + scripts + the /task command for the current user.
# Idempotent. Only touches cc-usage's own entries — other hooks are preserved.
#
# Keeps ~/.claude/cc-usage/{env,tasks.jsonl,asked/} (config + attribution history)
# unless --purge is passed. Backs up settings.json first.
set -euo pipefail

CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CC/settings.json"
PURGE="${1:-}"

# 1. Drop cc-usage hook entries from settings.json (matched by script marker).
if [[ -f "$SETTINGS" ]]; then
  cp "$SETTINGS" "$SETTINGS.bak-ccusage-uninstall"
  SETTINGS="$SETTINGS" node -e '
  const fs = require("fs");
  const file = process.env.SETTINGS;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cfg = {}; }
  const markers = [
    "session-prompt.sh",
    "capture-task.sh",
    "ask-task.sh",
    "cc-usage/bin/sync.sh",
  ];
  const isOurs = (entry) => markers.some((m) => JSON.stringify(entry).includes(m));
  if (cfg.hooks && typeof cfg.hooks === "object") {
    for (const event of Object.keys(cfg.hooks)) {
      if (!Array.isArray(cfg.hooks[event])) continue;
      cfg.hooks[event] = cfg.hooks[event].filter((e) => !isOurs(e));
      if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
    }
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  process.stderr.write("cc-usage: hooks removed from " + file + "\n");
  '
fi

# 2. Remove the installed scripts + /task command.
rm -rf "$CC/cc-usage/bin"
rm -f "$CC/commands/task.md"

# 3. Optionally purge config + attribution history.
if [[ "$PURGE" == "--purge" ]]; then
  rm -rf "$CC/cc-usage"
  echo "cc-usage: purged ~/.claude/cc-usage (env + tasks.jsonl + asked/)"
fi

echo "cc-usage: uninstalled. Settings backup at $CC/settings.json.bak-ccusage-uninstall"
echo "  (re-install: bash skill/cc-usage-sync/scripts/install-hooks.sh)"
