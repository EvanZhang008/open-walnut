#!/bin/bash
# The Mac half of scripts/ios-fleet-test.sh: build and test the iOS app on THIS Mac for a
# task that runs on another host. The caller sends the sources (src.tgz, unpacked into
# <run-dir>/src), runs this through host_exec, and fetches <run-dir>/out.tgz back.
#
#   remote-run.sh <run-dir> <unit|ui|build|run> [--video] [--keep-xcresult] [--max-load N] [--udid U] [-- ARGS...]
#
#   unit   xcodebuild test -only-testing:WalnutTests ARGS
#   ui     tests/ui/run-ui-tests.sh ARGS (the pairing-aware XCUITest runner)
#   build  xcodebuild build-for-testing ARGS
#   run    ARGS is a command, run in ios-native with WALNUT_SIM_UDID set
#
# The Mac may be someone else's computer in use, so the run stays out of their way:
#   - it refuses to start (exit 75, "BUSY") while the load per CPU is over --max-load
#     (default 0.75) or another fleet run holds this Mac's test simulator;
#   - xcodebuild runs at utility QoS and nice 10 with half the cores, so the person's
#     own apps keep the machine;
#   - the simulator boots headless (simctl, never Simulator.app), so no window opens
#     and nothing takes focus;
#   - it drives only the simulator it made for itself here, "Walnut Fleet Test", by the
#     UDID it wrote down when it made it (never a lookup by name or by state), or the one
#     --udid names; a WALNUT_SIM_UDID their login shell exports is ignored, and their
#     WALNUT_SIM_PROTECTED_UDIDS is honoured (scripts/lib/sim-device.sh); it shuts down
#     only a simulator it started, also when the run is killed (a watchdog outside the
#     run's process group does it), and it refuses while Simulator is open;
#   - its build products live in this task's directory, never in their DerivedData.
# Exit: the test command's own status, 75 busy, 69 a tool is missing, 70 no disk room.
# The last line of output is `FLEET_RESULT {json}` for the caller to read.
set -uo pipefail

RUN_DIR=${1:?run dir}; MODE=${2:?mode}; shift 2
VIDEO=0; KEEP_XCRESULT=0; MAX_LOAD=0.75; ASKED_UDID=""
while [ $# -gt 0 ]; do
  case $1 in
    --video) VIDEO=1 ;;
    --udid) ASKED_UDID=$2; shift ;;
    --keep-xcresult) KEEP_XCRESULT=1 ;;
    --max-load) MAX_LOAD=$2; shift ;;
    --) shift; break ;;
    *) echo "remote-run: unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

# The login shell host_exec runs this from reads the Mac owner's profile, which may name
# their own simulator (ios-native/README.md tells developers to export one): never use it.
unset WALNUT_SIM_UDID WALNUT_UITEST_UDID WALNUT_UITEST_GATE_UDID SIM_LANE WALNUT_SIM_QUEUE_SCRIPT

SIM_NAME="Walnut Fleet Test"
OUT="$RUN_DIR/out"
# One DerivedData per task (next to the runs), so a second run builds incrementally.
DERIVED="$(dirname "$RUN_DIR")/DerivedData"
LOCK_DIR="$HOME/Library/Caches/walnut-fleet/sim.lock"
SIM_FILE="$HOME/Library/Caches/walnut-fleet/simulator-udid"   # the UDID of the one it made
mkdir -p "$OUT"
# In UTC, so runs on Macs in other time zones (and the caller) read the same clock.
T0=$(date +%s); RUN_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

