#!/usr/bin/env bash
# Host-based PRISTINE clean-room for the first-run onboarding test/recording — the
# Docker-free fallback (use when Docker is unavailable/locked down).
#
# It reproduces "fresh machine, nothing configured" WITHOUT a container by:
#   - overriding HOME → a throwaway dir, so ~/.claude and ~/.aws are EMPTY
#     (os.homedir() honors $HOME on macOS/Linux — verified)
#   - isolating OPEN_WALNUT_HOME + WALNUT_DAEMON_DIR to throwaway dirs
#   - UNSETTING every Bedrock/Anthropic credential the dev's shell carries
#   - serving on :3457 (NOT the production :3456) and disabling the embedding download
#
# Production on :3456 and the real ~/.open-walnut / ~/.claude are never touched.
#
#   scripts/onboarding-cleanroom.sh clean            # path 1/3: no creds → onboarding shows
#   scripts/onboarding-cleanroom.sh happy            # path 2: inject host cred → butler ready
#   scripts/onboarding-cleanroom.sh record out.mp4   # record the clean-room onboarding
#   scripts/onboarding-cleanroom.sh stop
set -uo pipefail

PORT=3457
URL="http://localhost:${PORT}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/walnut-cleanroom"
FAKE_HOME="$ROOT/home"
PID_FILE="$ROOT/server.pid"

cmd="${1:-help}"

# Env that makes the room pristine. Note: we deliberately DO NOT pass the dev's
# AWS_*/ANTHROPIC_* through (env -i style) for the clean path.
launch_server() {
  # $@ = extra KEY=VAL creds to inject (happy path). None = clean room.
  rm -rf "$ROOT"; mkdir -p "$FAKE_HOME"
  echo "==> clean HOME=$FAKE_HOME  OPEN_WALNUT_HOME=$ROOT/.open-walnut  port=$PORT"
  # Build once (uses the REAL repo node_modules — fine; isolation is about data, not deps).
  ( cd "$HERE" && npm run web:build >/tmp/walnut-cleanroom-build.log 2>&1 ) || { echo "build failed"; tail -15 /tmp/walnut-cleanroom-build.log; exit 1; }
  # env -i gives a truly empty environment; re-add only what's needed + any injected creds.
  env -i \
    HOME="$FAKE_HOME" \
    PATH="$PATH" \
    NODE_ENV=production \
    WALNUT_DISABLE_SEARCH=1 \
    OPEN_WALNUT_HOME="$ROOT/.open-walnut" \
    WALNUT_DAEMON_DIR="$ROOT/daemon" \
    "$@" \
    node "$HERE/dist/cli.js" web --port "$PORT" >"$ROOT/server.log" 2>&1 &
  echo $! > "$PID_FILE"
  echo "==> server pid $(cat "$PID_FILE"), logs: $ROOT/server.log"
}

stop_server() {
  # A signal is not a death — confirm, then escalate. A server SIGTERMed while
  # still booting holds no port, so the lsof fallback below cannot see it; only
  # waiting on the recorded PID catches that case. Leaked boot-time servers keep
  # their health monitor / cron / git-autocommit loops running forever (2026-08-09:
  # 43 concurrent leaks starved the Mac until macOS killed the user's GUI apps).
  if [ -f "$PID_FILE" ]; then
    spid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$spid" ]; then
      kill -15 "$spid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$spid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$spid" 2>/dev/null; then
        echo "==> server pid $spid ignored SIGTERM — SIGKILL" >&2
        kill -9 "$spid" 2>/dev/null || true
      fi
    fi
  fi
  # Belt-and-suspenders: kill anything we left on :3457 (NEVER touch 3456).
  lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -15 2>/dev/null || true
  sleep 1
  lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  rm -f "$PID_FILE"
}

case "$cmd" in
  clean)
    launch_server
    node "$HERE/scripts/onboarding-demo.mjs" --url "$URL"; rc=$?
    stop_server; exit $rc ;;

  happy)
    declare -a CREDS=()
    [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && CREDS+=("AWS_BEARER_TOKEN_BEDROCK=${AWS_BEARER_TOKEN_BEDROCK}")
    [ -n "${AWS_REGION:-}" ] && CREDS+=("AWS_REGION=${AWS_REGION}")
    [ -n "${AWS_PROFILE:-}" ] && CREDS+=("AWS_PROFILE=${AWS_PROFILE}")
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] && CREDS+=("AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}")
    [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && CREDS+=("AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}")
    if [ ${#CREDS[@]} -eq 0 ]; then
      echo "ERROR: 'happy' needs a credential in the host env (e.g. AWS_BEARER_TOKEN_BEDROCK + AWS_REGION)." >&2
      exit 2
    fi
    # NOTE: AWS_PROFILE would need ~/.aws — but FAKE_HOME is empty. Bearer token / keys work standalone.
    launch_server "${CREDS[@]}"
    node "$HERE/scripts/onboarding-demo.mjs" --url "$URL" --expect-ready --chat "hello, are you there?"; rc=$?
    stop_server; exit $rc ;;

  record)
    out="${2:-onboarding.mp4}"
    launch_server
    node "$HERE/scripts/onboarding-demo.mjs" --url "$URL" --record "$out"; rc=$?
    stop_server; exit $rc ;;

  stop) stop_server; echo "stopped." ;;

  *)
    echo "usage: scripts/onboarding-cleanroom.sh {clean|happy|record <file>|stop}" >&2
    exit 1 ;;
esac
