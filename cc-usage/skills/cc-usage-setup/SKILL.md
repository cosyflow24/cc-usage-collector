---
name: cc-usage-setup
description: Bootstrap and verify the CC Usage launcher after installing the Codex
  plugin. Use when the user asks to set up, install, log in to, configure, or fix
  CC Usage in Codex, or reports that the cc-usage command is missing.
allowed-tools: [Bash, Read]
---

# CC Usage setup

Resolve this skill's absolute directory, then treat its plugin root as two
directories above it. Do not assume `cc-usage` is already on PATH.

1. Bootstrap the stable launcher from the installed plugin root:

   ```bash
   node <plugin-root>/tools/cc-usage.mjs refresh
   ```

2. Tell the user to run `cc-usage login` in an ordinary interactive terminal.
   Token input is hidden and stored in the OS keyring; never ask them to paste it
   into chat or put it in a shell argument.
3. Ask the user to open `/hooks` in Codex and trust the current CC Usage hook
   definition. Plugin hooks are skipped until their exact hash is trusted.
4. After login, run `cc-usage doctor`. It is read-only and does not upload.
5. Use `cc-usage sync --dry-run` for a local preview. Upload only when the user
   explicitly asks, via `cc-usage sync`.

The launcher self-heals on trusted SessionStart hooks and plugin refreshes.