UDID=""; REC_PID=""; STATUS=0; XCODE=""; RUNTIME_NAME=""
# The test counts and xcodebuild's own time (build and tests) from the result bundle's summary,
# as JSON members
# (empty without one). plutil, never python3: on a Mac without the Command Line Tools,
# /usr/bin/python3 opens their install dialog.
counts() {
  local f="$OUT/summary.json" k v out=""
  [ -f "$f" ] || return 0
  for k in passedTests failedTests skippedTests; do
    v=$(/usr/bin/plutil -extract "$k" raw -o - "$f" 2>/dev/null) && case $v in ''|*[!0-9]*) ;; *) out="$out,\"${k%Tests}\":$v" ;; esac
  done
  local a b
  a=$(/usr/bin/plutil -extract startTime raw -o - "$f" 2>/dev/null) && b=$(/usr/bin/plutil -extract finishTime raw -o - "$f" 2>/dev/null) \
    && out="$out,\"xcodeSecs\":$(awk -v a="$a" -v b="$b" 'BEGIN { printf "%d", b - a + 0.5 }')"
  printf '%s' "$out"
}
result() { # $1 = exit status, $2 = word
  local bytes=0 more ended secs
  [ -f "$RUN_DIR/out.tgz" ] && bytes=$(stat -f %z "$RUN_DIR/out.tgz")
  more=$(counts); ended=$(date -u +%Y-%m-%dT%H:%M:%SZ); secs=$(( $(date +%s) - T0 ))
  # One line a person reads instead of xcodebuild's thousands.
  if [ -n "$more" ]; then
    n() { printf '%s' "$more" | sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p"; }
    echo "remote-run: $2: $(n passed) passed, $(n failed) failed, $(n skipped) skipped; $secs s in all (xcodebuild $(n xcodeSecs) s), $RUN_AT to $ended" >&2
  fi
  printf 'FLEET_RESULT {"exit":%s,"state":"%s","out":"%s","bytes":%s,"udid":"%s","xcode":"%s","runtime":"%s","startedAt":"%s","endedAt":"%s","secs":%s%s}\n' "$1" "$2" "$RUN_DIR/out.tgz" "$bytes" "$UDID" "$XCODE" "$RUNTIME_NAME" "$RUN_AT" "$ended" "$secs" "$more"
}
refuse() { echo "remote-run: $2" >&2; result "$1" "$3"; exit "$1"; }

# A tool the run needs. Never `xcrun` on a Mac without Xcode: that opens an install dialog.
DEV=$(/usr/bin/xcode-select -p 2>/dev/null || true)
case $DEV in *.app/*) ;; *) refuse 69 "no full Xcode on this Mac (xcode-select -p: ${DEV:-none})" missing ;; esac
command -v xcodegen >/dev/null || refuse 69 "xcodegen is not on this Mac (brew install xcodegen)" missing
# Named in the result: a test can pass on one Mac's Xcode and fail on another's.
XCODE=$(/usr/bin/xcodebuild -version 2>/dev/null | awk 'NR == 1 {print $2}')
SIM_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/lib/sim-device.sh"
[ -f "$SIM_LIB" ] || refuse 69 "the sent sources have no scripts/lib/sim-device.sh" missing
. "$SIM_LIB"

CPUS=$(sysctl -n hw.ncpu)
LOAD1=$(sysctl -n vm.loadavg | awk '{print $2}')
if awk -v l="$LOAD1" -v c="$CPUS" -v m="$MAX_LOAD" 'BEGIN { exit !(l / c > m) }'; then
  refuse 75 "BUSY: load $LOAD1 on $CPUS CPUs is over $MAX_LOAD per CPU; try another Mac or later" busy
fi
# Simulator open = someone uses simulators here, and a device booted now would open its window.
if pgrep -x Simulator >/dev/null 2>&1; then
  refuse 75 "BUSY: Simulator is open on this Mac; try another Mac or later" busy
fi
FREE_KB=$(df -k "$RUN_DIR" | awk 'NR == 2 {print $4}')
[ "${FREE_KB:-0}" -ge $((6 * 1024 * 1024)) ] || refuse 70 "only $((FREE_KB / 1024 / 1024)) GB free on this Mac, the build needs 6" no-room

# One fleet run per Mac drives the test simulator; a lock left by a dead run is taken over.
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OWNER=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then
    refuse 75 "BUSY: another fleet iOS run (pid $OWNER) is using this Mac's test simulator" busy
  fi
  rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" || refuse 75 "BUSY: could not take the simulator lock" busy
fi
echo $$ > "$LOCK_DIR/pid"

STARTED=""   # set once this run started the simulator: only then is it shut down
finish() {
  [ -n "$REC_PID" ] && { kill -INT "$REC_PID" 2>/dev/null; wait "$REC_PID" 2>/dev/null; }
  [ -n "$STARTED" ] && /usr/bin/xcrun simctl shutdown "$STARTED" >/dev/null 2>&1
  rm -f "$LOCK_DIR/started"
  [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK_DIR"
}
trap finish EXIT
trap 'exit 143' HUP INT TERM

# A stop from host_exec kills this whole process group (SIGTERM, SIGKILL 3 s later), which
# can end the run before its trap shuts the simulator down. A watchdog in its own session
# outlives the group: once this script's pid is gone it shuts down the simulator this run
# started (named in the lock dir) and frees the lock if it is still ours. At most 3 hours.
/usr/bin/python3 - "$$" "$LOCK_DIR" >/dev/null 2>&1 </dev/null <<'PY' &
import os, subprocess, sys, time
os.setsid()
pid, lock = int(sys.argv[1]), sys.argv[2]
end = time.time() + 3 * 3600
while time.time() < end:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    time.sleep(2)
# "<pid> <udid>": a run that took the lock since then wrote its own, which is not ours to stop.
try:
    owner, udid = (open(os.path.join(lock, "started")).read().split() + ["", ""])[:2]
except OSError:
    owner, udid = "", ""
if udid and owner == str(pid):
    subprocess.run(["/usr/bin/xcrun", "simctl", "shutdown", udid], capture_output=True, timeout=120)
try:
    if open(os.path.join(lock, "pid")).read().strip() == str(pid):
        subprocess.run(["/bin/rm", "-rf", lock])
except OSError:
    pass
PY

# The simulator: the one --udid names, else the one this tool made here (its UDID in
# SIM_FILE), made on the newest iOS runtime when it is missing or gone.
if [ -n "$ASKED_UDID" ]; then
  UDID=$ASKED_UDID
else
  UDID=$(cat "$SIM_FILE" 2>/dev/null || true)
  if [ -n "$UDID" ] && ! /usr/bin/xcrun simctl list -j devices available | /usr/bin/python3 -c '
import json, sys
sys.exit(0 if any(d["udid"] == sys.argv[1] for ds in json.load(sys.stdin)["devices"].values() for d in ds) else 1)' "$UDID"; then
    echo "remote-run: the test simulator $UDID is gone; making a new one"
    UDID=""
  fi
  if [ -z "$UDID" ]; then
    read -r RUNTIME DEVTYPE < <(/usr/bin/xcrun simctl list -j runtimes available | /usr/bin/python3 -c '
import json, re, sys
rts = [r for r in json.load(sys.stdin)["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
rts.sort(key=lambda r: tuple(int(x) for x in r["version"].split(".")))
if not rts: sys.exit(1)
rt = rts[-1]
# The device TYPE for simctl create: the newest plain iPhone ("iPhone 17" before "iPhone 17 Pro").
def rank(t):
    m = re.match(r"iPhone (\d+)( Pro)?$", t["name"])
    return (int(m.group(1)), 0 if m.group(2) else 1) if m else (-1, 0)
types = sorted((t for t in rt.get("supportedDeviceTypes", []) if t.get("productFamily") == "iPhone"), key=rank)
print(rt["identifier"], (types or rt["supportedDeviceTypes"])[-1]["identifier"])') \
      || refuse 69 "no iOS simulator runtime on this Mac (Xcode > Settings > Components)" missing
    UDID=$(/usr/bin/xcrun simctl create "$SIM_NAME" "$DEVTYPE" "$RUNTIME") || refuse 69 "could not create the test simulator" missing
    printf '%s\n' "$UDID" > "$SIM_FILE"
    echo "remote-run: made the test simulator $UDID ($DEVTYPE, $RUNTIME)"
  fi
fi
walnut_sim_check "$UDID" || refuse 64 "the simulator $UDID may not be used here (see above)" failed
UDID=$WALNUT_SIM_DEVICE
RUNTIME_NAME=$(/usr/bin/xcrun simctl list -j devices | /usr/bin/python3 -c '
import json, sys
for rt, devs in json.load(sys.stdin)["devices"].items():
    if any(d["udid"] == sys.argv[1] for d in devs):
        print(rt.rsplit(".", 1)[-1].replace("iOS-", "iOS ", 1).replace("-", ".")); break' "$UDID" 2>/dev/null)
echo "remote-run: simulator $UDID (${RUNTIME_NAME:-runtime unknown}, Xcode ${XCODE:-unknown}); load $LOAD1 on $CPUS CPUs"
# A boot that works is this run's to undo; one that fails found it running already (or
# broken, which bootstatus says next).
if /usr/bin/xcrun simctl boot "$UDID" >/dev/null 2>&1; then
  STARTED=$UDID; echo "$$ $UDID" > "$LOCK_DIR/started"
fi
/usr/bin/xcrun simctl bootstatus "$UDID" -b >/dev/null || refuse 1 "the simulator $UDID did not boot" failed

cd "$RUN_DIR/src/ios-native" || refuse 1 "no ios-native in the sent sources" failed
xcodegen generate --quiet || refuse 1 "xcodegen generate failed" failed

if [ "$VIDEO" = 1 ]; then
  /usr/bin/xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/run.mp4" >/dev/null 2>&1 &
  REC_PID=$!
fi

export WALNUT_SIM_UDID=$UDID
POLITE=(nice -n 10 /usr/sbin/taskpolicy -c utility)
JOBS=$(( CPUS > 3 ? CPUS / 2 : 1 ))
XCB=(-project Walnut.xcodeproj -scheme Walnut -destination "platform=iOS Simulator,id=$UDID"
     -derivedDataPath "$DERIVED" -jobs "$JOBS")
# In the background with a wait, so a stop's SIGTERM runs the trap at once (bash defers it
# until a foreground child exits).
[ "$MODE" != run ] || [ $# -gt 0 ] || refuse 64 "run needs a command after --" failed
case $MODE in
  unit) "${POLITE[@]}" xcodebuild test "${XCB[@]}" -resultBundlePath "$OUT/Test.xcresult" -only-testing:WalnutTests "$@" & ;;
  build) "${POLITE[@]}" xcodebuild build-for-testing "${XCB[@]}" "$@" & ;;
  ui) WALNUT_UITEST_DD="$DERIVED" WALNUT_UITEST_RESULT_BUNDLE="$OUT/Test.xcresult" "${POLITE[@]}" bash tests/ui/run-ui-tests.sh "$@" & ;;
  run) "${POLITE[@]}" "$@" & ;;
  *) refuse 64 "unknown mode $MODE (unit, ui, build, run)" failed ;;
esac
wait $!
STATUS=$?

if [ -n "$REC_PID" ]; then kill -INT "$REC_PID" 2>/dev/null; wait "$REC_PID" 2>/dev/null; REC_PID=""; fi
if [ -d "$OUT/Test.xcresult" ]; then
  /usr/bin/xcrun xcresulttool get test-results summary --path "$OUT/Test.xcresult" --compact > "$OUT/summary.json" 2>/dev/null || true
  /usr/bin/xcrun xcresulttool export attachments --path "$OUT/Test.xcresult" --output-path "$OUT/attachments" >/dev/null 2>&1 || true
  [ "$KEEP_XCRESULT" = 1 ] || rm -rf "$OUT/Test.xcresult"
fi
tar -czf "$RUN_DIR/out.tgz" -C "$RUN_DIR" out
rm -rf "$RUN_DIR/src" "$RUN_DIR/src.tgz"
result "$STATUS" "$([ "$STATUS" = 0 ] && echo passed || echo failed)"
exit "$STATUS"
