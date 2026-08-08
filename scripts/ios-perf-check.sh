#!/usr/bin/env bash
# iOS long-session rendering perf check — guards against the class of bug that
# shipped the 2026-08-07 0x8BADF00D watchdog kills (opening/streaming a long
# session froze the main thread >5s and iOS killed the app).
#
# Two layers:
#   L1 (default, ~3-4 min): the WalnutTests XCTest target — correctness
#      invariants (LiveMarkdownWindow, MessageRow helpers, clipProvisional)
#      plus the rendering perf regression gates (MarkdownPerfTests: in-code
#      budget assertions + a load-immune windowed-vs-unwindowed ratio gate).
#      This is `xcodebuild test`, so it also runs from Xcode (Cmd-U) and CI.
#   L2 (--sim, ~5 min): end-to-end freeze smoke on the iPhone 16 Pro sim:
#      build the app, point it at a mock /api/v1 server (mock-server.mjs
#      generates its own synthetic long transcript) with an aggressive live
#      SSE stream, open the session via Maestro, and assert the app's own
#      MainThreadWatchdog "main thread unresponsive" line does NOT appear —
#      the exact signal the field crashes emitted.
#
# Usage:
#   scripts/ios-perf-check.sh            # L1 only (run on parser/render changes)
#   scripts/ios-perf-check.sh --sim      # L1 + L2 (run before iOS releases)
#   scripts/ios-perf-check.sh --sim-only # L2 only (reuses last app build if present)
#
# NO parallel simulators (machine stability rule) — everything targets one
# booted sim, serially (-parallel-testing-enabled NO).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PERF="$REPO/scripts/ios-perf"
WORK="${IOS_PERF_WORK:-/tmp/ios-perf-check}"
SIM_NAME="iPhone 16 Pro"
BUNDLE="dev.openwalnut.ios"
MOCK_PORT=3510
RUN_L1=1
RUN_L2=0
case "${1:-}" in
  --sim) RUN_L2=1 ;;
  --sim-only) RUN_L1=0; RUN_L2=1 ;;
  "") ;;
  *) echo "usage: $0 [--sim|--sim-only]"; exit 2 ;;
esac

mkdir -p "$WORK"
FAIL=0

sim_udid() {
  xcrun simctl list devices available | grep -F "$SIM_NAME (" | grep -v Stress | head -1 | grep -oE '[0-9A-F-]{36}'
}

# ---------- L1: XCTest (WalnutTests) ----------
if [ "$RUN_L1" = 1 ]; then
  UDID="$(sim_udid)"
  if [ -z "$UDID" ]; then echo "[L1] no '$SIM_NAME' simulator available"; exit 1; fi
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

  echo "[L1] xcodegen generate + xcodebuild test (WalnutTests) on sim $UDID"
  (cd "$REPO/ios-native" && xcodegen generate >/dev/null \
    && xcodebuild test -project Walnut.xcodeproj -scheme Walnut \
      -destination "platform=iOS Simulator,id=$UDID" \
      -only-testing:WalnutTests \
      -parallel-testing-enabled NO > "$WORK/l1-xctest.log" 2>&1)
  if grep -q "TEST SUCCEEDED" "$WORK/l1-xctest.log"; then
    echo "[L1] PASS"
    grep -E "Test Suite 'WalnutTests(\.xctest)?' (passed|failed)|\[perf\]|\[watchdog\]|\[scroll\]" "$WORK/l1-xctest.log" | tail -30
  else
    echo "[L1] FAIL — see $WORK/l1-xctest.log"
    grep -E "Test Case .* failed|error:|Test Suite .* failed" "$WORK/l1-xctest.log" | tail -30
    FAIL=1
  fi
fi

# ---------- L2: simulator freeze smoke ----------
if [ "$RUN_L2" = 1 ]; then
  echo "[L2] building app (skipped if $WORK/dd has a build and IOS_PERF_REUSE_BUILD=1)"
  APP="$WORK/dd/Build/Products/Debug-iphonesimulator/Walnut.app"
  if [ ! -d "$APP" ] || [ "${IOS_PERF_REUSE_BUILD:-0}" != 1 ]; then
    (cd "$REPO/ios-native" && xcodegen generate >/dev/null \
      && xcodebuild -project Walnut.xcodeproj -scheme Walnut \
        -destination "platform=iOS Simulator,name=$SIM_NAME" \
        -derivedDataPath "$WORK/dd" build > "$WORK/l2-build.log" 2>&1) \
      || { echo "[L2] BUILD FAILED — see $WORK/l2-build.log"; tail -20 "$WORK/l2-build.log"; exit 1; }
  fi

  UDID="$(sim_udid)"
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

  echo "[L2] starting mock v1 server on :$MOCK_PORT (built-in 1000-msg mixed transcript + aggressive live stream)"
  pkill -f "ios-perf/mock-server.mjs" 2>/dev/null || true
  PORT=$MOCK_PORT MSG_COUNT=1000 LIVE_TEXT_KB=512 DELTA_MS=100 DELTA_BYTES=2000 DELTA_COUNT=300 \
    node "$PERF/mock-server.mjs" > "$WORK/l2-mock.log" 2>&1 &
  MOCK_PID=$!
  trap 'kill $MOCK_PID 2>/dev/null' EXIT
  sleep 1

  echo "[L2] installing + configuring app"
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl install "$UDID" "$APP"
  xcrun simctl spawn "$UDID" defaults write "$BUNDLE" walnut.serverUrl -string "http://localhost:$MOCK_PORT"
  xcrun simctl spawn "$UDID" defaults write "$BUNDLE" "walnut.keychainFallback.walnut.deviceToken" -string "perfcheck"

  echo "[L2] launching + opening the long session"
  xcrun simctl launch --console-pty "$UDID" "$BUNDLE" > "$WORK/l2-console.log" 2>&1 &
  sleep 6
  export PATH="$HOME/.maestro/bin:$PATH"
  cat > "$WORK/l2-open.yaml" <<YAML
appId: $BUNDLE
---
- tapOn: "Tasks"
- waitForAnimationToEnd
- tapOn: "All"
- waitForAnimationToEnd
- tapOn: "Perf check session"
YAML
  if ! maestro --udid "$UDID" test "$WORK/l2-open.yaml" > "$WORK/l2-maestro.log" 2>&1; then
    echo "[L2] NAVIGATION FAILED — see $WORK/l2-maestro.log"; FAIL=1
  fi

  echo "[L2] watching for freeze telemetry (45s: open + reconcile + live stream)"
  sleep 45
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  FREEZES="$(grep -c "main thread unresponsive" "$WORK/l2-console.log" 2>/dev/null || true)"
  if [ "${FREEZES:-0}" -gt 0 ]; then
    echo "[L2] FAIL — $FREEZES freeze line(s):"
    grep -E "unresponsive|recovered" "$WORK/l2-console.log"
    FAIL=1
  else
    echo "[L2] PASS — no 'main thread unresponsive' lines"
  fi
fi

exit $FAIL
