# shellcheck shell=bash
# Which iOS simulator a script may drive. Source it, then call walnut_sim_resolve.
#
# A test run installs its own build on the simulator it drives, so picking a device
# for the user replaces whatever was there: a simulator someone uses every day, or
# one another run is in the middle of. A script therefore never picks a device by its
# model name and never takes "whichever simulator is booted". It drives:
#
#   1. the simulator it was told to use: the caller's own argument or variable
#      (passed as $1), else WALNUT_SIM_UDID;
#   2. else one lent by the machine's simulator queue, when WALNUT_SIM_QUEUE_SCRIPT
#      names one and SIM_LANE names a test lane (protocol below);
#   3. else none: it refuses and says how to name one.
#
# Every answer must be a simulator UDID (`xcrun simctl list devices`); it is used
# upper-cased. A name or the word "booted" is refused, since either can land on
# someone else's simulator. WALNUT_SIM_PROTECTED_UDIDS (space separated) lists
# simulators no script may drive even when told to, for a machine owner who keeps
# one simulator for themselves.
#
# Queue protocol. The queue script belongs to the machine, not to this repo. Each
# lane is one simulator; lane a is the machine owner's own and is never lent:
#   SIM_LANE=<lane> bash "$WALNUT_SIM_QUEUE_SCRIPT" acquire <name> --pid <pid>
#       does not wait. On success (exit 0) it prints, among other lines,
#         ACQUIRED lane <lane> for <name> (holder pid <pid>)
#         BOOTED lane <lane> simulator <UDID> (<n>s)
#       and the UDID is read from the BOOTED line only, which must name the lane
#       asked for. Anything else (BUSY, QUEUED, WAIT, ACQUIRE FAILED, a non-zero exit, a
#       lease with no BOOTED line or another lane's) is a refusal, shown to the user
#       as the queue wrote it; a lease already taken is given back first. A caller that wants to wait for its turn joins the queue
#       first (`join <name>`) and acquires once the queue says MAY.
#   SIM_LANE=<lane> bash "$WALNUT_SIM_QUEUE_SCRIPT" release --pid <pid>
#       gives the lease back.
# <name> is WALNUT_SIM_QUEUE_NAME, else the calling script's file name. <pid> is the
# calling script's own pid ($$, the same in a sourced function), so the queue can
# take back a lease whose holder died. A script that took a lease calls
# walnut_sim_release when it ends: walnut_sim_resolve installs it as the EXIT trap
# (and makes HUP, INT and TERM exit), so a script that sets its own EXIT trap
# afterwards must call walnut_sim_release from it. The lease's own lock is the
# queue's; a script holding one takes no second lock on the same lane.
#
# walnut_sim_check [explicit-udid] checks the same rules without taking a lease
# (for a script that must refuse before it waits for anything else).
#
# After a successful walnut_sim_resolve:
#   WALNUT_SIM_DEVICE   the UDID to drive, upper case
#   WALNUT_SIM_FROM     where it came from: argument | WALNUT_SIM_UDID | queue

WALNUT_SIM_DEVICE=""
WALNUT_SIM_FROM=""
WALNUT_SIM_LEASED=""
WALNUT_SIM_LANE=""
WALNUT_SIM_UDID_RE='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
WALNUT_SIM_BOOTED_RE='^BOOTED lane ([A-Za-z0-9]+) simulator ([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})( |$)'

walnut_sim_refuse() {
  printf '%s\n' "sim-device: $*" >&2
  printf '%s\n' "sim-device: name a simulator you may use: export WALNUT_SIM_UDID=<udid> (see: xcrun simctl list devices), or set WALNUT_SIM_QUEUE_SCRIPT to this machine's simulator queue with SIM_LANE set to a test lane." >&2
  return 2
}

walnut_sim_upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

