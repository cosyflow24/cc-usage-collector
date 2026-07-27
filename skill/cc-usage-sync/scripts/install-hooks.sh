#!/usr/bin/env bash
# Install cc-usage hooks + scripts + /task command for the current user.
# Idempotent: re-running does not duplicate hooks or clobber unrelated config.
#
# - copies session-prompt / capture / set-task / sync scripts to ~/.claude/cc-usage/bin
# - installs the /task slash command at ~/.claude/commands/task.md
# - merges a SessionStart hook (session-prompt.sh -> additionalContext asking
#   which Jira epic/task this session is for) and a SessionEnd hook (sync.sh ->
#   cc-usage --days 1 --upload) into ~/.claude/settings.json via a node JSON merge
#
# Can be called standalone or by install.sh. CLAUDE_CONFIG_DIR aware.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BIN="$CC/cc-usage/bin"
mkdir -p "$BIN" "$CC/commands"

cp "$SRC/session-prompt.sh" "$SRC/ask-task.sh" "$SRC/capture-task.sh" "$SRC/set-task.sh" "$SRC/sync.sh" "$SRC/burn.sh" "$SRC/doctor.sh" "$BIN/"
chmod +x "$BIN"/*.sh
rm -f "$BIN/jira-cache.sh" "$CC/cc-usage/identity.json"

# /task slash command — records the Jira task (and optional epic) for the session.
cat > "$CC/commands/task.md" <<'EOF'
---
description: Attribute the current Claude Code session to an existing Jira key (cc-usage metadata only)
allowed-tools: Bash(bash:*)
---
# /task

Record usage attribution only. This command must never read, create, edit,
transition, comment on, or authenticate to Jira. It needs no Jira CLI, API token,
MCP, or cached Jira identity.

Accepted forms:

- `last` — run `bash ~/.claude/cc-usage/bin/set-task.sh last`.
- `none` — run `bash ~/.claude/cc-usage/bin/set-task.sh none`.
- `KEY` — validate `^[A-Z][A-Z0-9]+-[0-9]+$`, then run
  `bash ~/.claude/cc-usage/bin/set-task.sh KEY`.
- `TASK EPIC` — validate both keys, then run
  `bash ~/.claude/cc-usage/bin/set-task.sh TASK EPIC`.

Do not infer whether a key is a Task, Epic, Story, Bug, or sub-task. Do not
invent, validate, or create a key. If the user describes new work instead of
providing an existing key, explain that `/task` only records an existing key and
ask them to create the Jira issue through the separate company Jira plugin.

Confirm only what `set-task.sh` recorded, in the user's language.
EOF

# /burn slash command — live 5h-window burn rate + quota warning (wraps ccusage).
cat > "$CC/commands/burn.md" <<'EOF'
---
description: Live Claude 5h-window burn rate + quota warning (cc-usage; wraps ccusage)
allowed-tools: Bash(bash:*), Bash(npx:*)
---
Run `bash ~/.claude/cc-usage/bin/burn.sh` and summarize the ACTIVE 5-hour block:
tokens used so far, time remaining in the block, burn rate, projected end-of-block
usage, and whether it is approaching the Max limit. Note the current project. Keep
it to a few lines. Claude/Max are not billed per token — frame it as
rate-limit-window usage, not a bill.

LANGUAGE: reply in whatever language the user is currently writing in this
conversation (auto-detect). Do NOT hard-default to English, German, or Chinese.
EOF

cat > "$CC/commands/cc-usage-doctor.md" <<'EOF'
---
description: Check the local cc-usage collector installation without uploading data
allowed-tools: Bash(bash:*)
---
Run `bash ~/.claude/cc-usage/bin/doctor.sh`. Report the result without printing
or inspecting the upload token value and without uploading data.
EOF

SETTINGS="$CC/settings.json"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
# Rolling backup (may already be post-merge on a re-run) …
cp "$SETTINGS" "$SETTINGS.bak-ccusage"
# … plus a one-time pristine snapshot from BEFORE the first install, so a full
# rollback is always possible even after repeated re-installs.
[[ -f "$SETTINGS.bak-ccusage-original" ]] || cp "$SETTINGS" "$SETTINGS.bak-ccusage-original"

# Merge hooks with node (no jq dependency). Idempotent: a hook entry is added
# only if no existing entry already references the same script. Preserves any
# other SessionStart/SessionEnd/* hooks the user already has.
SETTINGS="$SETTINGS" node -e '
const fs = require("fs");
const file = process.env.SETTINGS;

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cfg = {}; }
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
if (typeof cfg.hooks !== "object" || cfg.hooks === null || Array.isArray(cfg.hooks)) cfg.hooks = {};

const HOME = process.env.HOME || "";
// event -> one or more hook specs. SessionStart wires BOTH the /task prompt AND
// capture-task (which records the Claude account + plan in use per session, so
// multi-account users — enterprise + max — get attributed automatically).
const want = {
  SessionStart: [
    {
      cmd: "bash ~/.claude/cc-usage/bin/session-prompt.sh",
      marker: "session-prompt.sh",
      async: false,          // maps cwd -> sessionId so /task can resolve later
      timeout: 10,
    },
    {
      cmd: "bash ~/.claude/cc-usage/bin/capture-task.sh",
      marker: "capture-task.sh",
      async: true,           // records per-session account + plan (multi-account)
      timeout: 10,
    },
  ],
  UserPromptSubmit: [
    {
      cmd: "bash ~/.claude/cc-usage/bin/ask-task.sh",
      marker: "ask-task.sh",
      async: false,          // injects the "confirm task via AskUserQuestion" directive
      timeout: 10,
    },
  ],
  SessionEnd: [
    {
      cmd: "bash ~/.claude/cc-usage/bin/sync.sh",
      marker: "sync.sh",
      async: true,           // upload in the background; do not delay shutdown
      timeout: 120,
    },
  ],
};

const serialize = (o) => JSON.stringify(o);

for (const [event, specs] of Object.entries(want)) {
  if (!Array.isArray(cfg.hooks[event])) cfg.hooks[event] = [];
  const list = cfg.hooks[event];
  for (const spec of specs) {
    const already = list.some((entry) =>
      serialize(entry).includes(spec.marker)
    );
    if (already) continue;
    list.push({
      hooks: [
        { type: "command", command: spec.cmd, timeout: spec.timeout, async: spec.async },
      ],
    });
  }
}

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
process.stderr.write("cc-usage: hooks merged into " + file + "\n");
'

echo "cc-usage: hooks + /task installed (settings backup at $SETTINGS.bak-ccusage)"
