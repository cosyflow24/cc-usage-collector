#!/bin/bash
# Mimics the real nnb-jira on this machine: a LAUNCHER that starts a helper
# process and then does the slow work itself. Killing only the process that
# spawnSync started leaves the helper running — which is the bug this fixture
# exists to catch.
sleep "30.${CC_USAGE_TEST_MARKER:-99999}" &
sleep 60
