# shellcheck shell=bash
# What remote-run.sh asks of the Mac it runs on before it takes anything there, kept apart so a
# test can run it off a Mac. Source it; it only defines functions.

# fleet_call_apps: reads `pmset -g assertions` on stdin and prints the apps holding a call, comma
# separated (nothing when none). A call app keeps the display awake for as long as a call runs,
# which macOS lists as a power assertion; any process may hold a WebRTC call (a browser, a chat
# app's huddle), matched by the assertion's name. Walnut's call detection uses the same rule
# (src/core/time-tracking/calls.ts, isCallAssertion): keep the two in step.
FLEET_CALL_APPS='zoom.us|microsoft teams|msteams|teams|webex|cisco webex meetings|webexmta|facetime'
fleet_call_apps() {
  awk -v apps="$FLEET_CALL_APPS" '
    BEGIN { n = split(apps, a, "|"); for (i = 1; i <= n; i++) callapp[a[i]] = 1 }
    /^[ \t]*pid [0-9]+\(/ {
      s = $0; s = substr(s, index(s, "(") + 1)
      j = index(s, "): ["); if (!j) next
      app = substr(s, 1, j - 1); s = substr(s, j + 4)
      k = index(s, "] "); if (!k) next
      s = substr(s, k + 2)
      if (s !~ /^[0-9]+:[0-9][0-9]:[0-9][0-9] [^ ]+ named: "/) next
      split(s, f, " "); split(f[1], t, ":"); type = f[2]
      age = (t[1] * 60 + t[2]) * 60 + t[3]
      name = tolower(substr(s, index(s, "named: \"") + 8)); sub(/"[ \t]*$/, "", name)
      if (name ~ /update|download|install|backup|sync|video wake lock|playing (audio|video)/) next
      if (age > 12 * 3600) next   # a stuck assertion, not a call
      disp = (type == "NoDisplaySleepAssertion" || type == "PreventUserIdleDisplaySleep")
      if (tolower(app) in callapp) ok = disp
      else ok = (disp || type == "PreventUserIdleSystemSleep" || type == "NoIdleSleepAssertion") && name ~ /webrtc|peerconnection/
      if (ok && !(app in seen)) { seen[app] = 1; out = out (out == "" ? "" : ", ") app }
    }
    END { if (out != "") print out }'
}

# fleet_call_now: the apps holding a call on this Mac now. A pmset that has not answered in 5 s
# is stopped and counts as no call (the load check before it covers a busy Mac). FLEET_PMSET
# names another pmset (tests).
fleet_call_now() {
  local f pid k
  f=$(mktemp "${TMPDIR:-/tmp}/fleet-pmset.XXXXXX") || return 0
  "${FLEET_PMSET:-/usr/bin/pmset}" -g assertions >"$f" 2>/dev/null </dev/null & pid=$!
  # Its own output goes nowhere: a sleep holding the caller's $(...) pipe would hold the answer.
  ( sleep 5; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 </dev/null & k=$!
  wait "$pid" 2>/dev/null; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null
  fleet_call_apps < "$f"; rm -f "$f"
}

# fleet_lent_lane <file>: a Mac owner who runs a simulator queue (the protocol in
# scripts/lib/sim-device.sh) lends fleet runs one of its test lanes, instead of each run making a
# simulator of its own there, with two lines in that file (remote-run.sh reads
# ~/.config/walnut/fleet.env):
#   WALNUT_FLEET_SIM_QUEUE_SCRIPT=/absolute/path/to/the/queue/script
#   WALNUT_FLEET_SIM_LANE=<a test lane, never a>
# (read as text, never run: an `export ` in front and quotes around the value are allowed).
# Sets FLEET_LENT_QUEUE and FLEET_LENT_LANE (both empty: nothing lent, or no file). Returns 1 with
# FLEET_LENT_ERROR set when the file names only one of them, or one that cannot be used.
fleet_env_value() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$2=//p" "$1" | tail -n 1 \
    | sed -E 's/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
fleet_lent_lane() {
  FLEET_LENT_QUEUE=""; FLEET_LENT_LANE=""; FLEET_LENT_ERROR=""
  [ -f "$1" ] || return 0
  FLEET_LENT_QUEUE=$(fleet_env_value "$1" WALNUT_FLEET_SIM_QUEUE_SCRIPT)
  FLEET_LENT_LANE=$(fleet_env_value "$1" WALNUT_FLEET_SIM_LANE)
  [ -n "$FLEET_LENT_QUEUE$FLEET_LENT_LANE" ] || return 0
  if [ -z "$FLEET_LENT_QUEUE" ] || [ -z "$FLEET_LENT_LANE" ]; then
    FLEET_LENT_ERROR="$1 names only one of WALNUT_FLEET_SIM_QUEUE_SCRIPT and WALNUT_FLEET_SIM_LANE"
  elif [ ! -f "$FLEET_LENT_QUEUE" ]; then
    FLEET_LENT_ERROR="$1: WALNUT_FLEET_SIM_QUEUE_SCRIPT is not a file: $FLEET_LENT_QUEUE"
  elif ! [[ "$FLEET_LENT_LANE" =~ ^[A-Za-z0-9]+$ ]] || [ "$FLEET_LENT_LANE" = a ]; then
    FLEET_LENT_ERROR="$1: WALNUT_FLEET_SIM_LANE must name a test lane, not a (the owner's own): $FLEET_LENT_LANE"
  else
    return 0
  fi
  FLEET_LENT_QUEUE=""; FLEET_LENT_LANE=""
  return 1
}

# fleet_take_lent <run name> <lock dir>: take the lent lane's simulator through the queue
# (sim-device.sh must be sourced), leased to this shell ($$). The lease is named in
# <lock dir>/lease ("<pid>\n<queue script>\n<lane>") BEFORE the queue is asked, so watchdog.py
# gives it back even when the run is killed while the queue boots the simulator (a release by a
# pid that holds nothing is a no-op). The queue's words go to stderr. Returns:
#   0  WALNUT_SIM_DEVICE holds it until fleet_give_back;
#   1  the queue lends nothing now (someone holds the lane or is next, or the Mac must wait);
#   2  anything else (the queue failed, booted another lane, a protected device): a setup fault.
# walnut_sim_resolve sets its own EXIT trap: the caller sets its own again afterwards, either way.
fleet_take_lent() {
  local err rc=0
  WALNUT_SIM_QUEUE_SCRIPT=$FLEET_LENT_QUEUE; SIM_LANE=$FLEET_LENT_LANE
  WALNUT_SIM_QUEUE_NAME="fleet-$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-')"
  printf '%s\n%s\n%s\n' "$$" "$FLEET_LENT_QUEUE" "$FLEET_LENT_LANE" > "$2/lease"
  err=$(mktemp "${TMPDIR:-/tmp}/fleet-lease.XXXXXX") || err=/dev/null
  walnut_sim_resolve 2>"$err" || rc=$?
  [ "$err" = /dev/null ] || { cat "$err" >&2; }
  if [ "$rc" != 0 ]; then
    rm -f "$2/lease"
    if grep -qE 'The queue said: .*(BUSY|QUEUED|WAIT)' "$err" 2>/dev/null; then rc=1; else rc=2; fi
  fi
  [ "$err" = /dev/null ] || rm -f "$err"
  return "$rc"
}
# fleet_give_back <lock dir>: give the lent simulator back and forget the lease. Idempotent.
fleet_give_back() { walnut_sim_release; rm -f "$1/lease"; }
