#!/bin/bash
# Manual verification for the P1 agent gateway (plan §8).
#
# Builds the daemon, starts an ISOLATED daemon (WALNUT_DAEMON_DIR=<tmp> —
# never touches the production /tmp/open-walnut daemon), then probes the
# agent gateway socket two ways:
#   1. raw NDJSON over `nc -U` (protocol-level round-trip)
#   2. through the on-PATH `wn` shim the daemon writes (ship-surface round-trip)
#
# Without a Mac hub client connected, a well-formed request from an unknown
# sid must come back as a STRUCTURED error (unknown_caller) — that proves the
# listener, parser, and response path end-to-end without needing live sessions.
#
# The daemon is ALWAYS killed by the exit trap (leaked isolated daemons once
# starved this machine — never leave one behind).
set -euo pipefail

cd "$(dirname "$0")/.."

TMP_DIR="$(mktemp -d /tmp/walnut-gateway-verify.XXXXXX)"
DAEMON_PID=""

cleanup() {
  # Kill the isolated daemon no matter how we exit.
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$DAEMON_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

echo "== 1/4 build daemon =="
bash scripts/build-daemon.sh

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) BIN="dist/daemon-binaries/daemon-darwin-arm64" ;;
  Linux-x86_64) BIN="dist/daemon-binaries/daemon-linux-x64" ;;
  Linux-aarch64) BIN="dist/daemon-binaries/daemon-linux-arm64" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "== 2/4 start isolated daemon (dir: $TMP_DIR) =="
# WALNUT_DAEMON_PARENT_PID: the daemon's parent-liveness watchdog reaps it if
# this script dies before the trap runs — second line of defense against leaks.
WALNUT_DAEMON_DIR="$TMP_DIR" \
WALNUT_STREAMS_DIR="$TMP_DIR/streams" \
WALNUT_DAEMON_PARENT_PID="$$" \
  "$BIN" --start >/dev/null 2>&1 &
sleep 1
DAEMON_PID="$(cat "$TMP_DIR/daemon.pid" 2>/dev/null || true)"
if [ -z "$DAEMON_PID" ] || ! kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "FAIL: isolated daemon did not start (no live pid in $TMP_DIR/daemon.pid)" >&2
  exit 1
fi
echo "daemon pid=$DAEMON_PID"

SOCK="$TMP_DIR/agent-gateway.sock"
for _ in $(seq 1 20); do
  [ -S "$SOCK" ] && break
  sleep 0.25
done
if [ ! -S "$SOCK" ]; then
  echo "FAIL: gateway socket never appeared at $SOCK" >&2
  exit 1
fi
echo "gateway socket: $SOCK ($(stat -f '%Sp' "$SOCK" 2>/dev/null || stat -c '%A' "$SOCK"))"

echo "== 3/4 raw NDJSON probe via nc -U =="
REQ='{"v":1,"op":"peers.list","sid":"verify-script-fake-sid","args":{}}'
echo "-> $REQ"
RESP="$(printf '%s\n' "$REQ" | nc -U "$SOCK" -w 5 || true)"
echo "<- $RESP"
if ! printf '%s' "$RESP" | grep -q '"ok"'; then
  echo "FAIL: raw probe got no structured response" >&2
  exit 1
fi
# Unknown sid must be rejected locally as unknown_caller.
printf '%s' "$RESP" | grep -q 'unknown_caller' \
  && echo "OK: unknown sid rejected locally (unknown_caller)"

REQ_BAD='{"v":9,"op":"peers.list","sid":"x"}'
echo "-> $REQ_BAD"
RESP_BAD="$(printf '%s\n' "$REQ_BAD" | nc -U "$SOCK" -w 5 || true)"
echo "<- $RESP_BAD"
printf '%s' "$RESP_BAD" | grep -q 'unsupported_version' \
  || { echo "FAIL: bad version not rejected" >&2; exit 1; }
echo "OK: version check enforced"

echo "== 4/4 via the wn shim =="
WN_SHIM="$TMP_DIR/bin/wn"
if [ ! -x "$WN_SHIM" ]; then
  echo "FAIL: daemon did not write the wn shim at $WN_SHIM" >&2
  exit 1
fi
echo "-- wn --help (first lines) --"
"$WN_SHIM" --help | head -5

echo "-- wn peers list (fake sid → expect exit 6 unknown_caller path) --"
set +e
WALNUT_AGENT_SOCKET="$SOCK" WALNUT_SESSION_ID="verify-script-fake-sid" "$WN_SHIM" peers list
WN_EXIT=$?
set -e
echo "wn exit code: $WN_EXIT (expected 6: unknown_caller — fake sid, no live session)"
[ "$WN_EXIT" -eq 6 ] || { echo "FAIL: unexpected wn exit code" >&2; exit 1; }

echo ""
echo "PASS: gateway socket + raw protocol + wn shim all round-tripped."
