#!/usr/bin/env bash
set -euo pipefail

# Dry run: execute every guard, then stop before the first mutating step (build,
# server kill, launchd submit). CI runs this on Linux so a macOS-only assumption
# in the deploy path fails a push instead of an actual deploy — the class of bug
# behind issue #11. The port override is honoured ONLY in dry-run: a real deploy
# on another port would put a second server on the production data dir, which is
# a task-deletion shape here.
DRY_RUN="${WALNUT_DEVPROD_DRY_RUN:-0}"
PORT=3456
if [[ "$DRY_RUN" == "1" ]]; then
  PORT="${WALNUT_DEVPROD_PORT:-$PORT}"
fi
LOCK_DIR="${TMPDIR:-/tmp}/open-walnut-dev-prod.lock"
# Plain /tmp, not /private/tmp: on macOS /tmp is a symlink to /private/tmp so this
# is the same inode as before (existing log, existing fds, unchanged), while Linux
# — where /private/tmp does not exist — can finally write it. The old hardcoded
# macOS path made a Linux deploy kill the running server and then fail to start
# its replacement, leaving prod down (issue #11, Unraid x64).
SERVER_LOG="${WALNUT_SERVER_LOG:-/tmp/open-walnut-launchd.log}"
LAUNCH_LABEL=com.open-walnut.dev-prod
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SUCCESS_STAMP="${TMPDIR:-/tmp}/open-walnut-dev-prod.last-success"
ATTEMPT_STAMP="${TMPDIR:-/tmp}/open-walnut-dev-prod.last-attempt"
COOLDOWN_SECS=120
SERVER_LOG_MAX_BYTES=$(( 256 * 1024 * 1024 ))

# Prove the log is appendable BEFORE anything destructive. The redirect that
# actually starts the server happens AFTER the old one is killed, so an
# unwritable log surfaced as "prod is down and won't come back" instead of a
# failed deploy. Fail here, with the old server still serving.
if ! ( : >> "$SERVER_LOG" ) 2>/dev/null; then
  echo "Cannot append to server log: $SERVER_LOG" >&2
  echo "Set WALNUT_SERVER_LOG to a writable path and retry." >&2
  exit 1
fi

# ── Portable listener detection ─────────────────────────────────────────────
# Every guard below asks "is something listening on :$PORT". macOS always has
# lsof; a minimal Linux box may ship only ss (iproute2) or fuser (psmisc). With
# none of them a bare `lsof` call returns empty, so each guard would FAIL OPEN
# and happily start a second server against the same data dir — the exact shape
# behind the stale-cache task-deletion incidents. So: hard failure.
PORT_PROBE=""
for probe in lsof ss fuser; do
  if command -v "$probe" >/dev/null 2>&1; then PORT_PROBE="$probe"; break; fi
done
if [[ -z "$PORT_PROBE" ]]; then
  echo "Need one of lsof / ss / fuser to tell whether :$PORT is already served." >&2
  echo "Install one (e.g. iproute2 for ss) and retry." >&2
  exit 1
fi

# Prints one PID per line (empty when nothing listens). Always exits 0 — a
# non-zero status inside `x="$(listener_pids)"` would abort the deploy under set -e.
listener_pids() {
  case "$PORT_PROBE" in
    lsof)  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true ;;
    # No -H: older iproute2 rejects it. The header line carries no "pid=" so
    # grep drops it anyway.
    ss)    ss -ltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true ;;
    fuser) fuser -n tcp "$PORT" 2>/dev/null | tr -s '[:space:]' '\n' | grep -E '^[0-9]+$' || true ;;
  esac
}

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
  listener_pid="$(listener_pids | head -n 1)"
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
# A dry run deploys nothing, so it must not consume a real deploy's cooldown.
[[ "$DRY_RUN" == "1" ]] || date +%s > "$ATTEMPT_STAMP"

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

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] every guard passed on $(uname -s) (probe: $PORT_PROBE, log: $SERVER_LOG)."
  echo "[dry-run] stopping before build, server kill and launch — nothing was deployed."
  exit 0
