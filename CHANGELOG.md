# Changelog

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
