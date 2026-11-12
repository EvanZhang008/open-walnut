#!/usr/bin/env bash
# Pin choices, legacy placement and custom-tier overflow on an isolated fixture.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${WALNUT_UITEST_UDID:?Set the reserved lane B simulator UDID}"
: "${WALNUT_UITEST_GATE_UDID:?Set the matching lane B simulator UDID}"
[ "$WALNUT_UITEST_UDID" = "$WALNUT_UITEST_GATE_UDID" ] || exit 2
[ "${SIM_LANE:-}" = b ] || exit 2
. "$ROOT/scripts/lib/sim-device.sh"
. "$ROOT/ios-native/tests/ui/machine-gate-wait.sh"
walnut_sim_check "$WALNUT_UITEST_UDID" || exit 2
uitest_machine_gate "$WALNUT_UITEST_UDID" "the Pin fixture"
SLOT="${WALNUT_HEAVY_SLOT_SCRIPT:-}"
run_heavy() { if [ -n "$SLOT" ]; then bash "$SLOT" "$@"; else "$@"; fi; }
OUT="${PIN_TIERS_UI_OUT:-/tmp/pin-tiers-ios/ui}"
case "$OUT" in /tmp/pin-tiers-ios/*) ;; *) exit 2 ;; esac
[ ! -e "$OUT/ready.json" ] || { printf '%s\n' 'Use a fresh evidence directory for each run' >&2; exit 2; }
mkdir -p "$OUT"
# The server also reads machine hold before it changes HOME to its isolated copy.
run_heavy bash -c '
  "$3" "$1/ios-native/tests/ui/pin-tiers-server.ts" "$2" > "$2/server.log" 2>&1 &
  printf "%s\n" "$!" > "$2/fixture.pid"
' _ "${WALNUT_PIN_FIXTURE_ROOT:-$ROOT}" "$OUT" "${WALNUT_BUN:-bun}"
FIXTURE_PID="$(python3 -c 'import pathlib,sys; print(int(pathlib.Path(sys.argv[1]).read_text()))' "$OUT/fixture.pid")"
cleanup() { kill -TERM "$FIXTURE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM HUP
python3 - "$OUT/ready.json" "$FIXTURE_PID" <<'PY'
import os, pathlib, sys, time
ready, pid = pathlib.Path(sys.argv[1]), int(sys.argv[2])
end = time.monotonic() + 110
while not ready.exists():
    os.kill(pid, 0)
    if time.monotonic() > end: raise SystemExit('fixture startup timed out')
    time.sleep(0.25)
PY
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$OUT/ready.json" "$1"; }
status=0
WALNUT_UITEST_SERVER="$(field server)" WALNUT_UITEST_TOKEN="$(field token)" WALNUT_UITEST_ISOLATED=1 \
  WALNUT_UITEST_ROW_ID="$(field row)" WALNUT_UITEST_ROW_QUERY="$(field tier)" \
  WALNUT_UITEST_MAY_ERASE_APP_DATA=1 WALNUT_UITEST_DD="${WALNUT_UITEST_DD:-$OUT/derived-data}" \
  WALNUT_UITEST_RESULT_BUNDLE="${WALNUT_UITEST_RESULT_BUNDLE:-$OUT/result.xcresult}" \
  bash "$ROOT/ios-native/tests/ui/run-ui-tests.sh" \
    -only-testing:WalnutUITests/DemoModeUITests/testTaskDetailsCallThePlacementPinAndKeepItsChoicesAfterReopening \
    -only-testing:WalnutUITests/DemoModeUITests/testPinChoiceIncludesACustomGroupAndSurvivesAnOfflineReopen \
    -only-testing:WalnutUITests/TasksDrawerUITests/testThePinnedChipRailStaysVisibleAfterVerticalAndDiagonalDrags || status=$?
# GET only: the unchanged WAITING row is separate from the removed pin section.
curl -sf -H "Authorization: Bearer $(field token)" "$(field server)/api/v1/tasks/$(field waiting)" > "$OUT/waiting.json"
python3 - "$OUT/waiting.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))['task']['phase'] == 'WAITING'
PY
exit "$status"
