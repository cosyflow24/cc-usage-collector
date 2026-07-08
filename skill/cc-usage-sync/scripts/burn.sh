#!/usr/bin/env bash
# /burn — live Claude 5h-window usage + burn-rate + quota warning, annotated with
# the current project. Thin wrapper over ccusage's own live block view (we don't
# rebuild what it already does). Claude/Max are NOT billed per token, so the
# actionable signal here is the 5-hour RATE-LIMIT window (how close to the cap),
# not a dollar figure.
#
# Runs on demand (slash command), never as part of the batch sync/upload.
set -euo pipefail

# Language-neutral header (the AI summary that follows adapts to the user's
# language; the script itself must not hard-code German/English/Chinese).
proj="$(basename "$PWD")"
echo "burn · ${proj} · $(date '+%H:%M')"
echo

# --token-limit max = warn relative to the largest previous 5h block seen.
# Fall back without the flag if this ccusage build rejects it.
npx -y ccusage@latest blocks --active --token-limit max 2>/dev/null \
  || npx -y ccusage@latest blocks --active
