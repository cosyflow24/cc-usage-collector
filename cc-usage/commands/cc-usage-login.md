---
description: Save your cc-usage upload token (from the /enroll page) into the OS keyring so usage syncs to the team dashboard
allowed-tools: Bash(sh:*)
---
Persist the cc-usage per-account upload token so the SessionEnd sync can upload.
The token is stored in the OS keyring (macOS Keychain), never in a plaintext file.

Args: $ARGUMENTS  (the token from the /enroll page, e.g. `ccu_...`)

The token is per-account and uploads usage ONLY (never the dashboard password).
Get it from the enrollment page your admin gave you (`…/enroll` — enter your
**Max** account email, the short `lastname@nnb24.de`), then run `/cc-usage:cc-usage-login <token>`.

Steps:
1. If `$ARGUMENTS` is empty, ask the user to paste their token from the /enroll
   page and stop (do not store an empty token). You may also tell them they can
   run `cc-usage login` in a terminal for a hidden-input prompt.
2. Validate the token looks like an ingest token: it must match `^ccu_[A-Za-z0-9_-]+$`.
   If not, tell the user it doesn't look like a cc-usage token and stop.
3. Store it (the CLI reads the token from stdin so it never lands in a file):
   ```bash
   printf '%s' '<TOKEN>' | sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" login --stdin
   ```
   Replace `<TOKEN>` with the validated `$ARGUMENTS`.
4. Confirm what the CLI printed: token saved to the keyring; usage now uploads
   automatically when a session ends. Offer a one-time immediate sync:
   `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" sync`.
