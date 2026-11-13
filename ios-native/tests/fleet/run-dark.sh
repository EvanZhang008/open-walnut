#!/usr/bin/env bash
# The UI runner with the simulator in dark appearance, for a fleet `run` (cwd ios-native,
# WALNUT_SIM_UDID set by remote-run.sh; its result bundle lands where a `ui` run's does, so
# the screenshots come back the same way). The appearance is put back afterwards.
#   scripts/ios-fleet-test.sh run -- bash tests/fleet/run-dark.sh -only-testing:WalnutUITests/RoutinesUITests/testDarkModeAndLargeText
# XCUIDevice.shared.appearance did not change a test's screenshots (2026-11-04, Xcode 26).
set -u
: "${WALNUT_SIM_UDID:?run through scripts/ios-fleet-test.sh run}"
xcrun simctl ui "$WALNUT_SIM_UDID" appearance dark
WALNUT_UITEST_DD="$PWD/../../../DerivedData" WALNUT_UITEST_RESULT_BUNDLE="$PWD/../../out/Test.xcresult" \
  bash tests/ui/run-ui-tests.sh "$@"
rc=$?
xcrun simctl ui "$WALNUT_SIM_UDID" appearance light
exit $rc
