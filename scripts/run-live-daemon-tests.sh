#!/usr/bin/env bash
# Runs the L4 live daemon E2E tests against a real remote host via SSH.
#
# The user's directive: "I want it to run each time the real test."
#
# Policy:
#   - Uses WALNUT_LIVE_HOST if set, otherwise defaults to `clouddev`
#     (Walnut-internal alias — works on the maintainer's laptop, skips elsewhere).
#   - Probes SSH reachability with BatchMode=yes + 3s connect timeout.
#   - If unreachable: prints a LOUD yellow SKIPPED banner and exits 0.
#     This run is NOT authoritative — flag it in session verification.
#   - If reachable: runs the live tests (L4) — includes kill-claude,
#     kill-daemon, registry-integrity.
#
# Usage:
#   bash scripts/run-live-daemon-tests.sh
#   WALNUT_LIVE_HOST=myhost bash scripts/run-live-daemon-tests.sh

set -euo pipefail

HOST="${WALNUT_LIVE_HOST:-clouddev}"
# SSH-reachable hostname (falls back to HOST if unset).
# Required when HOST is a walnut config alias (e.g. 'clouddev') that
# isn't an SSH alias in ~/.ssh/config.
SSH_HOST="${WALNUT_LIVE_SSH_HOST:-$HOST}"

# Probe SSH reachability. ConnectTimeout=3, BatchMode=yes → no interactive auth.
# ConnectTimeout=3 handles the time cap; avoid `timeout` (not on macOS by default).
if ! ssh \
    -o ConnectTimeout=3 \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    "$SSH_HOST" 'echo ok' >/dev/null 2>&1; then
  cat <<EOF

╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║  🟡  LIVE DAEMON TESTS SKIPPED                                   ║
║      cannot reach host: ${HOST}
║                                                                  ║
║      This run is NOT AUTHORITATIVE — live tests exercise real    ║
║      SSH, real daemon, real /proc/<pid>/stat. When skipped,      ║
║      PID-recycle defense and reconcile-after-crash are UNTESTED. ║
║                                                                  ║
║      To enable: ensure SSH to '${HOST}' works (BatchMode).       ║
║      Or: WALNUT_LIVE_HOST=<myhost> bash $0
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝

EOF
  exit 0
fi

echo "🟢 LIVE daemon tests running against walnut host=${HOST} ssh=${SSH_HOST}"
export WALNUT_LIVE_HOST="$HOST"
export WALNUT_LIVE_SSH_HOST="$SSH_HOST"

# Run files SEQUENTIALLY (--no-file-parallelism). Each test file creates its
# own walnut server + drives the SAME remote daemon; running them concurrently
# causes state cross-contamination (one test's session:start sees another's
# daemon reconnect, session:result timeouts, stale sessions.json entries).
# Cleanup between files ensures a clean remote daemon for each suite.
cleanup_remote() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=3 "$SSH_HOST" \
    'kill -9 $(cat /tmp/open-walnut/daemon.pid 2>/dev/null) 2>/dev/null; rm -f /tmp/open-walnut/sessions.json' \
    >/dev/null 2>&1 || true
}

FAILED=0
# The live config: it runs the real CLI (vitest.live.config.ts lifts the mock
# guard) and keeps WALNUT_LIVE_HOST. Every mock tier drops that variable, so
# these files never reach the host from a normal run.
for test_file in \
  tests/e2e/daemon.live.test.ts \
  tests/e2e/daemon-registry-integrity.live.test.ts \
  tests/e2e/daemon-kill-claude.live.test.ts \
  tests/e2e/daemon-kill-daemon.live.test.ts
do
  echo ""
  echo "▶ $test_file"
  cleanup_remote
  if ! npx vitest run --config vitest.live.config.ts "$test_file"; then
    FAILED=$((FAILED + 1))
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "🟢 All live daemon tests PASSED"
else
  echo "🔴 $FAILED live daemon test file(s) failed"
  exit 1
fi
