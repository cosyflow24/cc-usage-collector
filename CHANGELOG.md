# Changelog

## Unreleased

- Auth hardening: `login` verifies the token live (read-only whoami) before
  storing — rejected tokens never reach the keyring, offline is tolerated;
  `doctor` gained the live check incl. enrolled-emails/oauth-coverage note;
  `/cc-usage-login` no longer accepts tokens in chat (terminal hidden input
  only, chat-pasted tokens are treated as burned); Windows tokens now use
  user-scoped DPAPI (ported from data-catalog).
- Unified interaction contract: drift, stale and the unattributed backstop now
  emit non-blocking AskUserQuestion instructions (clickable options mapping to
  exactly one deterministic `task` CLI call) instead of blocking bilingual text
  prompts. Headless sessions get no nudges at all. Slash commands stay as the
  manual fallback. New tests/hooks-interaction.test.mjs locks the contract.

## 0.3.2 — 2026-07-27

- Made the cached plugin subtree self-describing as ESM so the standalone
  collector executes outside the repository root.
- Extended doctor with a real standalone bundle smoke test.

## 0.3.1 — 2026-07-27

- Removed the legacy Jira automation audit uploader and direct database fallback.
- Kept employee uploads on the documented ingest API with an explicit wire projection.
- Removed personal local time transforms from the employee upload path.
- Fixed the packaged CLI for Node 26 by emitting exactly one shebang.
- Versioned local Jira task bindings as schema version 1 for safe optional consumers.
