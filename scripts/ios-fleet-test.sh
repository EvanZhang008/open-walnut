#!/usr/bin/env bash
# Build and test the iOS app on a Mac of the fleet, from a task on any host (a Linux
# devbox included), the way a Linux test runs anywhere. Walnut does the moving:
#
#   1. pick a Mac: host_list's hosts tagged `ios` that are connected, least loaded first
#      (host_load), skipping any over --max-load per CPU; or the one --host names;
#   2. send this checkout's iOS sources (tracked and untracked, not ignored) with
#      host_copy into this task's directory on that Mac;
#   3. run ios-native/tests/fleet/remote-run.sh there through host_exec, in the
#      background, printing its output as it comes;
#   4. bring out.tgz back with host_copy into $WALNUT_TASK_DIR/ios-fleet/<run>/ and
#      unpack it: summary.json (xcresulttool's summary), attachments/ (screenshots the
#      tests attached), run.mp4 (with --video), and Test.xcresult (with --keep-xcresult).
#
# Usage:
#   scripts/ios-fleet-test.sh [options] unit [-- XCODEBUILD ARGS]     # WalnutTests
#   scripts/ios-fleet-test.sh [options] ui [-- RUN-UI-TESTS ARGS]     # WalnutUITests (paired runner)
#   scripts/ios-fleet-test.sh [options] build [-- XCODEBUILD ARGS]    # build-for-testing only
#   scripts/ios-fleet-test.sh [options] run -- COMMAND...             # any command in ios-native,
#                                                                     # with WALNUT_SIM_UDID set
# Options:
#   --host H         a host alias or selector (default: pick among the `ios` Macs)
#   --video          record the simulator's screen while the tests run (run.mp4)
#   --keep-xcresult  bring the whole result bundle back too (it can be large)
#   --max-load N     refuse a Mac whose load per CPU is over N (default 0.75)
#   --udid U         drive that simulator on the Mac instead of the run's own one
#   --clean          remove this task's build products on that Mac afterwards
#   --verbose        print the whole run log (default: the lines that matter; all of it
#                    is in run.log)
#
# The first use for a task on a Mac asks the user to allow it (host_exec's grant):
# the script stops with the grant's message; run it again once they have.
# The Mac may be someone else's computer: see remote-run.sh for how a run stays out of
# their way (no window, its own simulator, utility priority, refuses when busy).
set -uo pipefail

die() { printf 'ios-fleet: %s\n' "$*" >&2; exit "${2:-1}"; }
say() { printf 'ios-fleet: %s\n' "$*" >&2; }

HOST=""; MAX_LOAD=0.75; FLAGS=(); CLEAN=0; VERBOSE=0
KEY_LINES='^(remote-run:|FLEET_RESULT|\*\* (BUILD|TEST)|Test Case .* failed|.*: error: )'
while [ $# -gt 0 ]; do
  case $1 in
    --host) HOST=$2; shift ;;
    --video|--keep-xcresult) FLAGS+=("$1") ;;
    --udid) FLAGS+=(--udid "$2"); shift ;;
    --max-load) MAX_LOAD=$2; shift ;;
    --clean) CLEAN=1 ;;
    --verbose) VERBOSE=1 ;;
    unit|ui|build|run) break ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" 64 ;;
  esac
  shift
