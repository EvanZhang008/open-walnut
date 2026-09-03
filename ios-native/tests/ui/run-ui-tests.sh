#!/usr/bin/env bash
# Run the XCUITest layer (WalnutUITests) on a simulator, with the pairing the
# paired tests need actually reaching the test runner.
#
# WHY THIS SCRIPT EXISTS, in one paragraph. The paired UI tests read
# `WALNUT_UITEST_SERVER` / `WALNUT_UITEST_TOKEN` from
# `ProcessInfo.processInfo.environment` and XCTSkip when they are absent. That is
# the right policy — a machine with no paired server is not a regression — but
# for a long time nothing could satisfy it, so the tests skipped on every machine
# forever, which is indistinguishable from having deleted them. The reason is
# narrow and easy to get wrong: **xcodebuild does not pass the invoking shell's
# environment to the XCUITest runner process.** `export WALNUT_UITEST_SERVER=…`
# then `xcodebuild test` skips, every time. The runner only ever sees variables
# that are written into the `.xctestrun` file's `EnvironmentVariables`.
#
# `TEST_RUNNER_<NAME>=…` is the documented way to get one there, and this script
# does pass it — but do not TRUST it. Measured on Xcode 26 / iOS 26.0, on a clean
# derived-data tree, with the setting given to `build-for-testing` (the step that
# generates the file): the variable did NOT appear in the .xctestrun, and the run
# skipped. xcodebuild echoes `Build settings from command line: TEST_RUNNER_… =`
# back at you either way, which is exactly how this got mis-reported as working
# more than once. It is also a silent no-op when handed to a `test` action whose
# products are already up to date.
#
# So the script treats it as a hint, not a mechanism: pass it, then GREP the
# .xctestrun with plutil, and write the variables in directly when they are not
# there. The grep is the load-bearing part — it is what stops this recipe from
# rotting back into "everything skipped and nobody noticed".
#
# Usage:
#   ios-native/tests/ui/run-ui-tests.sh                      # whole WalnutUITests target
#   ios-native/tests/ui/run-ui-tests.sh -only-testing:WalnutUITests/VoiceQuickActionUITests
#   WALNUT_UITEST_SERVER=https://my.server WALNUT_UITEST_TOKEN=abc \
#     ios-native/tests/ui/run-ui-tests.sh -only-testing:WalnutUITests/BoardRingTapUITests
#
# Environment:
#   WALNUT_UITEST_SERVER  server the app is paired to. Default: a DEAD PORT (see below).
#   WALNUT_UITEST_TOKEN   device token. Default: a throwaway string.
#   WALNUT_UITEST_UDID    simulator. Default: the booted one.
#   WALNUT_UITEST_DD      derived data path. Default: /tmp/walnut-uitest-dd.
#
# The default server is deliberately a dead port, and it touches nobody's data.
# Pairing only has to be SHAPED right for the app to leave SetupView: a transport
# error is inconclusive to ConnectionStore, so the app stays paired and simply
# reads as offline. Measured on that default: all 3 VoiceQuickActionUITests pass
# (they assert UI facts — tab bar, tab switch, mic open, which callback delivered
# the shortcut — and already accept the offline caption), and 3 of the 4
# BoardRingTapUITests pass too, because the board renders disk-cached rows offline.
# The one that does not is the tap test, which needs `WALNUT_UITEST_ROW_ID` for a
# throwaway task the run owns — it refuses to complete somebody's real task.
set -uo pipefail

IOS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJ="$IOS/Walnut.xcodeproj"
BUNDLE=dev.openwalnut.ios
DD="${WALNUT_UITEST_DD:-/tmp/walnut-uitest-dd}"
SERVER="${WALNUT_UITEST_SERVER:-http://127.0.0.1:59999}"
TOKEN="${WALNUT_UITEST_TOKEN:-ui-test-offline}"
# Default to the whole target. Assigned before any `"${ONLY[@]}"` expansion so
# this stays safe on macOS's stock bash 3.2, where expanding an empty array under
# `set -u` is an error.
if [ "$#" -gt 0 ]; then ONLY=("$@"); else ONLY=(-only-testing:WalnutUITests); fi

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

UDID="${WALNUT_UITEST_UDID:-}"
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl list devices booted 2>/dev/null \
         | sed -n 's/.*(\([0-9A-F-]\{36\}\)) (Booted).*/\1/p' | head -1)
fi
[ -n "$UDID" ] || die "no booted simulator; boot one or set WALNUT_UITEST_UDID"
say "simulator $UDID"
if [ "$SERVER" = "http://127.0.0.1:59999" ]; then
  say "pairing at the OFFLINE DEFAULT ($SERVER): enough for the voice/warm-delivery tests; pass WALNUT_UITEST_SERVER for anything needing real board content"
else
  say "pairing at $SERVER"
fi

command -v xcodegen >/dev/null || die "xcodegen not on PATH"

