#!/usr/bin/env bash
# End-to-end proof of the iOS flight-recorder upload path.
#
# Asserts the one thing no unit test can: an `AppLog.error` produced by the REAL
# app on a simulator lands as a line in the receiving server's
# `<LOG_DIR>/ios-client/<device>-<day>.log`. Everything in between is exercised
# for real — LogSpill on disk, gzip framing, the Bearer token, the /api/v1
# route, the device-name sanitizer, the append.
#
# Runs against a THROWAWAY server on port 3459 with an isolated data dir and an
# isolated LOG_DIR. It never touches production (:3456) and refuses to.
#
#   scripts/ios-client-log-e2e.sh [--device "iPhone 16 Pro"] [--port 3459]
#
# Exit 0 = the marker line reached disk. Exit 1 = it did not (with the reason).
set -uo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="dev.openwalnut.ios"
DEVICE_NAME="iPhone 16 Pro"
PORT="3459"

while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Hard stop: this script starts and KILLS a server, so it must never be aimed at
# production. Same guard as walnut-sandbox.sh.
if [ "$PORT" = "3456" ]; then
  echo "refusing to act on port 3456 (production)" >&2
  exit 1
fi

RUN_ID="$(date +%s)"
WORK="/tmp/ios-client-log-e2e-$RUN_ID"
HOME_DIR="$WORK/home"
LOG_DIR="$WORK/logs"
PROBE_DEVICE="e2e-probe-$RUN_ID"
# The marker must NOT be a substring of the device name: every ingested line
# carries `device`, so a shared substring makes any line a false positive (the
# first version of this script "passed" on an unrelated network line).
MARKER="flightrec$RUN_ID"
mkdir -p "$HOME_DIR" "$LOG_DIR"

SERVER_PID=""
cleanup() {
  # Kill by LISTENER, not by the recorded pid: the server runs inside a `( … ) &`
  # subshell, so $SERVER_PID is the subshell and killing it leaves `node` holding
  # the port. That orphan made the NEXT run fail with EADDRINUSE while its app
  # happily uploaded into the PREVIOUS run's log dir — a confusing false negative.
  [ -n "$SERVER_PID" ] && kill -15 "$SERVER_PID" 2>/dev/null
  local listener
  listener="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$listener" ] && kill -15 $listener 2>/dev/null
  # WORK is kept on purpose: the ingested file is the evidence.
  echo "artifacts: $WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "── $*"; }

# ── 1. Build the server, start it isolated ─────────────────────────────────
step "building server"
(cd "$REPO" && npx tsup >/dev/null 2>&1) || fail "server build failed"

# Reap a listener a previous run's SIGKILL left behind. Without this the server
# below silently dies on EADDRINUSE and the app uploads into the OLD run's dir.
STALE="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -n "$STALE" ]; then
  step "reaping a stale listener on :$PORT ($STALE)"
  kill -15 $STALE 2>/dev/null
  sleep 2
fi

step "starting throwaway server on :$PORT (data $HOME_DIR, logs $LOG_DIR)"
(
  cd "$REPO"
  OPEN_WALNUT_HOME="$HOME_DIR" WALNUT_DAEMON_DIR="$LOG_DIR" \
    node dist/cli.js web --port "$PORT" >"$WORK/server.log" 2>&1
) &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/v1/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/v1/status" >/dev/null 2>&1 \
  || fail "server never came up (see $WORK/server.log)"
# "Something answers on the port" is NOT proof it's OUR server — an orphan from a
# previous run answers identically while writing to a different log dir. Confirm
# the listener is the pid we started.
LISTENER_PID="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$LISTENER_PID" ] && ! ps -o ppid= -p "$LISTENER_PID" 2>/dev/null | grep -qw "$SERVER_PID"; then
  grep -q "EADDRINUSE" "$WORK/server.log" 2>/dev/null \
    && fail "port $PORT is held by a foreign server (pid $LISTENER_PID) — ours died on EADDRINUSE"
fi

# ── 2. Mint a device token on THAT server's data dir ───────────────────────
step "pairing a throwaway device"
TOKEN="$(cd "$REPO" && OPEN_WALNUT_HOME="$HOME_DIR" WALNUT_DAEMON_DIR="$LOG_DIR" \
  node dist/cli.js device add "$PROBE_DEVICE" --json 2>/dev/null | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["token"])')" || fail "device add failed"