done
MODE=${1:-}; [ -n "$MODE" ] || die "say what to run: unit, ui, build or run (see --help)" 64
shift
[ "${1:-}" = "--" ] && shift
ARGS=("$@")
[ "$MODE" != run ] || [ ${#ARGS[@]} -gt 0 ] || die "run needs a command after --" 64

command -v walnut >/dev/null || die "the walnut command is not on PATH (this runs from a Walnut task session)"
[ -n "${WALNUT_TASK_DIR:-}" ] || die "WALNUT_TASK_DIR is not set (this runs from a Walnut task session)"
TASK_ID=$(basename "$WALNUT_TASK_DIR")
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "run it inside the Walnut checkout"
[ -d "$ROOT/ios-native" ] || die "no ios-native in $ROOT"

RUN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCAL="$WALNUT_TASK_DIR/ios-fleet/$RUN"
mkdir -p "$LOCAL"
REMOTE_REL=".local/state/open-walnut/tasks/$TASK_ID/ios-fleet/$RUN"

# One op call; the JSON answer on stdout. A refusal (non-zero exit) is shown as it came.
op() { # $1 = op, $2 = JSON args
  local f="$LOCAL/.op-args.json" out
  printf '%s' "$2" > "$f"
  out=$(walnut tools call "$1" "@$f" 2>&1 </dev/null) || { printf '%s\n' "$out" >&2; return 1; }
  printf '%s' "$out"
}
js() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
# host_copy, waited for: a big file answers running:true first, host_copy_result waits on.
copy() { # $1 = JSON args; prints the finished answer
  local got id
  got=$(op host_copy "$1") || return 1
  while printf '%s' "$got" | js 'sys.exit(0 if d.get("running") else 1)'; do
    id=$(printf '%s' "$got" | js 'print(d.get("copyId") or "")')
    [ -n "$id" ] || { printf '%s\n' "$got" >&2; return 1; }
    got=$(op host_copy_result "{\"copy_id\":\"$id\",\"wait_ms\":60000}") || return 1
  done
  printf '%s' "$got"
}

# The Macs to try, best first: connected, tagged ios, under the load cap.
candidates() {
  local hosts loads
  hosts=$(op host_list '{}') || return 1
  loads=$(op host_load '{}') || loads='{"hosts":[]}'
  # A host whose load did not come back in time is asked once more.
  if printf '%s' "$loads" | js 'sys.exit(0 if any(not h.get("known") for h in d["hosts"]) else 1)'; then
    sleep 2; loads=$(op host_load '{}') || loads='{"hosts":[]}'
  fi
  python3 - "$MAX_LOAD" "$hosts" "$loads" <<'PY'
import json, sys
cap = float(sys.argv[1]); hosts = json.loads(sys.argv[2])["hosts"]; loads = {h["host"]: h for h in json.loads(sys.argv[3])["hosts"]}
rows = []
for h in hosts:
    if "ios" not in ((h.get("capabilities") or {}).get("tags") or []) or not (h.get("connection") or {}).get("connected"):
        continue
    l = loads.get(h["host"], {})
    per = l.get("loadPerCpu")
    note = f"{h['label']} ({h['host']}): " + (f"load {per} per CPU" if per is not None else "load unknown")
    if per is None or per > cap:
        print("SKIP\t" + note + (f", over {cap}" if per is not None else ""), file=sys.stderr); continue
    rows.append((per, h["host"], note))
for per, host, note in sorted(rows):
    print(host + "\t" + note)
PY
}

if [ -n "$HOST" ] && [ "${HOST#@}" = "$HOST" ]; then
  PICKS=$(printf '%s\tnamed with --host\n' "$HOST")
else
  [ -z "$HOST" ] || [ "$HOST" = "@ios" ] || die "only @ios is a selector this script picks from; name a host instead" 64
  PICKS=$(candidates 2> >(sed 's/^SKIP\t/ios-fleet: not using /' >&2)) || die "could not read the fleet"
  [ -n "$PICKS" ] || die "no iOS Mac can take a run now (each is busy, offline, or has no simulator runtime); try again later or pass --max-load" 75
fi

# The sources: what git tracks plus new files not ignored, under ios-native, the shared
# script helpers the iOS scripts source, and every repo path the iOS sources name as a
# literal ("tests/fixtures/ask-list", "src/core/types.ts": tests read them through
# #filePath), so a test that starts reading another file takes it along by itself.
repo_refs() {
  grep -rhoE --include='*.swift' '"(src|web|tests|docs|scripts|packages|desktop|examples)/[A-Za-z0-9_./-]+"' "$ROOT/ios-native" \
    | tr -d '"' | sed 's:/*$::' | sort -u | while read -r p; do [ -e "$ROOT/$p" ] && printf '%s\n' "$p"; done
}
REFS=()
while IFS= read -r p; do REFS+=("$p"); done < <(repo_refs)
( cd "$ROOT" && git ls-files -co --exclude-standard -z -- ios-native scripts/lib ${REFS[@]+"${REFS[@]}"} | tar --null -T - -czf "$LOCAL/src.tgz" ) \
  || die "could not pack the sources"
say "packed $(du -h "$LOCAL/src.tgz" | cut -f1) of sources ($(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" status --porcelain -- ios-native | grep -q . && echo ', with uncommitted changes'))"

