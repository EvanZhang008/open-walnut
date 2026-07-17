#!/usr/bin/env bash
# Random-walk monkey tester for the Walnut iOS app on a simulator.
#
# Usage: ./monkey.sh <udid|booted> [rounds]
#
# Per round: dump the accessibility tree via `maestro hierarchy`, pick a random
# actionable element, act on it (tap / swipe / type / background-foreground),
# then check for (a) new crash reports, (b) a frozen screen (same screenshot
# hash across consecutive rounds), (c) the app process disappearing.
#
# Exit code 0 = survived all rounds; 1 = crash found; 2 = freeze suspected.
set -uo pipefail

UDID="${1:-booted}"
ROUNDS="${2:-100}"
BUNDLE="dev.openwalnut.ios"
RUN_DIR="$(dirname "$0")/runs/$(date +%Y%m%d-%H%M%S)"
CRASH_DIR="$HOME/Library/Logs/DiagnosticReports"
mkdir -p "$RUN_DIR"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RUN_DIR/actions.log"; }

# Baseline: crash reports that already exist don't count.
ls "$CRASH_DIR" 2>/dev/null | grep -i walnut > "$RUN_DIR/crashes-before.txt" || true

# Make sure the app is fresh.
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null
sleep 3

PREV_HASH=""
SAME_COUNT=0
FREEZE_LIMIT=5   # N identical screens after actions that should change them

for i in $(seq 1 "$ROUNDS"); do
  # ── liveness: is the process still there? ──────────────────────────────
  PID=$(xcrun simctl spawn "$UDID" launchctl list 2>/dev/null \
        | grep "$BUNDLE" | awk '{print $1}' | head -1)
  if [ -z "$PID" ] || [ "$PID" = "-" ]; then
    # Process gone — check for a NEW crash report.
    ls "$CRASH_DIR" 2>/dev/null | grep -i walnut > "$RUN_DIR/crashes-after.txt" || true
    if ! diff -q "$RUN_DIR/crashes-before.txt" "$RUN_DIR/crashes-after.txt" >/dev/null 2>&1; then
      NEW=$(comm -13 "$RUN_DIR/crashes-before.txt" "$RUN_DIR/crashes-after.txt")
      log "CRASH at round $i: $NEW"
      cp "$CRASH_DIR"/$NEW "$RUN_DIR/" 2>/dev/null || true
      echo "CRASH round=$i report=$NEW" > "$RUN_DIR/verdict.txt"
      exit 1
    fi
    log "app exited without crash report (round $i) — relaunching"
    xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null; sleep 2
    continue
  fi

  # ── choose an action ───────────────────────────────────────────────────
  ROLL=$((RANDOM % 100))
  if [ "$ROLL" -lt 55 ]; then
    # Tap a random point inside the app's safe area (avoids status bar).
    X=$((RANDOM % 380 + 10)); Y=$((RANDOM % 700 + 100))
    ACTION="tapOn point $X,$Y"
    maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- tapOn:
    point: "${X},${Y}"
EOF
  elif [ "$ROLL" -lt 75 ]; then
    DIRS=(UP DOWN LEFT RIGHT); DIR=${DIRS[$((RANDOM % 4))]}
    ACTION="swipe $DIR"
    maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- swipe:
    direction: $DIR
    duration: 300
EOF
  elif [ "$ROLL" -lt 85 ]; then
    ACTION="type random text"
    maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- inputText: "monkey $RANDOM 🐒 test"
EOF
  elif [ "$ROLL" -lt 95 ]; then
    ACTION="background-foreground"
    xcrun simctl spawn "$UDID" launchctl kickstart -k system/com.apple.SpringBoard >/dev/null 2>&1 || true
    xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
    sleep 1
  else
    ACTION="back gesture (left-edge swipe)"
    maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- swipe:
    start: "1%, 50%"
    end: "80%, 50%"
EOF
  fi
  log "round $i: $ACTION"

  # ── freeze detection: screenshot hash stability + positive control ─────
  # Hash stability alone false-positives: random taps on inert regions (a
  # blank chat area, dead margins) legitimately change nothing. A stable
  # screen only ESCALATES to a positive control — switch tabs, which MUST
  # repaint. Only an unchanged screen after the control counts as a freeze.
  SHOT="$RUN_DIR/step-$i.png"
  xcrun simctl io "$UDID" screenshot "$SHOT" >/dev/null 2>&1 || true
  HASH=$(md5 -q "$SHOT" 2>/dev/null || echo "none")
  if [ "$HASH" = "$PREV_HASH" ]; then
    SAME_COUNT=$((SAME_COUNT + 1))
    if [ "$SAME_COUNT" -ge "$FREEZE_LIMIT" ]; then
      log "screen static for $FREEZE_LIMIT rounds — running positive control (tab switch)"
      # A visible keyboard covers the tab bar and eats the control taps —
      # dismiss it first or the control false-positives as a freeze.
      maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- hideKeyboard
EOF
      # Screenshot WHILE ON the other tab. Tapping Settings→Chat and then
      # comparing would compare Chat-before vs Chat-after — identical when
      # everything works, i.e. a guaranteed false positive.
      maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- tapOn: "Settings"
EOF
      sleep 1
      CTRL="$RUN_DIR/control-$i.png"
      xcrun simctl io "$UDID" screenshot "$CTRL" >/dev/null 2>&1 || true
      CTRL_HASH=$(md5 -q "$CTRL" 2>/dev/null || echo "none2")
      # Restore the original tab regardless of verdict.
      maestro --udid "$UDID" -q run - <<EOF >/dev/null 2>&1 || true
appId: $BUNDLE
---
- tapOn: "Chat"
EOF
      if [ "$CTRL_HASH" = "$HASH" ]; then
        log "FREEZE confirmed: switching to Settings did not repaint"
        # Capture a hang dump for forensics before giving up.
        xcrun simctl spawn "$UDID" spindump "$PID" 5 -file "$RUN_DIR/hang-spindump.txt" >/dev/null 2>&1 || true
        echo "FREEZE round=$i pid=$PID" > "$RUN_DIR/verdict.txt"
        exit 2
      fi
      log "positive control passed — static screen was inert taps, not a freeze"
      SAME_COUNT=0
      PREV_HASH=""
      continue
    fi
  else
    SAME_COUNT=0
    # Keep disk usage sane: only retain screenshots around incidents.
    [ $((i % 10)) -ne 0 ] && rm -f "$RUN_DIR/step-$((i-3)).png" 2>/dev/null
  fi
  PREV_HASH="$HASH"
done

echo "SURVIVED rounds=$ROUNDS" > "$RUN_DIR/verdict.txt"
log "survived all $ROUNDS rounds — no crash, no freeze"
exit 0
