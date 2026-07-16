---
description: Save your cc-usage upload token (from the /enroll page) so usage syncs to the team dashboard
allowed-tools: Bash(bash:*)
---
Persist the cc-usage per-account upload token so the SessionEnd sync can upload.

Args: $ARGUMENTS  (the token from the /enroll page, e.g. `ccu_...`)

The token is per-account and uploads usage ONLY (never the dashboard password).
Get it from the enrollment page your admin gave you (`…/enroll` — enter your
**Max** account email, the short `lastname@nnb24.de`), then run `/cc-usage-login <token>`.

Steps:
1. If `$ARGUMENTS` is empty, ask the user to paste their token from the /enroll
   page and stop (do not write an empty token).
2. Validate the token looks like an ingest token: it must match `^ccu_[A-Za-z0-9_-]+$`.
   If not, tell the user it doesn't look like a cc-usage token and stop.
3. Persist it (default ingest URL is baked in; override with CC_USAGE_INGEST_URL
   in the env if the team endpoint differs):
   ```bash
   CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; mkdir -p "$CC/cc-usage"; umask 077
   URL="${CC_USAGE_INGEST_URL:-https://cc-usage.up.railway.app/api/ingest}"
   {
     echo "# cc-usage env — written by /cc-usage-login. Do not commit."
     printf 'CC_USAGE_INGEST_URL=%q\n' "$URL"
     printf 'CC_USAGE_INGEST_TOKEN=%q\n' "<TOKEN>"
   } > "$CC/cc-usage/env"
   chmod 600 "$CC/cc-usage/env"
   ```
   Replace `<TOKEN>` with the validated `$ARGUMENTS`.
4. Confirm: token saved; usage now uploads automatically when a session ends.
   Offer a one-time immediate sync: `bash ~/.claude/cc-usage/bin/sync.sh`.