fi

npm run web:build

use_launchd=0
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  use_launchd=1
  launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
fi

existing_pids="$(listener_pids)"
if [[ -n "$existing_pids" ]]; then
  # A listener can exit between lsof and kill (e.g. it was already shutting
  # down); a vanished PID must not abort the deploy under set -e.
  # shellcheck disable=SC2086
  kill -15 $existing_pids 2>/dev/null || true
  for _ in {1..20}; do
    if [[ -z "$(listener_pids)" ]]; then
      break
    fi
    sleep 0.5
  done
  # Port released is NOT proof the process died — verify each PID, and SIGKILL
  # any survivor. A server that ignores SIGTERM keeps its health monitor, cron,
  # git auto-commit and plugin polling running forever (2026-08-09: 62 such
  # zombies, peak 43 concurrent, load average 94 → macOS killed the user's GUI
  # apps). The server-side fix makes SIGTERM always fatal; this is the belt to
  # that suspenders, and also covers OLD binaries still on disk.
  for zpid in $existing_pids; do
    kill -0 "$zpid" 2>/dev/null || continue
    echo "Server PID $zpid survived SIGTERM — sending SIGKILL." >&2
    kill -9 "$zpid" 2>/dev/null || true
  done
fi

if [[ -n "$(listener_pids)" ]]; then
  echo "Existing server did not stop; refusing to start a competing process." >&2
  exit 1
fi

# ── Zombie sweep: servers that never reached listen() ───────────────────────
# The port check above can only see a server that BOUND the port. A server
# SIGTERMed mid-boot (before listen()) held no port, so it stayed invisible to
# every guard while still running its background loops — that is exactly how the
# 2026-08-09 pile-up went unnoticed for hours. Match this repo's own server
# command line, exclude ourselves and any --ephemeral/test server, and reap.
# macOS ships bash 3.2 — no `mapfile`/`readarray`. Plain word-splitting on a
# newline-separated pgrep result is the portable form.
self_pid=$$
stray_pids="$(pgrep -f 'dist/cli\.js web' 2>/dev/null || true)"
for spid in $stray_pids; do
  [[ -n "$spid" && "$spid" != "$self_pid" ]] || continue
  kill -0 "$spid" 2>/dev/null || continue
  cmd="$(ps -o command= -p "$spid" 2>/dev/null || true)"
  # Only OUR repo's production server; never an ephemeral/test instance.
  [[ "$cmd" == *"$REPO_ROOT/dist/cli.js"* ]] || continue
  # `[[ … ]] && continue` would return 1 when it does NOT match, and under
  # `set -e` that aborts the deploy — the 2026-07-25 lesson about guards that
  # kill the script they protect. Use an explicit if/continue.
  if [[ "$cmd" == *"--_ephemeral-child"* || "$cmd" == *"--ephemeral"* ]]; then
    continue
  fi
  # A server started with an explicit NON-prod --port is a test instance
  # (provider-matrix harness, ad-hoc dev), not a stray prod boot — never reap
  # it. 2026-08-12: a concurrent deploy's sweep SIGKILLed the live-matrix
  # ephemeral server on :4105 mid-run, failing 10 scenarios on a dead server.
  port_arg="$(printf '%s' "$cmd" | sed -n 's/.*--port[= ]\([0-9][0-9]*\).*/\1/p')"
  if [[ -n "$port_arg" && "$port_arg" != "$PORT" ]]; then
    continue
  fi
  echo "Reaping stray Walnut server PID $spid (never bound :$PORT): $cmd" >&2
  kill -15 "$spid" 2>/dev/null || true
  for _ in {1..6}; do
    kill -0 "$spid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$spid" 2>/dev/null; then
    kill -9 "$spid" 2>/dev/null || true
  fi
done

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

pid="$(listener_pids | head -n 1)"
date +%s > "$SUCCESS_STAMP"
echo "Server ready (PID: $pid)"