# One simulator is an EXCLUSIVE resource, so hold a lease for the whole run. Two
# concurrent runs are not slow, they are wrong: they install the same bundle id
# on the same device, so one gets `Simulator device failed to launch`, the other
# restarts its test host mid-suite and silently orphans cases, and every pass and
# fail either one prints is garbage. `xcodegen generate` also rewrites the shared
# Walnut.xcodeproj, so even the build step races. Same reasoning as the
# machine-wide Playwright gate (tests/e2e/browser/pw-gate.ts).
#
# Queuing here is correct behaviour, not a hang. A lease whose holder is gone is
# reclaimed. TERM is trapped alongside EXIT because a bare `trap … EXIT` does NOT
# run when a supervisor kills this script on a timeout, which leaks the lease and
# blocks the machine for everyone.
LOCK=/tmp/walnut-ios-sim.lock
# Release only a lease this process actually owns. A queuing run that gets killed
# must not drop the ACTIVE holder's lease, which would unleash the exact
# concurrency the lease exists to prevent.
release_lease() { [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ] && rm -rf "$LOCK"; return 0; }
took=no
for attempt in $(seq 1 240); do
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$" > "$LOCK/pid"
    trap release_lease EXIT INT TERM HUP
    took=yes; break
  fi
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    say "reclaiming $LOCK from dead pid $holder"; rm -rf "$LOCK"; continue
  fi
  [ "$attempt" = 1 ] && say "another simulator run holds $LOCK (pid ${holder:-?}) — queuing, this is not a hang"
  sleep 15
done
[ "$took" = yes ] || die "could not take $LOCK after 60 min (holder pid $(cat "$LOCK/pid" 2>/dev/null || echo '?'))"
say "simulator lease held"

( cd "$IOS" && xcodegen generate >/dev/null ) || die "xcodegen generate failed"

# 1. Generate the .xctestrun WITH the runner env baked in. This is the step that
#    has to carry TEST_RUNNER_*; a later `test` action cannot add them.
say "build-for-testing → $DD"
xcodebuild build-for-testing \
  -project "$PROJ" -scheme Walnut \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$DD" -quiet \
  "TEST_RUNNER_WALNUT_UITEST_SERVER=$SERVER" \
  "TEST_RUNNER_WALNUT_UITEST_TOKEN=$TOKEN" \
  || die "build-for-testing failed"

# 2. An explicit -derivedDataPath is also what makes the NEXT line safe: several
#    Walnut-* DerivedData trees exist on a machine that builds from more than one
#    checkout, and picking one with `find | head -1` silently tests a stale app.
XCTESTRUN=$(ls -t "$DD"/Build/Products/*.xctestrun 2>/dev/null | head -1)
[ -n "$XCTESTRUN" ] || die "no .xctestrun under $DD/Build/Products"
say "xctestrun $XCTESTRUN"

# 3. PROVE the variable landed rather than trusting that it did. This check is the
#    whole reason the recipe can't rot back into "it skipped and nobody knew why".
if ! /usr/bin/plutil -p "$XCTESTRUN" | grep -q WALNUT_UITEST_SERVER; then
  say "TEST_RUNNER_ did not reach the .xctestrun — injecting directly"
  python3 - "$XCTESTRUN" "$SERVER" "$TOKEN" <<'PY' || die "xctestrun injection failed"
import plistlib, sys
path, server, token = sys.argv[1:4]
with open(path, 'rb') as f: doc = plistlib.load(f)
def inject(target):
    for key in ('EnvironmentVariables', 'TestingEnvironmentVariables'):
        env = dict(target.get(key) or {})
        env['WALNUT_UITEST_SERVER'] = server
        env['WALNUT_UITEST_TOKEN'] = token
        target[key] = env
n = 0
for cfg in doc.get('TestConfigurations', []):
    for target in cfg.get('TestTargets', []):
        if 'UITest' in target.get('BlueprintName', ''):
            inject(target); n += 1
if not n:  # xctestrun v1: top-level target dict
    for name, target in doc.items():
        if isinstance(target, dict) and 'UITest' in name:
            inject(target); n += 1
with open(path, 'wb') as f: plistlib.dump(doc, f)
print(f"injected into {n} UI test target(s)")
if n == 0: raise SystemExit("found no UI test target to inject into")
PY
  /usr/bin/plutil -p "$XCTESTRUN" | grep -q WALNUT_UITEST_SERVER \
    || die "injection did not take — the runner will skip"
fi
say "verified: the runner will see WALNUT_UITEST_SERVER"

# 4. Microphone, for the voice tests. A denied mic reads as "the shortcut is
#    broken", which is the wrong diagnosis for a permission nobody granted.
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcrun simctl privacy "$UDID" grant microphone "$BUNDLE" >/dev/null 2>&1 \
  && say "microphone granted to $BUNDLE" \
  || say "could not grant microphone (install the app once, then re-run)"

say "test-without-building ${ONLY[*]}"
xcodebuild test-without-building \
  -xctestrun "$XCTESTRUN" \
  -destination "platform=iOS Simulator,id=$UDID" \
  "${ONLY[@]}"
rc=$?
say "xcodebuild rc=$rc"
exit $rc