[ -n "$TOKEN" ] || fail "device add produced no token"

# ── 3. Build + install the app, launch it wired to the throwaway server ────
step "building the app (Debug — the probe hook is DEBUG-only)"
(cd "$REPO/ios-native" && xcodegen generate >/dev/null 2>&1)
(cd "$REPO/ios-native" && xcodebuild -scheme Walnut -configuration Debug \
  -destination "platform=iOS Simulator,name=$DEVICE_NAME" \
  -derivedDataPath "$WORK/dd" build >"$WORK/xcodebuild.log" 2>&1) \
  || fail "app build failed (see $WORK/xcodebuild.log)"

APP="$(find "$WORK/dd/Build/Products" -maxdepth 2 -name 'Walnut.app' -type d | head -1)"
[ -n "$APP" ] || fail "no Walnut.app in $WORK/dd"

UDID="$(xcrun simctl list devices -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
for runtime in d.values():
    for dev in runtime:
        if dev['name']=='$DEVICE_NAME' and dev['isAvailable']:
            print(dev['udid']); raise SystemExit
")"
[ -n "$UDID" ] || fail "simulator '$DEVICE_NAME' not found"

xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" >/dev/null 2>&1
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1

step "installing + launching on $DEVICE_NAME ($UDID)"
xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1
xcrun simctl install "$UDID" "$APP" >/dev/null 2>&1 || fail "simctl install failed"

# The simulator reaches the host server on localhost. Launch args land in
# UserDefaults' NSArgumentDomain, which is how the app picks up the server URL,
# the token (DEBUG-only hook in AppConfig) and the probe marker.
xcrun simctl launch --console-pty "$UDID" "$APP_ID" \
  -walnut.serverUrl "http://127.0.0.1:$PORT" \
  -walnut.deviceToken "$TOKEN" \
  -walnut.deviceName "$PROBE_DEVICE" \
  -walnut.diagnosticsProbe "$MARKER" >"$WORK/app.log" 2>&1 &
LAUNCH_PID=$!

# ── 4. Assert the marker line reached disk ─────────────────────────────────
step "waiting for the marker line to land in $LOG_DIR/ios-client/"
DAY="$(date -u +%Y-%m-%d)"
EXPECTED="$LOG_DIR/ios-client/$PROBE_DEVICE-$DAY.log"
FOUND=""
for _ in $(seq 1 60); do
  # Match the META FIELD, not a bare substring — see the MARKER note above.
  if [ -f "$EXPECTED" ] && grep -q "\"m_marker\":\"$MARKER\"" "$EXPECTED" 2>/dev/null; then
    FOUND="$EXPECTED"; break
  fi
  # The device name is sanitized server-side ([^A-Za-z0-9_-] → '-'), so fall
  # back to a content match across the whole dir rather than assuming the name.
  HIT="$(grep -l "\"m_marker\":\"$MARKER\"" "$LOG_DIR"/ios-client/*.log 2>/dev/null | head -1)"
  if [ -n "$HIT" ]; then FOUND="$HIT"; break; fi
  sleep 2
done

kill -15 "$LAUNCH_PID" 2>/dev/null
xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1

if [ -z "$FOUND" ]; then
  echo "--- server log (client-logs lines) ---" >&2
  grep -i "client.log" "$WORK/server.log" 2>/dev/null | tail -20 >&2
  echo "--- ios-client dir ---" >&2
  ls -la "$LOG_DIR/ios-client/" 2>&1 >&2
  fail "no ingested line carried marker '$MARKER' — the upload path is broken"
fi

step "PASS — marker '$MARKER' ingested"
echo "  file: $FOUND"
grep "$MARKER" "$FOUND" | head -1
# The probe line must arrive as a real structured error line, not a blob.
python3 - "$FOUND" "$MARKER" <<'PY' || fail "the ingested line is not the expected shape"
import json, sys
path, marker = sys.argv[1], sys.argv[2]
for raw in open(path):
    line = json.loads(raw)
    if line.get("m_marker") == marker:
        assert line["level"] == "error", line
        assert line["subsystem"] == "diagnostics-probe", line
        assert line.get("device"), line
        assert line.get("appVersion"), line
        print("  shape ok:", {k: line[k] for k in ("level", "subsystem", "device", "appVersion")})
        raise SystemExit(0)
raise SystemExit("marker line not found in %s" % path)
PY