q() { printf '%q ' "$@"; }
STATUS=1
while IFS=$'\t' read -r H NOTE; do
  [ -n "$H" ] || continue
  say "using $NOTE"
  REMOTE="~/$REMOTE_REL"
  sent=$(copy "$(python3 -c 'import json,sys; print(json.dumps({"from": sys.argv[1], "to_host": sys.argv[2], "to": sys.argv[3]}))' "$LOCAL/src.tgz" "$H" "$REMOTE/src.tgz")") \
    || die "could not send the sources to $H"
  say "$(printf '%s' "$sent" | js 'print(d.get("outcome") or "sent")')"
  SCRIPT="D=\"\$HOME/$REMOTE_REL\"; mkdir -p \"\$D/src\" && tar -xzf \"\$D/src.tgz\" -C \"\$D/src\" && exec /bin/bash \"\$D/src/ios-native/tests/fleet/remote-run.sh\" \"\$D\" $(q "$MODE" ${FLAGS[@]+"${FLAGS[@]}"} --max-load "$MAX_LOAD" -- ${ARGS[@]+"${ARGS[@]}"})"
  started=$(op host_exec "$(python3 -c 'import json,sys; print(json.dumps({"host": sys.argv[1], "argv": ["/bin/bash", "-c", sys.argv[2]], "background": True, "timeout_ms": 7200000}))' "$H" "$SCRIPT")") \
    || die "could not start the run on $H"
  JOB=$(printf '%s' "$started" | js 'print(d.get("jobId") or "")')
  [ -n "$JOB" ] || die "host_exec gave no job id: $started"
  say "running on $H as job $JOB (host_exec_stop stops it)"
  # Ctrl-C or a stop here stops the run there too.
  trap 'op host_exec_stop "{\"host\":\"$H\",\"job_id\":\"$JOB\"}" >/dev/null 2>&1; say "stopped job $JOB on $H"; exit 130' INT TERM HUP
  OFF=0; FAILS=0; LOG="$LOCAL/run.log"; : > "$LOG"
  # Every byte of the log, to its end after the run stops: the result line is the last one.
  # The terminal gets the lines that matter (a test run prints megabytes of app logs);
  # --verbose prints everything. The whole log is run.log either way.
  while :; do
    if ! got=$(op host_exec_read "{\"host\":\"$H\",\"job_id\":\"$JOB\",\"offset\":$OFF,\"wait_ms\":15000}"); then
      # Walnut or the Mac out of reach for a while: the run goes on there; say how to read it.
      FAILS=$((FAILS + 1))
      [ "$FAILS" -lt 60 ] || die "lost $H for 5 minutes; job $JOB may still run there: host_exec_read {\"host\":\"$H\",\"job_id\":\"$JOB\"}"
      sleep 5; continue
    fi
    FAILS=0
    printf '%s' "$got" | js 'sys.stdout.write(d.get("output") or "")' >> "$LOG.part"
    if [ "$VERBOSE" = 1 ]; then cat "$LOG.part"; else grep -E "$KEY_LINES" "$LOG.part" || true; fi
    cat "$LOG.part" >> "$LOG"; rm -f "$LOG.part"
    OFF=$(printf '%s' "$got" | js 'print(d.get("nextOffset", 0))')
    printf '%s' "$got" | js 'sys.exit(0 if d.get("running") or d.get("nextOffset", 0) < d.get("outputBytes", 0) else 1)' || break
  done
  trap - INT TERM HUP
  RES=$(grep '^FLEET_RESULT ' "$LOG" | tail -1 | cut -d' ' -f2-)
  [ -n "$RES" ] || die "the run on $H ended without a result line; its log: $LOG"
  STATUS=$(printf '%s' "$RES" | js 'print(d["exit"])')
  STATE=$(printf '%s' "$RES" | js 'print(d["state"])')
  if [ "$STATE" = busy ] && [ -z "$HOST" ]; then say "$H is busy; trying the next Mac"; continue; fi
  if [ "$(printf '%s' "$RES" | js 'print(d.get("bytes", 0))')" != 0 ]; then
    copy "$(python3 -c 'import json,sys; print(json.dumps({"from_host": sys.argv[1], "from": sys.argv[2], "to": sys.argv[3]}))' "$H" "$REMOTE/out.tgz" "$LOCAL/out.tgz")" >/dev/null \
      && tar -xzf "$LOCAL/out.tgz" -C "$LOCAL" || say "could not bring the results back from $H"
  fi
  CLEANUP="rm -rf \"\$HOME/$REMOTE_REL\""
  [ "$CLEAN" = 1 ] && CLEANUP="$CLEANUP \"\$HOME/.local/state/open-walnut/tasks/$TASK_ID/ios-fleet/DerivedData\""
  op host_exec "$(python3 -c 'import json,sys; print(json.dumps({"host": sys.argv[1], "argv": ["/bin/bash", "-c", sys.argv[2]], "timeout_ms": 60000}))' "$H" "$CLEANUP")" >/dev/null || true
  break
done <<< "$PICKS"

rm -f "$LOCAL/src.tgz" "$LOCAL/.op-args.json"
if [ -f "$LOCAL/out/summary.json" ]; then
  python3 - "$LOCAL/out/summary.json" <<'PY' >&2
import json, sys
s = json.load(open(sys.argv[1]))
print("ios-fleet: %s: %s passed, %s failed, %s skipped of %s" % (s.get("result"), s.get("passedTests"), s.get("failedTests"), s.get("skippedTests"), s.get("totalTestCount")))
for f in (s.get("testFailures") or [])[:10]:
    print("  FAIL %s: %s" % (f.get("testIdentifierString") or f.get("testName"), (f.get("failureText") or "")[:200]))
PY
fi
say "results: $LOCAL$([ -f "$LOCAL/out/run.mp4" ] && echo " (video: $LOCAL/out/run.mp4)")"
exit "$STATUS"
