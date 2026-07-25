#!/usr/bin/env bash
set -euo pipefail

PORT=3456
LOCK_DIR="${TMPDIR:-/tmp}/open-walnut-dev-prod.lock"
SERVER_LOG=/private/tmp/open-walnut-launchd.log
LAUNCH_LABEL=com.open-walnut.dev-prod
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SUCCESS_STAMP="${TMPDIR:-/tmp}/open-walnut-dev-prod.last-success"
ATTEMPT_STAMP="${TMPDIR:-/tmp}/open-walnut-dev-prod.last-attempt"
COOLDOWN_SECS=120
SERVER_LOG_MAX_BYTES=$(( 256 * 1024 * 1024 ))

# ── Redeploy-storm breaker ──────────────────────────────────────────────────
# 2026-07-25 incident: an agent wrapped this script in `launchctl submit`,
# whose implicit KeepAlive re-runs the job every time it exits — the "deploy"
# became a loop that killed a 10s-old prod server 7 times in a row (and one
# window race killed a healthy mid-compaction CLI session). Two guards:
#   1. Cooldown: if the last successful deploy was < COOLDOWN_SECS ago, exit 0
#      (success, no-op) — any KeepAlive loop degrades to harmless churn.
#   2. Young-server guard: refuse to kill a listener younger than COOLDOWN_SECS
#      even without a stamp (covers a stamp lost to /tmp cleanup).
#   3. Attempt cooldown: the same window keyed on *attempts*, not successes. A
#      deploy that dies before writing SUCCESS_STAMP (readiness timeout, failed
#      build, killed mid-flight) used to leave the cooldown permanently disarmed,
#      so a KeepAlive loop re-killed the server every ~10s forever. Rate-limiting
#      attempts makes the breaker hold even when every deploy fails.
# Override all with WALNUT_DEVPROD_FORCE=1 for intentional rapid redeploys.
if [[ "${WALNUT_DEVPROD_FORCE:-0}" != "1" ]]; then
  for stamp_file in "$SUCCESS_STAMP" "$ATTEMPT_STAMP"; do
    [[ -f "$stamp_file" ]] || continue
    last_deploy="$(cat "$stamp_file" 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    if [[ "$last_deploy" =~ ^[0-9]+$ ]] && (( now_epoch - last_deploy < COOLDOWN_SECS )); then
      kind="deploy"; [[ "$stamp_file" == "$ATTEMPT_STAMP" ]] && kind="deploy attempt"
      echo "Deploy skipped: last $kind was $(( now_epoch - last_deploy ))s ago (< ${COOLDOWN_SECS}s cooldown)."
      echo "Server on :$PORT is already current. Set WALNUT_DEVPROD_FORCE=1 to override."
      exit 0
    fi
  done
  listener_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "$listener_pid" ]]; then
    etime="$(ps -o etime= -p "$listener_pid" 2>/dev/null | tr -d '[:space:]')"
    # etime formats: SS / MM:SS / HH:MM:SS / DD-HH:MM:SS — only the colon-less
    # and MM:SS-under-cooldown shapes can be "young".
    # Zero-padded fields ("00:09", "08") MUST be forced to base 10: bash treats a
    # leading zero as octal, so `$(( 09 ))` aborts with "value too great for base"
    # and `set -e` kills the script — the very guard meant to stop a redeploy loop
    # became the thing that let one through (2026-07-25: 69 kills in ~7h).
    uptime_secs=""
    if [[ "$etime" =~ ^([0-9]+):([0-9]{2})$ ]]; then
      uptime_secs=$(( 10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]} ))
    elif [[ "$etime" =~ ^[0-9]+$ ]]; then
      uptime_secs=$(( 10#$etime ))
    fi
    if [[ -n "$uptime_secs" ]] && (( uptime_secs < COOLDOWN_SECS )); then
      echo "Refusing to kill server PID $listener_pid: only ${uptime_secs}s old (< ${COOLDOWN_SECS}s)." >&2
      echo "This looks like a redeploy loop. Set WALNUT_DEVPROD_FORCE=1 if intentional." >&2
      exit 1
    fi
  fi
fi

# Deploys can be launched from thin-PATH contexts (launchd, cron, background
# agent shells) that lack user install prefixes — node/bun/ffmpeg then fail
# mid-deploy and the retry loop stretches the port-swap downtime from seconds
# to minutes. Append the well-known prefixes (caller's explicit PATH still
# wins); the server inherits this via the PATH="$PATH" passed to launchctl.
for extra_dir in "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in
    *":$extra_dir:"*) ;;
    *) PATH="$PATH:$extra_dir" ;;
  esac
