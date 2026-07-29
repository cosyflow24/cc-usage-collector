---
description: Live Claude 5h-window burn rate + quota warning (cc-usage; wraps ccusage)
allowed-tools: Bash(sh:*), Bash(npx:*)
---
Run `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" burn` and summarize the ACTIVE 5-hour
block: tokens used so far, time remaining in the block, burn rate, projected
end-of-block usage, and whether it is approaching the Max limit. Note the current
project. Keep it to a few lines. Claude/Max are not billed per token — frame it as
rate-limit-window usage, not a bill.

LANGUAGE: reply in whatever language the user is currently writing in this
conversation (auto-detect). Do NOT hard-default to English, German, or Chinese.
