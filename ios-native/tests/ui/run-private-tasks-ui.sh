#!/usr/bin/env bash
# The task menu's Sync section on the reserved gate simulator against a fixture server with one
# project that syncs to a fixture service. Never chooses a booted device.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${WALNUT_UITEST_UDID:?Set the reserved gate simulator UDID}"
: "${WALNUT_UITEST_GATE_UDID:?Set the matching gate simulator UDID}"
: "${WALNUT_HEAVY_SLOT_SCRIPT:?Set the machine heavy-command admission script}"
[ "$WALNUT_UITEST_UDID" = "$WALNUT_UITEST_GATE_UDID" ] || exit 2
case "$WALNUT_UITEST_UDID" in ????????-????-????-????-????????????) ;; *) exit 2 ;; esac
[ -f "$WALNUT_HEAVY_SLOT_SCRIPT" ] || exit 2
BUN="${WALNUT_BUN:-bun}"
OUT="${PRIVATE_TASKS_UI_OUT:-/tmp/private-tasks-ios/ui}"
case "$OUT" in /tmp/private-tasks-ios/*) ;; *) exit 2 ;; esac
[ ! -e "$OUT/ready.json" ] || { printf '%s\n' 'Use a fresh evidence directory for each run' >&2; exit 2; }
mkdir -p "$OUT"
# Admission covers startup, not the time a verifier spends reading the UI.
bash "$WALNUT_HEAVY_SLOT_SCRIPT" bash -c '
  "$3" "$1/ios-native/tests/ui/private-tasks-server.ts" "$2" > "$2/server.log" 2>&1 &
  printf "%s\n" "$!" > "$2/fixture.pid"
' _ "$ROOT" "$OUT" "$BUN"
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
CONTROL="$(field control)"
status=0
WALNUT_UITEST_SERVER="$(field server)" WALNUT_UITEST_TOKEN="$(field token)" WALNUT_UITEST_ISOLATED=1 \
  WALNUT_UITEST_PRIVATE_TASKS=1 WALNUT_UITEST_SYNCED_TASK="$(field synced)" WALNUT_UITEST_KEPT_TASK="$(field kept)" \
  WALNUT_UITEST_DD="$OUT/derived-data" WALNUT_UITEST_RESULT_BUNDLE="$OUT/result.xcresult" \
  bash "$ROOT/ios-native/tests/ui/run-ui-tests.sh" -only-testing:WalnutUITests/PrivateTasksUITests || status=$?
# What the server holds afterwards, and every push the fixture service got.
curl -sf "$CONTROL/state" > "$OUT/state.json" || true
exit "$status"