walnut_sim_queue_name() {
  printf '%s' "${WALNUT_SIM_QUEUE_NAME:-$(basename "${BASH_SOURCE[${#BASH_SOURCE[@]}-1]:-$0}" .sh)}"
}

walnut_sim_release() {
  [ -n "$WALNUT_SIM_LEASED" ] || return 0
  WALNUT_SIM_LEASED=""
  SIM_LANE="$WALNUT_SIM_LANE" bash "$WALNUT_SIM_QUEUE_SCRIPT" release --pid "$$" >/dev/null 2>&1 || true
  return 0
}

# A UDID the rules allow: the shape of one, and not protected.
walnut_sim_allowed() {
  local udid="$1" from="$2" p
  if ! [[ "$udid" =~ $WALNUT_SIM_UDID_RE ]]; then
    walnut_sim_refuse "'$udid' (from $from) is not a simulator UDID."; return 2
  fi
  for p in ${WALNUT_SIM_PROTECTED_UDIDS:-}; do
    if [ "$(walnut_sim_upper "$p")" = "$(walnut_sim_upper "$udid")" ]; then
      walnut_sim_refuse "$udid is listed in WALNUT_SIM_PROTECTED_UDIDS; no script may drive it."; return 2
    fi
  done
  return 0
}

# Where the simulator would come from, without taking a lease. Sets WALNUT_SIM_FROM
# and, for an explicit one, WALNUT_SIM_DEVICE.
walnut_sim_check() {
  local explicit="${1:-}" udid=""
  WALNUT_SIM_DEVICE=""; WALNUT_SIM_FROM=""
  if [ -n "$explicit" ]; then
    udid="$explicit"; WALNUT_SIM_FROM="argument"
  elif [ -n "${WALNUT_SIM_UDID:-}" ]; then
    udid="$WALNUT_SIM_UDID"; WALNUT_SIM_FROM="WALNUT_SIM_UDID"
  elif [ -n "${WALNUT_SIM_QUEUE_SCRIPT:-}" ]; then
    [ -f "$WALNUT_SIM_QUEUE_SCRIPT" ] || { walnut_sim_refuse "WALNUT_SIM_QUEUE_SCRIPT is not a file: $WALNUT_SIM_QUEUE_SCRIPT"; return 2; }
    case "${SIM_LANE:-}" in
      "") walnut_sim_refuse "SIM_LANE is not set, and the queue's default lane a is the machine owner's own simulator. Set SIM_LANE to a test lane (b or c)."; return 2 ;;
      a) walnut_sim_refuse "SIM_LANE=a is the machine owner's own simulator; no script takes it from the queue. Set SIM_LANE to a test lane (b or c)."; return 2 ;;
      *[!A-Za-z0-9]*) walnut_sim_refuse "SIM_LANE='$SIM_LANE' is not a lane name."; return 2 ;;
    esac
    WALNUT_SIM_FROM="queue"; return 0
  else
    walnut_sim_refuse "no simulator named: this script never picks one by model name or by which one is booted."
    return 2
  fi
  walnut_sim_allowed "$udid" "$WALNUT_SIM_FROM" || { WALNUT_SIM_FROM=""; return 2; }
  WALNUT_SIM_DEVICE="$(walnut_sim_upper "$udid")"
  return 0
}

# walnut_sim_resolve [explicit-udid]
walnut_sim_resolve() {
  local out="" rc=0 line udid="" lane="" name hint=
  walnut_sim_check "${1:-}" || return 2
  [ "$WALNUT_SIM_FROM" = queue ] || return 0
  name="$(walnut_sim_queue_name)"
  WALNUT_SIM_LANE="$SIM_LANE"
  out="$(SIM_LANE="$WALNUT_SIM_LANE" bash "$WALNUT_SIM_QUEUE_SCRIPT" acquire "$name" --pid "$$" 2>&1)" || rc=$?
  if [ "$rc" != 0 ]; then
    WALNUT_SIM_FROM=""
    # Only a lane someone else holds or is next for is worth waiting for.
    case "$out" in
      *BUSY*|*QUEUED*|*WAIT*) hint=" To wait for a turn, join the queue first: SIM_LANE=$SIM_LANE bash $WALNUT_SIM_QUEUE_SCRIPT join $name" ;;
    esac
    walnut_sim_refuse "the simulator queue lent no simulator on lane $SIM_LANE for $name (exit $rc). The queue said: ${out:-nothing}.$hint"
    return 2
  fi
  # From here a lease is ours, whatever else goes wrong: give it back on exit.
  WALNUT_SIM_LEASED=1
  # A signal only exits; the EXIT trap gives the lease back (bash runs no EXIT
  # trap on a signal it does not trap).
  trap walnut_sim_release EXIT
  trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
  while IFS= read -r line; do
    if [[ "$line" =~ $WALNUT_SIM_BOOTED_RE ]]; then lane="${BASH_REMATCH[1]}"; udid="${BASH_REMATCH[2]}"; fi
  done <<EOF
$out
EOF
  if [ -z "$udid" ]; then
    walnut_sim_release; WALNUT_SIM_FROM=""
    walnut_sim_refuse "the simulator queue named no simulator (no 'BOOTED lane $SIM_LANE simulator <UDID>' line). The queue said: ${out:-nothing}"
    return 2
  fi
  if [ "$lane" != "$WALNUT_SIM_LANE" ]; then
    walnut_sim_release; WALNUT_SIM_FROM=""
    walnut_sim_refuse "the simulator queue booted lane $lane, not the requested lane $WALNUT_SIM_LANE. The queue said: $out"
    return 2
  fi
  if ! walnut_sim_allowed "$udid" queue; then walnut_sim_release; WALNUT_SIM_FROM=""; return 2; fi
  WALNUT_SIM_DEVICE="$(walnut_sim_upper "$udid")"
  # What the queue said (its MAESTRO line, say) is for the user, never for parsing.
  printf '%s\n' "$out" | sed 's/^/sim-queue: /' >&2
  return 0
}
