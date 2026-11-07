#!/usr/bin/env bash
# Waits until xcodebuild lists the booted simulator as a destination of the Walnut scheme.
# 2026-11-06 (CI run 42205675031): the iPhone came up, then xcodebuild answered
# "Unable to find a device matching the provided destination specifier" and listed no
# simulator at all, so the unit leg failed before one test ran. A device xcodebuild does
# not see yet is waited for; one it never sees fails here, saying so.
# 2026-11-07 (CI run 42339693777): simctl read the iPhone as Booted while xcodebuild listed
# it in none of six tries over two minutes, on the image and device that had passed twice
# before. Waiting does not mend that, so halfway through the tries the simulator service is
# restarted once and the iPhone booted again; a failure prints what xcodebuild did list.
#   wait-sim-visible.sh <udid>   (run from ios-native/, with Walnut.xcodeproj generated)
# Knobs: WALNUT_SIM_WAIT_TRIES (6), WALNUT_SIM_WAIT_SECS (20), WALNUT_SIM_RECOVER_AT (3,
# 0 = never), XCODEBUILD (xcodebuild), SIMCTL (xcrun simctl), WALNUT_SIM_SERVICE_RESTART
# (the command that restarts the simulator service: launchd's own restart of its exact
# label in the user domain, never a match on a process name).
set -uo pipefail
udid="${1:?usage: wait-sim-visible.sh <udid>}"
tries="${WALNUT_SIM_WAIT_TRIES:-6}"
secs="${WALNUT_SIM_WAIT_SECS:-20}"
recover_at="${WALNUT_SIM_RECOVER_AT:-3}"
xb="${XCODEBUILD:-xcodebuild}"
read -r -a simctl <<<"${SIMCTL:-xcrun simctl}"
restart="${WALNUT_SIM_SERVICE_RESTART:-launchctl kickstart -k user/$(id -u)/com.apple.CoreSimulator.CoreSimulatorService}"
listed=""

recover() {
  echo "restarting the simulator service and booting $udid again"
  "${simctl[@]}" shutdown "$udid" >/dev/null 2>&1 || true
  bash -c "$restart" || echo "the simulator service restart failed; booting again anyway"
  "${simctl[@]}" boot "$udid" || true
  "${simctl[@]}" bootstatus "$udid" -b >/dev/null || true
}

for ((i = 1; i <= tries; i++)); do
  listed=$("$xb" -project Walnut.xcodeproj -scheme Walnut -showdestinations 2>/dev/null)
  if grep -q "id:$udid[ ,}]" <<<"$listed"; then
    echo "xcodebuild sees simulator $udid (try $i)"
    exit 0
  fi
  if ((i < tries)); then
    echo "xcodebuild does not list simulator $udid yet (try $i of $tries); waiting ${secs}s"
    if ((i == recover_at)); then recover; else sleep "$secs"; fi
  fi
done
echo "::error title=iOS simulator::xcodebuild never listed the booted simulator $udid as a destination"
"${simctl[@]}" list devices 2>/dev/null | grep -F -- "$udid" || true
echo "xcodebuild listed these destinations:"
grep -F "platform:" <<<"$listed" || echo "  (none)"
exit 1
