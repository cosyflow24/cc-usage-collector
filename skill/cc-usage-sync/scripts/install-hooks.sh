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

cp "$SRC/session-prompt.sh" "$SRC/ask-task.sh" "$SRC/capture-task.sh" "$SRC/set-task.sh" "$SRC/sync.sh" "$SRC/burn.sh" "$SRC/jira-cache.sh" "$BIN/"
chmod +x "$BIN"/*.sh

# /task slash command — records the Jira task (and optional epic) for the session.
cat > "$CC/commands/task.md" <<'EOF'
---
description: Attribute the current Claude Code session to a Jira task / epic (cc-usage)
allowed-tools: Bash(bash:*)
---
Attribute this Claude Code session to a Jira TASK. Args: $ARGUMENTS
Conversation language = the user's language (default English/German; never Chinese
unless they write Chinese). HARD RULE: any Jira issue you CREATE (summary AND
description) is written in **German**, regardless of conversation language. The
Atlassian MCP is REQUIRED — if it is not connected, do NOT record/create; ask the
user to connect it and stop.

Goal: every session ends up attributed to a **task** (which rolls up to its
epic). We track epic ⇄ task; never sub-tasks (tasks are the lowest level).

Flow:

0. `last` → reuse the most recent task recorded for THIS folder (no MCP, no
   guessing): run `set-task.sh last` and confirm what it picked. If it prints
   "no previous task recorded for this dir", fall through to step 2/3.

1. `none` → run `set-task.sh none` and confirm. Done.

2. A bare key was given (e.g. KI-758). Load its WORK CONTEXT cache-first and
   refresh ONLY if the ticket changed (you need type/parent to route AND the
   description/AC because the user is starting this task):
   a. `bash ~/.claude/cc-usage/bin/jira-cache.sh get <KEY>` → cached JSON, or MISS.
   b. Probe freshness cheaply: getJiraIssue(KEY, fields=["updated"]) — one field.
      - Cache HIT **and** its `updated` equals the probed `updated` → **use the
        cached context. Do NOT fetch anything else.**
      - MISS **or** `updated` differs → fetch the full context ONCE:
        getJiraIssue(KEY, fields=["issuetype","parent","summary","status","updated","description"],
        responseContentFormat="markdown"), then cache it by piping a JSON object
        with keys {type, parentKey, summary, status, updated, description}:
        `printf '%s' '<json>' | bash ~/.claude/cc-usage/bin/jira-cache.sh put <KEY>`.
   c. You now have {type, parentKey, summary, status, description}. Briefly surface
      the title + acceptance criteria / description to the user (concise, their
      language) so they have the context to start the work.
   d. Classify by type/parent:
   - **Not found** → it's a typo / wrong key (NOT a create — new keys are minted
     by Jira, never typed). Tell the user, ask for the right key. Never create
     from a typed key.
   - **Sub-task** → roll up to its parent task and record that.
   - **Task/Story/Bug** → record it; include its parent epic if it has one:
     `set-task.sh <TASK> <EPIC>`. Zero extra questions.
   - **Epic** → always drill to a task (decision: never attribute at epic level).
     List the epic's child tasks (searchJiraIssuesUsingJql `parent = <EPIC>`).
     Ask the user to pick one, or to create a new one. If the epic has no
     children, go to step 3.

3. Create intent (user describes NEW work — not a key — or chose "create" above):
   a. **Decide Epic vs Task by scope** (your judgment from the description):
      - Broad theme / initiative spanning multiple deliverables → **Epic**.
      - A single concrete deliverable / fix → **Task**.
   b. **Draft in German**: write the issue summary + a short description in German
      from what the user described. Show the German draft and **let them edit /
      confirm before creating**. The confirmation dialog itself stays in the
      user's language; only the issue fields are German.
   c. Create after confirmation:
      - **Task** → createJiraIssue(issuetype=Task). Add `parent=<EPIC>` only if a
        relevant epic is clearly known; otherwise a top-level Task is fine — do
        NOT invent an epic. Never create a sub-task under a task.
      - **Epic** → createJiraIssue(issuetype=Epic), then create a first **Task**
        under it (same German-draft + confirm rules) and attribute THAT task —
        never attribute the session at epic level.
   d. Take the returned key, then record `set-task.sh <TASK> [EPIC]`.

Record with: `bash ~/.claude/cc-usage/bin/set-task.sh <TASK> [EPIC]`
(or `... none`). Then confirm what was recorded, in the user's language.
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
