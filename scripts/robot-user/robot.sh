#!/usr/bin/env bash
# Robot user — soak-test entrypoint.
#
# Simulates a real user hammering the Walnut iOS app on ONE dedicated simulator for a while,
# checks invariants (oracles) after every action, and leaves a replayable journal behind.
#
#   robot.sh --device <udid> --minutes 30 [--seed 42] [--driver hybrid|ai] [--server http://localhost:3456]
#
# Exit: 0 = clean, 2 = anomalies found, 1 = setup/harness error.
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ID="dev.openwalnut.ios"

DEVICE=""
MINUTES="30"
SEED="42"
DRIVER="hybrid"
SERVER="http://localhost:3456"
EXTRA=()

usage() {
  cat <<EOF
Usage: robot.sh --device <udid> --minutes 30 [--seed 42] [--driver hybrid|ai] [--server http://localhost:3456]

Options:
  --device <udid>     simulator UDID to drive (required; must be a DEDICATED simulator)
  --minutes <n>       episode length in minutes (default 30)
  --seed <n>          PRNG seed — fully determines the action sequence (default 42)
  --driver <kind>     hybrid (weighted random, default) or ai (small model picks actions)
  --server <url>      Walnut server used by the offlineWhileHealthy oracle (default :3456)
  --steps <n>         stop after n steps instead of the time budget (debugging)
  --also-device-name <n>  extra name this device uploads client logs under (repeatable);
                          one simulator often logs under both its simctl name and the name
                          the build was paired with (e.g. sim-stress2)
  --no-judge          skip the screenshot judge (no model calls at all)
  -h, --help          this help

Env: MAESTRO_CLI (maestro CLI path), WALNUT_ROBOT_TOKEN (Bearer for /api/v1/status).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --device|-d) DEVICE="${2:-}"; shift 2 ;;
    --minutes) MINUTES="${2:-}"; shift 2 ;;
    --seed) SEED="${2:-}"; shift 2 ;;
    --driver) DRIVER="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --steps) EXTRA+=(--steps "${2:-}"); shift 2 ;;
    --also-device-name) EXTRA+=(--also-device-name "${2:-}"); shift 2 ;;
    --no-judge) EXTRA+=(--no-judge); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

[ -n "$DEVICE" ] || { usage >&2; die "--device <udid> is required"; }
case "$DRIVER" in hybrid|ai) ;; *) die "--driver must be hybrid or ai (got '$DRIVER')" ;; esac

# ── prerequisites ────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v jq   >/dev/null 2>&1 || die "jq not found on PATH (brew install jq)"
command -v xcrun >/dev/null 2>&1 || die "xcrun not found — Xcode command line tools required"

MAESTRO="${MAESTRO_CLI:-$HOME/.claude/skills/maestro-as-cli/scripts/maestro}"
[ -x "$MAESTRO" ] || die "maestro CLI not executable at $MAESTRO (set MAESTRO_CLI)"

# ── device must exist, and be booted (boot it if it is shut down) ─────────────
DEVICE_JSON="$(xcrun simctl list devices -j 2>/dev/null)" || die "xcrun simctl list failed"
DEVICE_INFO="$(printf '%s' "$DEVICE_JSON" | jq -r --arg u "$DEVICE" '
  [.devices[][] | select((.udid | ascii_downcase) == ($u | ascii_downcase))] | .[0]
  | if . == null then "" else .name + "\t" + .state end')"
[ -n "$DEVICE_INFO" ] || die "simulator $DEVICE not found in 'xcrun simctl list devices'"

DEVICE_NAME="${DEVICE_INFO%%$'\t'*}"
DEVICE_STATE="${DEVICE_INFO##*$'\t'}"
echo "device: $DEVICE_NAME ($DEVICE) state=$DEVICE_STATE"

if [ "$DEVICE_STATE" != "Booted" ]; then
  echo "booting $DEVICE_NAME ..."
  xcrun simctl boot "$DEVICE" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    sleep 2
    st="$(xcrun simctl list devices -j | jq -r --arg u "$DEVICE" '[.devices[][] | select((.udid|ascii_downcase)==($u|ascii_downcase))] | .[0].state // ""')"
    [ "$st" = "Booted" ] && break
  done
  st="$(xcrun simctl list devices -j | jq -r --arg u "$DEVICE" '[.devices[][] | select((.udid|ascii_downcase)==($u|ascii_downcase))] | .[0].state // ""')"
  [ "$st" = "Booted" ] || die "simulator $DEVICE did not reach Booted state"
fi

# ── app must already be installed — never auto-install ───────────────────────
if ! xcrun simctl get_app_container "$DEVICE" "$APP_ID" >/dev/null 2>&1; then
  die "$APP_ID is not installed on $DEVICE_NAME ($DEVICE).
       Build and install it yourself first (this harness deliberately does NOT install
       anything, so it can never overwrite the build you meant to soak-test), e.g.:
         xcrun simctl install $DEVICE /path/to/Walnut.app"
fi

echo "app:    $APP_ID installed"
echo "run:    minutes=$MINUTES seed=$SEED driver=$DRIVER server=$SERVER"
echo

# ── run the episode; SIGINT is forwarded so the journal is finished cleanly ───
node "$HERE/episode.mjs" \
  --device "$DEVICE" \
  --device-name "$DEVICE_NAME" \
  --minutes "$MINUTES" \
  --seed "$SEED" \
  --driver "$DRIVER" \
  --server "$SERVER" \
  "${EXTRA[@]+"${EXTRA[@]}"}" &
NODE_PID=$!

forward() {
  echo "" >&2
  echo "interrupt received — asking the episode to finish its journal ..." >&2
  kill -INT "$NODE_PID" 2>/dev/null || true
}
trap forward INT TERM

wait "$NODE_PID"
STATUS=$?
trap - INT TERM

LATEST="$(ls -dt /tmp/walnut-robot/*-seed"$SEED" 2>/dev/null | head -1)"
if [ -n "$LATEST" ] && [ -f "$LATEST/summary.json" ]; then
  COUNT="$(jq '.anomalies | length' "$LATEST/summary.json" 2>/dev/null || echo "?")"
  STEPS="$(jq '.steps' "$LATEST/summary.json" 2>/dev/null || echo "?")"
  echo
  echo "journal: $LATEST"
  if [ "$COUNT" = "0" ]; then
    echo "verdict: CLEAN ($STEPS steps)"
  else
    echo "verdict: $COUNT anomalies ($STEPS steps) — see $LATEST/summary.json, replay with $LATEST/replay.yaml"
  fi
fi

exit "$STATUS"
