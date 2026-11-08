# Sourced by run-ui-tests.sh: before EVERY xcodebuild on a test lane's simulator, wait for a calm
# machine, the way the simulator queue's sim-maestro.sh does before each round. A lease covers a
# whole session of runs, and the queue's gate only judged its start: on 2026-11-07 the XCUITest runs
# of one held lane were 22.7% of the runnable threads in the Mac's over-limit samples (mean load 88
# with that lane up against 53 without).
#
# The gate is the machine's own script (it prints CALM ... or WAIT <why>, exit 0 or 1), found as
#   WALNUT_MACHINE_GATE, else machine-gate.sh beside WALNUT_SIM_QUEUE_SCRIPT,
# either of which ~/.config/walnut/machine-gate.env may set (KEY=value lines). It applies when the
# simulator is a test lane's: SIM_LANE=b, or the UDID is WALNUT_MACHINE_GATE_UDID. No gate script:
# nothing waits (a machine without a simulator queue).
# Knobs: WALNUT_UITEST_GATE_WAIT (seconds, default 600), WALNUT_UITEST_GATE_POLL (default 30).
# A wait that runs out exits the run with 6, as sim-maestro.sh does: give the lease back and queue again.

uitest_gate_env() { # $1 = key: its value from the env, else ~/.config/walnut/machine-gate.env
  local v=${!1:-} f=${WALNUT_MACHINE_GATE_ENV:-$HOME/.config/walnut/machine-gate.env}
  if [ -z "$v" ] && [ -f "$f" ]; then v=$(sed -n "s/^$1=//p" "$f" | tail -1); fi
  printf '%s' "$v"
}

# uitest_machine_gate <udid> <what>: returns once the machine is calm; exits 6 after the wait.
uitest_machine_gate() {
  local udid=$1 what=$2 gate lane_udid out end said=
  gate=$(uitest_gate_env WALNUT_MACHINE_GATE)
  if [ -z "$gate" ]; then
    local q; q=$(uitest_gate_env WALNUT_SIM_QUEUE_SCRIPT)
    [ -z "$q" ] || gate="$(dirname "$q")/machine-gate.sh"
  fi
  [ -n "$gate" ] && [ -f "$gate" ] || return 0
  lane_udid=$(uitest_gate_env WALNUT_MACHINE_GATE_UDID)
  if [ "${SIM_LANE:-}" != b ] && { [ -z "$lane_udid" ] || [ "$(printf '%s' "$udid" | tr a-f A-F)" != "$(printf '%s' "$lane_udid" | tr a-f A-F)" ]; }; then
    return 0
  fi
  end=$(( $(date +%s) + ${WALNUT_UITEST_GATE_WAIT:-600} ))
  while ! out=$(bash "$gate" --exclude "$udid" 2>&1); do
    if [ "$(date +%s)" -ge "$end" ]; then
      printf '\n!! %s\n' "the machine stayed busy for ${WALNUT_UITEST_GATE_WAIT:-600}s before $what (${out#WAIT }); give the simulator back and queue again" >&2
      exit 6
    fi
    [ -n "$said" ] || { printf '==> waiting for a calm machine before %s: %s\n' "$what" "${out#WAIT }"; said=1; }
    sleep "${WALNUT_UITEST_GATE_POLL:-30}"
  done
  [ -z "$said" ] || printf '==> %s goes on: %s\n' "$what" "$out"
  return 0
}
