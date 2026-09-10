#!/bin/bash
# Stand-in for the real read-only nnb-jira gateway. The real one prints a
# WARNING banner on stderr AND a compatibility warning on stdout before the JSON
# payload, so the parser must not assume the first byte is "{".
echo "WARNING: using cached credentials for urari.atlassian.net"
cat <<'JSON'
{
  "issues": [
    { "key": "KI-950", "fields": { "summary": "PDF nach Excel Kaskade", "status": { "name": "In Arbeit" }, "updated": "2026-09-09T08:00:00.000+0200" } },
    { "key": "BI-220", "fields": { "summary": "Retouren Report bauen", "status": { "name": "On Hold" }, "updated": "2026-09-08T08:00:00.000+0200" } },
    { "key": "not-a-key", "fields": { "summary": "must be dropped", "status": { "name": "Open" }, "updated": "2026-09-07T08:00:00.000+0200" } },
    { "key": "ITS-11064", "fields": { "summary": "Firewall DMZ Freigabe", "status": { "name": "Waiting" }, "updated": "2026-09-06T08:00:00.000+0200" } }
  ]
}
JSON
