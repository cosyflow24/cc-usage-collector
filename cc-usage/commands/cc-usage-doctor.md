---
description: Check the local cc-usage collector installation without uploading data
allowed-tools: Bash(bash:*)
---

Run:

```bash
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" bash "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"
```

Report the result. Do not print or inspect the upload token value and do not
upload data as part of this check.
