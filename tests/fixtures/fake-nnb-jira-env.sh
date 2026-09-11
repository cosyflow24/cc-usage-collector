#!/bin/bash
# Records the environment it was given, then answers like the real gateway.
# The real nnb-jira runs selfUpdate() on every command unless
# NNB_JIRA_NO_AUTOUPDATE is set, forking a detached worker into its OWN process
# group — one our killGroup() can never reach.
if [ -n "${CC_USAGE_TEST_ENV_DUMP:-}" ]; then
  env > "$CC_USAGE_TEST_ENV_DUMP"
fi
cat <<'JSON'
{"issues":[{"key":"KI-950","fields":{"summary":"PDF nach Excel Kaskade","status":{"name":"In Arbeit"},"updated":"2026-09-09T08:00:00.000+0200"}}]}
JSON
