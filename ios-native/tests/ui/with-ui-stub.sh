#!/usr/bin/env bash
# Run a command with tests/ui/mid-turn-stub-server.mjs up, the app paired to it.
#
#   with-ui-stub.sh <log file> <command...>
#
# The UI tests that drive the stub (ModelPillHealUITests, MidTurnQueueUITests and the rest that
# call `stubUnderTest()`) skip at the offline pairing. This starts the stub on a port the kernel
# picks (it prints `PORT <n>` first), exports WALNUT_UITEST_SERVER for run-ui-tests.sh, runs the
# command and stops the stub it started, by its pid, however the command ends. The stub's own
# log goes to <log file>. `scripts/ios-fleet-test.sh --stub ui -- ARGS` runs it on a fleet Mac.
set -uo pipefail
LOG=${1:?log file}; shift
[ $# -gt 0 ] || { echo "with-ui-stub: say what to run" >&2; exit 64; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME=$(command -v node || command -v bun) || { echo "with-ui-stub: needs node or bun" >&2; exit 69; }
mkdir -p "$(dirname "$LOG")"
"$RUNTIME" "$HERE/mid-turn-stub-server.mjs" > "$LOG" 2>&1 &
STUB_PID=$!
CMD_PID=""
trap '[ -z "$CMD_PID" ] || kill -TERM "$CMD_PID" 2>/dev/null; kill -TERM "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null' EXIT
trap 'exit 143' HUP INT TERM
PORT=""
for _ in $(seq 150); do
  PORT=$(awk '/^PORT /{print $2; exit}' "$LOG")
  [ -n "$PORT" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || break
  sleep 0.2
done
[ -n "$PORT" ] || { echo "with-ui-stub: the stub did not start:" >&2; cat "$LOG" >&2; exit 69; }
echo "with-ui-stub: stub on http://127.0.0.1:$PORT ($RUNTIME, pid $STUB_PID)"
# In the background with a wait, so a stop's SIGTERM runs the trap at once.
WALNUT_UITEST_SERVER="http://127.0.0.1:$PORT" "$@" &
CMD_PID=$!
wait "$CMD_PID"
STATUS=$?
CMD_PID=""
exit "$STATUS"
