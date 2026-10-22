#!/usr/bin/env bash
# Requires the explicitly reserved gate simulator. Never chooses a booted device.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${WALNUT_UITEST_UDID:?Set the reserved gate simulator UDID}"
: "${WALNUT_UITEST_GATE_UDID:?Set the matching gate simulator UDID}"
: "${WALNUT_HEAVY_SLOT_SCRIPT:?Set the machine heavy-command admission script}"
[ "$WALNUT_UITEST_UDID" = "$WALNUT_UITEST_GATE_UDID" ] || exit 2
case "$WALNUT_UITEST_UDID" in ????????-????-????-????-????????????) ;; *) exit 2 ;; esac
[ -f "$WALNUT_HEAVY_SLOT_SCRIPT" ] || exit 2
OUT="${INBOX_ITEMS_UI_OUT:-/tmp/inbox-item-actions/ios-ui}"
case "$OUT" in /tmp/inbox-item-actions/*) ;; *) exit 2 ;; esac
[ ! -e "$OUT/ready.json" ] || { printf '%s\n' 'Use a fresh evidence directory for each run' >&2; exit 2; }
mkdir -p "$OUT"
# Admission covers startup, not the time a verifier spends reading the UI.
bash "$WALNUT_HEAVY_SLOT_SCRIPT" bash -c '
  "$1/node_modules/.bin/tsx" "$1/ios-native/tests/ui/inbox-items-server.ts" "$2" > "$2/server.log" 2>&1 &
  printf "%s\n" "$!" > "$2/fixture.pid"
' _ "$ROOT" "$OUT"
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
SERVER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["server"])' "$OUT/ready.json")"
TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$OUT/ready.json")"
WALNUT_UITEST_SERVER="$SERVER" WALNUT_UITEST_TOKEN="$TOKEN" WALNUT_UITEST_ISOLATED=1 WALNUT_UITEST_INBOX_ITEMS=1 \
  WALNUT_UITEST_DD="$OUT/derived-data" WALNUT_UITEST_RESULT_BUNDLE="$OUT/result.xcresult" \
  bash "$ROOT/ios-native/tests/ui/run-ui-tests.sh" \
  -only-testing:WalnutUITests/InboxItemActionsUITests -only-testing:WalnutUITests/InboxItemLayoutUITests \
  -only-testing:WalnutTests/InboxItemContractTests -only-testing:WalnutTests/InboxItemLifecycleTests \
  -only-testing:WalnutTests/InboxItemStoreTests -only-testing:WalnutTests/LocalDataResetTests
