#!/usr/bin/env bash
# Talk to Walnut against a real paired server (WalnutUITests/TalkRealServerUITests): Walnut in
# the background, the shortcut run from the Shortcuts app, the real voice session opened, and
# the words (a recorded file, so nothing plays or speaks on this Mac) sent to the CEO chat of
# that server. Check them there afterwards.
#
#   run-talk-real-server.sh --server URL --token TOKEN [--out DIR] [-- RUN-UI-TESTS ARGS]
#
#   --server URL   a paired Walnut server the simulator can reach: a test copy of your data
#                  (`bun run dev:ephemeral`), never your real one
#   --token TOKEN  that server's device token for this run
#   --out DIR      where Test.xcresult, the frames and the clip go (default: the fleet run's
#                  out/ when run by tests/fleet/remote-run.sh, else ./talk-real-server-out)
#
# Runs on the simulator in WALNUT_SIM_UDID through tests/ui/run-ui-tests.sh.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

SERVER="" TOKEN="" OUT=""
while [ $# -gt 0 ]; do
  case $1 in
    --server) SERVER=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
note() { echo "talk-real-server: $*"; }
die() { echo "talk-real-server: $*" >&2; exit 1; }
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || die "--server and --token are required"
[ -n "${WALNUT_SIM_UDID:-}" ] || die "no simulator: set WALNUT_SIM_UDID"

# A fleet run (tests/fleet/remote-run.sh) runs this from <run>/src/ios-native; its out/ is
# what comes back to the asking task.
if [ -z "$OUT" ]; then
  if [ -d ../../out ]; then OUT=$(cd ../../out && pwd); else OUT=$PWD/talk-real-server-out; fi
fi
mkdir -p "$OUT"

STATUS=0
DD=${WALNUT_UITEST_DD:-$(cd ../.. 2>/dev/null && cd .. && pwd)/DerivedData}
WALNUT_UITEST_SERVER=$SERVER WALNUT_UITEST_TOKEN=$TOKEN WALNUT_UITEST_REAL_SERVER=1 \
  WALNUT_UITEST_UDID=$WALNUT_SIM_UDID WALNUT_UITEST_LEASE_HELD=1 WALNUT_UITEST_DD=$DD \
  WALNUT_UITEST_RESULT_BUNDLE="$OUT/Test.xcresult" bash tests/ui/run-ui-tests.sh \
  -only-testing:WalnutUITests/TalkRealServerUITests "$@" || STATUS=$?

# The frames the test kept, in order, as one clip (when ffmpeg is here; else the frames alone).
if [ -d "$OUT/Test.xcresult" ]; then
  rm -rf "$OUT/frames"; mkdir -p "$OUT/frames"
  /usr/bin/xcrun xcresulttool export attachments --path "$OUT/Test.xcresult" --output-path "$OUT/frames" >/dev/null 2>&1
  python3 - "$OUT/frames" <<'PY'
import json, os, sys
d = sys.argv[1]
try: manifest = json.load(open(os.path.join(d, 'manifest.json')))
except Exception: sys.exit(0)
n = 0
for test in manifest:
    for a in sorted(test.get('attachments', []), key=lambda a: a.get('suggestedHumanReadableName', '')):
        name = a.get('suggestedHumanReadableName', '')
        if name.startswith('frame-'):
            n += 1
            os.rename(os.path.join(d, a['exportedFileName']), os.path.join(d, 'f%05d.png' % n))
print(f'talk-real-server: {n} frames')
PY
  if command -v ffmpeg >/dev/null && ls "$OUT"/frames/f*.png >/dev/null 2>&1; then
    ffmpeg -loglevel error -y -framerate 2 -i "$OUT/frames/f%05d.png" -vf "scale=-2:1280,format=yuv420p" "$OUT/talk-real-server.mp4" \
      && note "clip $OUT/talk-real-server.mp4"
  fi
fi
note "test exit $STATUS"
exit "$STATUS"
