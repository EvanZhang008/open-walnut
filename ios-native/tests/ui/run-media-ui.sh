#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${WALNUT_UITEST_UDID:?Set the reserved gate simulator UDID}"
: "${WALNUT_UITEST_GATE_UDID:?Set the matching gate simulator UDID}"
: "${WALNUT_HEAVY_SLOT_SCRIPT:?Set the machine admission script}"
: "${SIM_LANE:?Set the reserved simulator lane}"
: "${WALNUT_SIM_QUEUE_SCRIPT:?Set the simulator admission script}"
[ "$WALNUT_UITEST_UDID" = "$WALNUT_UITEST_GATE_UDID" ] || exit 2
OUT="${MEDIA_UI_OUT:-/tmp/phone-media/ui}"
case "$OUT" in /tmp/phone-media/*) ;; *) exit 2 ;; esac
[ ! -e "$OUT/ready.json" ] || { printf '%s\n' 'Use a fresh evidence directory' >&2; exit 2; }
mkdir -p "$OUT"
bash "$WALNUT_HEAVY_SLOT_SCRIPT" bash -c '
  node --import tsx "$1/ios-native/tests/ui/media-server.ts" "$2" > "$2/server.log" 2>&1 &
  printf "%s\n" "$!" > "$2/fixture.pid"
' _ "$ROOT" "$OUT"
FIXTURE_PID="$(python3 -c 'import pathlib,sys; print(int(pathlib.Path(sys.argv[1]).read_text()))' "$OUT/fixture.pid")"
cleanup() { kill -TERM "$FIXTURE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM HUP
python3 - "$OUT/ready.json" "$FIXTURE_PID" <<'PY'
import os,pathlib,sys,time
ready,pid=pathlib.Path(sys.argv[1]),int(sys.argv[2])
deadline=time.monotonic()+110
while not ready.exists():
    os.kill(pid,0)
    if time.monotonic()>deadline: raise SystemExit('fixture startup timed out')
    time.sleep(0.25)
PY
SERVER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["server"])' "$OUT/ready.json")"
TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$OUT/ready.json")"
WALNUT_UITEST_SERVER="$SERVER" WALNUT_UITEST_TOKEN="$TOKEN" \
  WALNUT_UITEST_DD="$OUT/derived-data" WALNUT_UITEST_RESULT_BUNDLE="$OUT/result.xcresult" \
  bash "$ROOT/ios-native/tests/ui/run-ui-tests.sh" \
  -only-testing:WalnutUITests/MediaFileUITests \
  -only-testing:WalnutTests/SessionMediaLoaderTests \
  -only-testing:WalnutTests/FilePreviewLinkTests
