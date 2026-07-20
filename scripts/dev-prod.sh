#!/usr/bin/env bash
set -euo pipefail

PORT=3456
LOCK_DIR="${TMPDIR:-/tmp}/open-walnut-dev-prod.lock"
SERVER_LOG=/private/tmp/open-walnut-launchd.log
LAUNCH_LABEL=com.open-walnut.dev-prod
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_BIN="$(command -v node)"

current_nice="$(ps -o ni= -p $$ 2>/dev/null | tr -d '[:space:]')"
if [[ "$current_nice" =~ ^-?[0-9]+$ ]] && (( current_nice > 0 )); then
  echo "Refusing to deploy from a niced shell (nice=$current_nice)." >&2
  echo "Run npm run dev:prod from a normal-priority terminal." >&2
  exit 1
fi

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return
  fi

  local holder=""
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
    echo "Another dev:prod deployment is already running (PID: $holder)." >&2
    exit 1
  fi

  # Reclaim only the exact lock shape created by this script.
  rm -f "$LOCK_DIR/pid"
  if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Could not reclaim stale dev:prod lock: $LOCK_DIR" >&2
    exit 1
  fi
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

release_lock() {
  local holder=""
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$holder" == "$$" ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

acquire_lock
trap release_lock EXIT

npm run web:build

use_launchd=0
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  use_launchd=1
  launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
fi

existing_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$existing_pids" ]]; then
  # shellcheck disable=SC2086
  kill -15 $existing_pids
  for _ in {1..20}; do
    if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Existing server did not stop; refusing to start a competing process." >&2
  exit 1
fi

pid=""
if (( use_launchd )); then
  launchctl submit \
    -l "$LAUNCH_LABEL" \
    -o "$SERVER_LOG" \
    -e "$SERVER_LOG" \
    -- /bin/sh -c 'cd "$1" && shift && exec "$@"' open-walnut \
    "$REPO_ROOT" /usr/bin/env \
    -u OPEN_WALNUT_EPHEMERAL \
    -u OPEN_WALNUT_HOME \
    -u WALNUT_DAEMON_DIR \
    -u VITEST \
    "$NODE_BIN" "$REPO_ROOT/dist/cli.js" web --port "$PORT"
else
  nohup env -u OPEN_WALNUT_EPHEMERAL \
    -u OPEN_WALNUT_HOME \
    -u WALNUT_DAEMON_DIR \
    -u VITEST \
    "$NODE_BIN" "$REPO_ROOT/dist/cli.js" web --port "$PORT" \
    </dev/null >>"$SERVER_LOG" 2>&1 &
  pid=$!
fi

stop_new_server() {
  if (( use_launchd )); then
    launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
  elif [[ -n "$pid" ]]; then
    kill -15 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

ready=0
for _ in {1..20}; do
  if (( ! use_launchd )) && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" || true
    echo "Server process exited before becoming ready." >&2
    exit 1
  fi
  config_json="$(curl --connect-timeout 1 --max-time 2 -sf \
    "http://localhost:$PORT/api/config" 2>/dev/null || true)"
  if [[ -n "$config_json" ]]; then
    process_nice="$(printf '%s' "$config_json" | "$NODE_BIN" -e '
      let input = "";
      process.stdin.on("data", chunk => { input += chunk });
      process.stdin.on("end", () => {
        const value = JSON.parse(input).processNice;
        if (!Number.isInteger(value)) process.exit(2);
        process.stdout.write(String(value));
      });
    ' 2>/dev/null || true)"
    if [[ "$process_nice" =~ ^-?[0-9]+$ ]] && (( process_nice > 0 )); then
      stop_new_server
      echo "New server inherited nice=$process_nice; deployment aborted." >&2
      exit 1
    fi
    if [[ ! "$process_nice" =~ ^-?[0-9]+$ ]]; then
      sleep 0.5
      continue
    fi
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" != "1" ]]; then
  stop_new_server
  echo "Server failed its bounded readiness check." >&2
  exit 1
fi

pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)"
echo "Server ready (PID: $pid)"
