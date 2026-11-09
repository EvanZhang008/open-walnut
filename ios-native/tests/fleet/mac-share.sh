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

# fleet_deploy_now: the commit a Walnut production deploy is building on this Mac now, from the
# deploy queue's own record (scripts/lib/deploy-queue.sh: `current`, written while its runner, whose
# pid is in runner.lock/pid, deploys), else nothing. A record its runner left behind is no deploy.
# 2026-11-09: a deploy build, a fleet build with its simulator and a test run together took this
# Mac to a load of 411, and every message to a session waited on the server's queue lock.
# WALNUT_DEPLOY_QUEUE_DIR names another queue (tests, a rehearsal).
fleet_deploy_now() {
  local q=${WALNUT_DEPLOY_QUEUE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/open-walnut/deploy-queue} c p
  [ -f "$q/current" ] || return 0
  p=$(cat "$q/runner.lock/pid" 2>/dev/null) || return 0
  case $p in ''|*[!0-9]*|0|1) return 0 ;; esac
  kill -0 "$p" 2>/dev/null || return 0
  # A pid the system gave to another process since (a runner that was killed) is no deploy.
  case $(ps -o command= -p "$p" 2>/dev/null) in *deploy-committed*) ;; *) return 0 ;; esac
  c=$(awk 'NR == 1 { print substr($1, 1, 12) }' "$q/current" 2>/dev/null)
  echo "${c:-a commit}"
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

# fleet_idle_pct: the share of this Mac's CPU idle over 5 seconds (iostat), nothing when unreadable.
fleet_idle_pct() {
  /usr/sbin/iostat -n 0 -c 2 -w "${1:-5}" 2>/dev/null | awk 'END { if ($3 ~ /^[0-9.]+$/) print $3 }'
}

# fleet_mem: "<pressure level> <swap used MB> <swap total MB> <compressor MB>", nothing when the
# pressure level cannot be read.
fleet_mem() {
  local pl sw comp
  pl=$(/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)
  case $pl in ''|*[!0-9]*) return 0 ;; esac
  sw=$(/usr/sbin/sysctl -n vm.swapusage 2>/dev/null | awk '{ gsub(/M/, ""); printf "%d %d", $6, $3 }')
  comp=$(/usr/bin/vm_stat 2>/dev/null | awk '/page size of/ { for (i = 1; i <= NF; i++) if ($i == "of") ps = $(i + 1) }
    /occupied by compressor/ { v = $NF; sub(/\./, "", v); c = v } END { printf "%d", c * ps / 1048576 }')
  printf '%s %s %s\n' "$pl" "${sw:-0 0}" "${comp:-0}"
}

# fleet_cpu_busy IDLE LOAD1 CPUS MIN_IDLE MAX_LOAD [MEM]: prints why the Mac is too busy for a run,
# nothing when it has room. The rule of lane B's machine-gate.sh (2026-11-08, the Operations VP: free
# CPU is only an extra condition, never a replacement for the load line; at a backstop of 4 per CPU a
# lease booted at load 48 and the load went to 377): the load at most MAX_LOAD per CPU (2, 28 on 14
# cores) first, then memory not tight (MEM, fleet_mem's reading: pressure level warn or worse, the
# compressor at 14 GB, or swap 80% full with the compressor at 10 GB), then MIN_IDLE percent of the
# CPU idle. An idle share or a memory reading that could not be read (empty) does not block.
fleet_cpu_busy() {
  awk -v i="$1" -v l="$2" -v c="$3" -v mi="$4" -v ml="$5" -v m="${6:-}" 'BEGIN {
    if (c < 1) c = 1
    if (l / c > ml) { printf "load %s on %d CPUs is over %s per CPU\n", l, c, ml; exit }
    if (split(m, x, " ") == 4 && (x[1] >= 2 || x[4] >= 14336 || (x[3] > 0 && x[2] * 100 >= 80 * x[3] && x[4] >= 10240))) {
      printf "memory is tight (pressure level %d, swap %d/%dMB, compressor %dMB)\n", x[1], x[2], x[3], x[4]; exit }
    if (i != "" && i + 0 < mi + 0) printf "only %d%% of the CPU is idle (%.1f of %d cores), under %s%%\n", i, i * c / 100, c, mi
  }'
}
