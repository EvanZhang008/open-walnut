#!/usr/bin/env bash
# Waits until xcodebuild lists the booted simulator as a destination of the Walnut scheme.
# 2026-11-06 (CI run 42205675031): the iPhone came up, then xcodebuild answered
# "Unable to find a device matching the provided destination specifier" and listed no
# simulator at all, so the unit leg failed before one test ran. A device xcodebuild does
# not see yet is waited for; one it never sees fails here, saying so.
#   wait-sim-visible.sh <udid>   (run from ios-native/, with Walnut.xcodeproj generated)
# Knobs: WALNUT_SIM_WAIT_TRIES (6), WALNUT_SIM_WAIT_SECS (20), XCODEBUILD (xcodebuild).
set -uo pipefail
udid="${1:?usage: wait-sim-visible.sh <udid>}"
tries="${WALNUT_SIM_WAIT_TRIES:-6}"
secs="${WALNUT_SIM_WAIT_SECS:-20}"
xb="${XCODEBUILD:-xcodebuild}"
for ((i = 1; i <= tries; i++)); do
  if "$xb" -project Walnut.xcodeproj -scheme Walnut -showdestinations 2>/dev/null | grep -q "id:$udid[ ,}]"; then
    echo "xcodebuild sees simulator $udid (try $i)"
    exit 0
  fi
  if ((i < tries)); then
    echo "xcodebuild does not list simulator $udid yet (try $i of $tries); waiting ${secs}s"
    sleep "$secs"
  fi
done
echo "::error title=iOS simulator::xcodebuild never listed the booted simulator $udid as a destination"
xcrun simctl list devices 2>/dev/null | grep -F -- "$udid" || true
exit 1
