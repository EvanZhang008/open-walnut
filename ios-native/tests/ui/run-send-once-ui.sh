#!/usr/bin/env bash
# Run SendOnceUITests (ios-native/WalnutUITests/SendOnceUITests.swift) against its own
# isolated server: ios-native/tests/ui/send-once-server.ts, a real Walnut in a
# throwaway home with the mock daemon and the mock CLI, behind a proxy that stages
# the lost answers the tests are about.
#
# Usage, from anywhere in the checkout:
#   WALNUT_UITEST_UDID=<simulator udid> ios-native/tests/ui/run-send-once-ui.sh
#       start the harness, run the tests through run-ui-tests.sh (which builds, and
#       takes its own lease, /tmp/walnut-ios-sim.lock) on that simulator, stop the
#       harness. The device is named, never guessed: with two simulators booted,
#       "the booted one" is whichever simctl lists first.
#   ios-native/tests/ui/run-send-once-ui.sh --serve [seconds]
#       start the harness only, print its address and token, and keep it up for the
#       given seconds (default 1800) or until <out>/done exists. For a caller that
#       already holds a simulator (under any lease) and runs `xcodebuild
#       test-without-building -destination id=<its udid>` itself: put
#       WALNUT_UITEST_SERVER and WALNUT_UITEST_TOKEN into the .xctestrun's
#       EnvironmentVariables (run-ui-tests.sh says why exporting them is not
#       enough). The tests know no device: they run on the destination given.
#
# Environment:
#   SEND_ONCE_UI_PORT  the proxy's port (default 38831; 3456 is refused)
#   SEND_ONCE_UI_OUT   where the step log, the proxy log and the screenshots go
#                      (default a new temp dir, printed at the end)
#
# The harness ends with this script (and on its own when its parent goes away, or
# after SEND_ONCE_UI_MAX_MIN minutes), and removes its home when it does.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${SEND_ONCE_UI_PORT:-38831}"
OUT="${SEND_ONCE_UI_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/walnut-send-once-ui.XXXXXX")}"
TSX="$ROOT/node_modules/.bin/tsx"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

[ "$PORT" != 3456 ] || die "3456 is the production port"
[ -x "$TSX" ] || die "no $TSX (run npm install in $ROOT)"
if [ "${1:-}" != "--serve" ] && [ -z "${WALNUT_UITEST_UDID:-}" ]; then
  die "name the simulator: WALNUT_UITEST_UDID=<udid> (xcrun simctl list devices booted)"
fi
mkdir -p "$OUT" || die "cannot create $OUT"
rm -f "$OUT/ready.json" "$OUT/done"

"$TSX" "$ROOT/ios-native/tests/ui/send-once-server.ts" "$PORT" "$OUT" > "$OUT/server.log" 2>&1 &
HPID=$!
stop_harness() {
  kill -TERM "$HPID" 2>/dev/null || return 0
  for _ in $(seq 1 40); do kill -0 "$HPID" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$HPID" 2>/dev/null
  return 0
}
trap stop_harness EXIT INT TERM HUP

say "starting the harness on 127.0.0.1:$PORT (log $OUT/server.log)"
for _ in $(seq 1 240); do
  [ -s "$OUT/ready.json" ] && break
  kill -0 "$HPID" 2>/dev/null || { tail -40 "$OUT/server.log" >&2; die "the harness exited before it was ready"; }
  sleep 0.5
done
[ -s "$OUT/ready.json" ] || { tail -40 "$OUT/server.log" >&2; die "the harness was not ready after 120 s"; }
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$OUT/ready.json") \
  || die "unreadable $OUT/ready.json"
SERVER="http://127.0.0.1:$PORT"

if [ "${1:-}" = "--serve" ]; then
  SECS="${2:-1800}"
  echo "SEND_ONCE_UI_SERVER=$SERVER"
  echo "SEND_ONCE_UI_TOKEN=$TOKEN"
  echo "SEND_ONCE_UI_OUT=$OUT"
  END=$(( $(date +%s) + SECS ))
  while kill -0 "$HPID" 2>/dev/null && [ ! -e "$OUT/done" ] && [ "$(date +%s)" -lt "$END" ]; do sleep 2; done
  exit 0
fi

WALNUT_UITEST_SERVER="$SERVER" WALNUT_UITEST_TOKEN="$TOKEN" WALNUT_UITEST_UDID="$WALNUT_UITEST_UDID" \
  "$ROOT/ios-native/tests/ui/run-ui-tests.sh" -only-testing:WalnutUITests/SendOnceUITests
rc=$?
say "step log $OUT/uitest.log, proxy log $OUT/proxy.jsonl, screenshots $OUT/shots"
exit $rc
