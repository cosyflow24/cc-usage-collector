---
description: Enroll for cc-usage uploads — opens the enrollment page and directs you to the hidden-input terminal login (the token never touches the chat)
allowed-tools: Bash(sh:*)
---
Wire up the cc-usage upload token so the SessionEnd sync can upload to the team
dashboard. The token is per-account and uploads usage ONLY (never the dashboard
password). It is stored in the OS keyring (macOS Keychain / Windows DPAPI;
mode-600 file only where no keyring exists).

**Security contract (2026-08-12): the token must NEVER appear in this chat.**
Chat history is stored and may be synced; a secret pasted here is burned. Do
not ask for the token with AskUserQuestion either — that tool is for choices,
not secrets.

Steps:

1. Open the enrollment flow and hand over to the terminal in ONE step — this
   opens the browser page and prompts for the token with hidden input, then
   verifies it live against the dashboard before storing:
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" login
   ```
   Tell the user: enter the **Max** account email (the short
   `lastname@nnb24.de`) on the page, copy the `ccu_…` token it shows, and paste
   it into the terminal prompt (input is hidden).
2. If the user pasted a token into the chat anyway ($ARGUMENTS non-empty):
   do NOT store it. Tell them the token is now in chat history and must be
   treated as burned — revoke/re-enroll on the dashboard and repeat step 1
   with the fresh token in the terminal.
3. Afterwards confirm with a health check (includes the live token check):
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" doctor
   ```
   Offer a one-time immediate sync: `sh "${CLAUDE_PLUGIN_ROOT}/tools/cc-usage" sync`.