done
export PATH

NODE_BIN="$(command -v node)"

# `launchctl submit` jobs are implicitly KeepAlive: launchd re-runs them every
# time they exit. This script is a ONE-SHOT deploy, so being submitted that way
# turns it into an infinite kill-the-server loop (2026-07-25: 916 runs, 69 kills).
# launchd exports XPC_SERVICE_NAME for every job it spawns — but GUI terminals
# (iTerm, Terminal.app) are launchd jobs too and their shells inherit
# "application.<bundle-id>.…", so match only the non-application labels a
# `launchctl submit` / LaunchAgent deploy would carry. "0" is launchd's
# not-a-service sentinel.
xpc_label="${XPC_SERVICE_NAME:-}"
if [[ -n "$xpc_label" && "$xpc_label" != "0" && "$xpc_label" != application.* ]]; then
  echo "Refusing to deploy from launchd job '${xpc_label}'." >&2
  echo "launchctl submit implies KeepAlive — this one-shot script would be re-run forever." >&2
  echo "Kill the loop:  launchctl remove ${xpc_label}" >&2
  echo "Deploy instead from a normal terminal:  npm run dev:prod" >&2
  exit 1
fi

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

# Arm the attempt cooldown BEFORE anything destructive. Written here (not after a
# successful deploy) so a run that dies mid-flight still rate-limits its retry.
date +%s > "$ATTEMPT_STAMP"

# $SERVER_LOG is append-only across every deploy and had no bound — it reached
# 545 MB (2026-07-25), which is both a disk risk and a real cost for the log
# toolkit (every grep/jq scans it). Keep one generation at deploy time.
if [[ -f "$SERVER_LOG" ]]; then
  log_bytes="$(wc -c < "$SERVER_LOG" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [[ "$log_bytes" =~ ^[0-9]+$ ]] && (( 10#$log_bytes > SERVER_LOG_MAX_BYTES )); then
    # Copy-then-truncate, NOT mv: the outgoing server still holds an append fd on
    # this inode, and renaming would leave it writing into the .1 archive while the
    # live path stayed empty. Truncating in place keeps every fd pointed at the
    # right file.
    cp -f "$SERVER_LOG" "$SERVER_LOG.1" 2>/dev/null || true
    : > "$SERVER_LOG"
    echo "Rotated $SERVER_LOG ($(( 10#$log_bytes / 1024 / 1024 )) MB) → $SERVER_LOG.1"
  fi
fi

npm run web:build

use_launchd=0
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  use_launchd=1
  launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
fi

existing_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$existing_pids" ]]; then
  # A listener can exit between lsof and kill (e.g. it was already shutting
  # down); a vanished PID must not abort the deploy under set -e.
  # shellcheck disable=SC2086
  kill -15 $existing_pids 2>/dev/null || true
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
  # launchd gives jobs a minimal PATH (/usr/bin:/bin:...) — pass the caller's
  # full PATH through so child tools (ffmpeg, git, ssh, brew, agent CLIs)
  # resolve exactly as they would from the deploying shell.
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
    PATH="$PATH" \
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

# 120 × 0.5s = 60s readiness window (a slow boot under load can exceed 10s).
ready=0
for _ in {1..120}; do
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
date +%s > "$SUCCESS_STAMP"
echo "Server ready (PID: $pid)"
