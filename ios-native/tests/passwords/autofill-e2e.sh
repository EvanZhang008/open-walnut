#!/usr/bin/env bash
# Passwords on the iPhone, end to end on a simulator, against a real Walnut with a FAKE vault:
# set up with the master password, browse and copy, turn Walnut on as the AutoFill provider,
# then fill a login and a two-step code in Safari with Face ID. Screens go to $E2E_OUT.
#
# Run it on a fleet Mac (scripts/ios-fleet-test.sh --video run -- bash tests/passwords/autofill-e2e.sh)
# or wherever WALNUT_SIM_UDID names a simulator you may use. Never against your real Walnut:
#   WALNUT_E2E_SERVER   a throwaway Walnut (never :3456) with a vault of fake items
#   WALNUT_E2E_TOKEN    a device token on it
#   WALNUT_E2E_MASTER   that vault's master password
#   WALNUT_E2E_SITE     a login page (default http://localhost:8765/login.html) and its
#                       otp.html beside it, with a vault login saved for that site
#   WALNUT_E2E_PASSKEY_PK  the localhost passkey's public key (seed-vault.sh prints it), so the
#                       passkey page checks the signature; the vault and site/ come from
#                       seed-vault.sh and site/ in this folder
#   WALNUT_E2E_FLOWS    which flows to run (default: all, in order)
#   WALNUT_E2E_SERVER_HOME  that server's data folder, when it is on this Mac: its approval keys
#                       are removed first, so the fresh install is the first device that signs and
#                       no "let this iPhone sign approvals" sheet covers the app
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ROOT=$PWD
U=${WALNUT_SIM_UDID:?WALNUT_SIM_UDID}
SERVER=${WALNUT_E2E_SERVER:?WALNUT_E2E_SERVER}
TOKEN=${WALNUT_E2E_TOKEN:?WALNUT_E2E_TOKEN}
MASTER=${WALNUT_E2E_MASTER:?WALNUT_E2E_MASTER}
SITE=${WALNUT_E2E_SITE:-http://localhost:8765/login.html}
case $SERVER in *:3456|*:3456/*) echo "autofill-e2e: refusing the production port"; exit 64 ;; esac
OUT=$(mkdir -p "${E2E_OUT:-$PWD/../../out}" && cd "${E2E_OUT:-$PWD/../../out}" && pwd)/passwords
mkdir -p "$OUT"
DD=${E2E_DERIVED:-$PWD/../../dd-passwords}
MAESTRO=${MAESTRO:-$(command -v maestro || echo ~/.maestro/bin/maestro)}
APP_ID=dev.openwalnut.ios

say() { printf 'autofill-e2e: %s\n' "$*"; }
shot() { xcrun simctl io "$U" screenshot --type=png "$OUT/$1.png" >/dev/null 2>&1; }

say "building for $U"
xcodebuild -project Walnut.xcodeproj -scheme Walnut -configuration Debug -destination "platform=iOS Simulator,id=$U" \
  -derivedDataPath "$DD" build > "$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; say "build failed"; exit 1; }
APP=$(find "$DD/Build/Products" -maxdepth 2 -name Walnut.app -type d | head -1)
xcrun simctl terminate "$U" "$APP_ID" >/dev/null 2>&1
# A clean install: the app group (the vault cache) goes with the app, so setup starts over.
xcrun simctl uninstall "$U" "$APP_ID" >/dev/null 2>&1
xcrun simctl install "$U" "$APP" || exit 1
# Pair the app with the throwaway server (UserDefaults; the token through AppConfig's DEBUG hook).
xcrun simctl spawn "$U" defaults write "$APP_ID" walnut.serverUrl "$SERVER"
xcrun simctl spawn "$U" defaults write "$APP_ID" walnut.deviceToken "$TOKEN"
xcrun simctl spawn "$U" defaults write "$APP_ID" walnut.deviceName "Passwords E2E"
if [ -n "${WALNUT_E2E_SERVER_HOME:-}" ]; then
  case $(cd "$WALNUT_E2E_SERVER_HOME" 2>/dev/null && pwd) in
    "$HOME/.open-walnut"|"") echo "autofill-e2e: refusing WALNUT_E2E_SERVER_HOME=$WALNUT_E2E_SERVER_HOME"; exit 64 ;;
  esac
  rm -f "$WALNUT_E2E_SERVER_HOME/approvals/keys.json"
fi
# Face ID enrolled; a match is sent every 2 s while the flows run (a match with no prompt does nothing).
xcrun simctl spawn "$U" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn "$U" notifyutil -p com.apple.BiometricKit.enrollmentChanged
( while :; do xcrun simctl spawn "$U" notifyutil -p com.apple.BiometricKit_Sim.pearl.match >/dev/null 2>&1; sleep 2; done ) &
FACE=$!
trap 'kill $FACE 2>/dev/null' EXIT

# Maestro 2.1 drives every iOS simulator through one fixed port and prunes one shared log
# folder, so a Maestro run on another simulator of this Mac takes this run's taps and cuts
# its flows short (2026-11-05). Wait for it (at most MAESTRO_WAIT_MIN minutes), never share.
# Maestro keeps only its newest few log folders under the home's Library/Logs and deletes the
# rest when it starts, so a Mac where other Maestro runs start often deletes this run's folder
# mid-flow (NoSuchFileException, then a hang). This run's Maestro gets a home of its own.
export JAVA_TOOL_OPTIONS="-Duser.home=$OUT/maestro-home${JAVA_TOOL_OPTIONS:+ $JAVA_TOOL_OPTIONS}"
mkdir -p "$OUT/maestro-home"
others() { pgrep -fl 'maestro-driver-iosUITests-Runner' | grep -v "/Devices/$U/" | grep -c . ; }
quiet() {
  local end=$(( $(date +%s) + ${MAESTRO_WAIT_MIN:-30} * 60 ))
  while [ "$(others)" -gt 0 ]; do
    [ "$(date +%s)" -lt "$end" ] || { say "another simulator's Maestro is still running; stopping"; exit 75; }
    sleep 20
  done
}
STATUS=0
for f in ${WALNUT_E2E_FLOWS:-01-setup 02-browse 02-codes 03-autofill-on 04-safari-fill 05-safari-sheet 06-lock 07-passkey}; do
  say "flow $f"
  # From the output folder: a flow's takeScreenshot lands where maestro runs.
  for try in 1 2; do
    quiet
    (cd "$OUT" && perl -e 'alarm shift; exec @ARGV' 600 "$MAESTRO" --udid "$U" test "$ROOT/tests/passwords/flows/$f.yaml" \
      -e MASTER="$MASTER" -e SITE="$SITE" -e OTP_SITE="${SITE%/*}/otp.html" -e OTHER_SITE="${SITE/localhost/127.0.0.1}" -e PASSKEY_SITE="${SITE%/*}/passkey.html?pk=${WALNUT_E2E_PASSKEY_PK:-}" \
      --test-output-dir "$OUT/maestro-$f" > "$OUT/$f.log" 2>&1)
    rc=$?
    # Maestro hangs now and then (a flow gets 10 minutes) and its driver drops or reads an
    # empty screen, mostly when another Maestro on the same Mac takes its fixed port. Every flow starts
    # from a fresh launch, so a failed one runs once more, and the log says so.
    [ $rc -ne 0 ] && [ $try = 1 ] && { cp "$OUT/$f.log" "$OUT/$f.try1.log"; say "flow $f failed once, again"; continue; }
    break
  done
  shot "after-$f"
  if [ $rc -ne 0 ]; then
    STATUS=1
    say "flow $f FAILED (rc $rc)"; tail -25 "$OUT/$f.log"
  else
    say "flow $f passed"
  fi
done
exit $STATUS
