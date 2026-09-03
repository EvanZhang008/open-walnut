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

# ── Deploy drain: never SIGTERM the server mid Personal-AI turn ─────────────
# A kill landing inside a lane turn strands the answer. The `claude` CLI is owned
# by the daemon, so it survives the deploy, finishes and durably writes the reply
# — but the code that persists it into the conversation lived in the process we
# just killed, and re-attach skips replay by design. Measured cost: 2 of 14
# relayed phone turns over two days, every one matching a mid-turn SIGTERM.
#
# So ask the running server how many turns are in flight and WAIT for quiet,
# bounded. On timeout, or when the server can't answer, proceed exactly as
# before: a deploy must never hang, and the boot-time reconciler
# (core/sessions/lane-orphan-recovery.ts) is the backstop for whatever we do cut.
DRAIN_SECS="${WALNUT_DEVPROD_DRAIN_SECS:-90}"
# Non-numeric budget → default, loudly. `$(( DRAIN_SECS * 2 ))` treats an
# identifier-shaped value ("abc", "off", "none", "true") as an UNSET variable, so
# under `set -u` a typo'd knob aborted the deploy — after the full build and
# smoke boot, with an error message that never named the knob.
if [[ ! "$DRAIN_SECS" =~ ^[0-9]+$ ]]; then
  echo "WALNUT_DEVPROD_DRAIN_SECS='$DRAIN_SECS' is not a whole number of seconds; using 90." >&2
  DRAIN_SECS=90
fi

# Echoes the in-flight turn count, or NOTHING when the server does not answer.
# No jq: a deploy must not depend on it, and the endpoint answers one flat
# object. Always exits 0 — a non-zero status inside `n="$(active_turn_count)"`
# would abort the deploy under `set -e`.
active_turn_count() {
  local body
  body="$(curl --connect-timeout 1 --max-time 3 -sf \
    "http://localhost:$PORT/api/deploy/active-turns" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0
  printf '%s' "$body" \
    | sed -n 's/.*"activeTurns"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | head -n 1
  return 0
}

drain_active_turns() {
  if [[ "${WALNUT_DEVPROD_SKIP_DRAIN:-0}" == "1" ]]; then
    echo "Drain skipped (WALNUT_DEVPROD_SKIP_DRAIN=1) — a mid-turn kill can strand an answer."
    return 0
  fi
  local n halves=0 max_halves=$(( DRAIN_SECS * 2 ))
  n="$(active_turn_count)"
  if [[ -z "$n" ]]; then
    echo "Drain: :$PORT did not answer the active-turn probe — proceeding (old behavior)."
    return 0
  fi
  if [[ "$n" == "0" ]]; then
    echo "Drain: no Personal AI turn in flight on :$PORT."
    return 0
  fi
  echo "Drain: $n Personal AI turn(s) in flight on :$PORT — waiting up to ${DRAIN_SECS}s before the kill."
  while (( halves < max_halves )); do
    sleep 0.5
    halves=$(( halves + 1 ))
    n="$(active_turn_count)"
    if [[ -z "$n" ]]; then
      echo "Drain: probe stopped answering after $(( halves / 2 ))s — proceeding."
      return 0
    fi
    if [[ "$n" == "0" ]]; then
      echo "Drain: turns finished after $(( halves / 2 ))s — safe to kill."
      return 0
    fi
  done
  echo "Drain TIMEOUT: $n turn(s) still in flight after ${DRAIN_SECS}s — killing anyway." >&2
  echo "Any answer cut off here is adopted by the boot-time lane reconciler." >&2
  return 0
}

if [[ "$DRY_RUN" == "1" ]]; then
  # Exercise the drain end to end without ever waiting: a dry run deploys
  # nothing, so a zero budget still proves the probe + parse + both proceed
  # branches run on this OS. WALNUT_DEVPROD_PORT normally points at a free port,
  # so this takes the "did not answer → proceed" arm.
  DRAIN_SECS=0
  drain_active_turns
  echo "[dry-run] every guard passed on $(uname -s) (probe: $PORT_PROBE, log: $SERVER_LOG)."
  echo "[dry-run] stopping before build, server kill and launch — nothing was deployed."
  exit 0
fi

# ── Type-check the SPA before building it ───────────────────────────────────
# 2026-09-02: a deploy built the shared working tree while another agent was
# mid-refactor in a component (state variable deleted, a useMemo deps array
# still naming it). vite does not type-check, the smoke boot only asks for
# /api/config, so the bundle shipped and crashed on the first paint of `/` in
# every browser. `tsc --noEmit` on web/ names exactly that class of defect
# (`Cannot find name 'groupBy'`) in under a minute. A failure here is usually
# someone else's unfinished edit: wait for them or coordinate, and only reach
# for WALNUT_DEVPROD_SKIP_TSC=1 when the error is provably unrelated to `/`.
if [[ "${WALNUT_DEVPROD_SKIP_TSC:-0}" != "1" ]]; then
  WEB_TSC="$REPO_ROOT/web/node_modules/.bin/tsc"
  [[ -x "$WEB_TSC" ]] || WEB_TSC="$REPO_ROOT/node_modules/.bin/tsc"
  if [[ -x "$WEB_TSC" ]]; then
    echo "Type-checking web/ before the build (WALNUT_DEVPROD_SKIP_TSC=1 skips)."
    if ! (cd "$REPO_ROOT/web" && "$WEB_TSC" --noEmit -p tsconfig.json); then
      echo "web/ type-check FAILED — deploy aborted, production server on :$PORT untouched." >&2
      echo "A half-edited component ships as a first-paint crash; fix (or wait for the" >&2
      echo "author of) the errors above, or WALNUT_DEVPROD_SKIP_TSC=1 if provably unrelated." >&2
      exit 1
    fi
  else
    echo "web/ type-check skipped: no tsc binary found under web/ or the repo root." >&2
  fi
fi

npm run web:build

# ── Stage the dist on the temp volume before ANY boot ───────────────────────
# 2026-08-27: four consecutive deploys burned their whole readiness window and
# rolled back — a byte-identical cli.js booted in ~1s from the LKG copy under
# /var/folders but produced not one log line in 6+ minutes when launched from
# the repo path under /Users. Cause: on-access endpoint scanners hold the
# first open of every freshly written file, and a deploy always boots a
# freshly built dist at the exact moment the machine (and the scan queue) is
# busiest. The temp volume is outside the scan scope, so EVERY boot this
# script performs (smoke AND prod) runs from a staged copy there, never from
# the repo path. Staging itself is clonefile (metadata-only, no content
# reads), so it cannot stall on the scanner either.
STAGE_ROOT="${TMPDIR:-/tmp}"
STAGE_DIR="$STAGE_ROOT/open-walnut-stage.$(date +%s).$$"
STAGE_IN_USE=0

stage_dist() {
  mkdir -p "$STAGE_DIR" || return 1
  local copied=0
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if cp -Rc "$REPO_ROOT/dist" "$STAGE_DIR/dist" 2>/dev/null; then copied=1; fi
  fi
  if (( ! copied )); then
    rm -rf "$STAGE_DIR/dist" 2>/dev/null || true
    cp -R "$REPO_ROOT/dist" "$STAGE_DIR/dist" || return 1
  fi
  ln -sfn "$REPO_ROOT/node_modules" "$STAGE_DIR/node_modules" || return 1
  # getVersion() walks UP from dist/cli.js for the nearest package.json; a stage
  # without one reports 0.0.0 and every version-gated builtin plugin turns off.
  cp "$REPO_ROOT/package.json" "$STAGE_DIR/package.json" || return 1
}

# A stage that never became the running server is trash on exit (smoke failure,
# staging failure, aborted deploy). One that DID launch stays: the server reads
# web assets from it per-request for its whole lifetime.
stage_cleanup() {
  if [[ -n "${STAGE_DIR:-}" && "$STAGE_IN_USE" != "1" ]]; then
    rm -rf "$STAGE_DIR" 2>/dev/null || true
  fi
}

if ! stage_dist; then
  # Pre-kill: the old server is still serving. A staging failure usually means
  # the disk is full — this deploy would only get worse past this point.
  rm -rf "$STAGE_DIR" 2>/dev/null || true
  echo "Failed to stage dist at $STAGE_DIR (disk full?); deploy aborted, prod untouched." >&2
  exit 1
fi
CLI_JS="$STAGE_DIR/dist/cli.js"
echo "Staged dist for boot: $CLI_JS"

# ── Pre-kill smoke boot ─────────────────────────────────────────────────────
# 2026-08-22/23 outages: a dist built from a broken working tree hangs in module
# init and never binds — but the old flow only discovered that AFTER killing the
# healthy prod server, so a bad build meant prod down until a human intervened.
# Boot the freshly built dist ONCE, fully isolated, BEFORE touching prod: if it
# can't serve /api/config (serveable the instant the port binds), fail the
# deploy here with the old server still serving.
# Isolation notes (each learned from source, not guessed):
#   - temp home must NOT match {tmpdir}/open-walnut-* — resolveOpenWalnutHome()
#     silently reverts such paths to ~/.open-walnut for non-ephemeral processes,
#     which would boot the smoke server ON PROD DATA.
#   - WALNUT_DAEMON_DIR must be overridden too, else the smoke server attaches
#     to (or version-bump RESTARTS) the production local daemon.
#   - the smoke server spawns a detached local daemon; reap it via daemon.pid
#     (parent-liveness heartbeat is only a ≤30s backstop, tightened via env).
SMOKE_SECS="${WALNUT_DEVPROD_SMOKE_SECS:-120}"
SMOKE_LOG="${TMPDIR:-/tmp}/open-walnut-devprod-smoke.log"
SMOKE_PID=""
SMOKE_TMP=""

smoke_cleanup() {
  if [[ -n "$SMOKE_PID" ]] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -15 "$SMOKE_PID" 2>/dev/null || true
    for _ in {1..10}; do
      kill -0 "$SMOKE_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$SMOKE_PID" 2>/dev/null; then
      kill -9 "$SMOKE_PID" 2>/dev/null || true
    fi
  fi
  SMOKE_PID=""
  # The smoke server's local daemon detaches and outlives it; its own heartbeat
  # would reap it within seconds, this makes cleanup immediate. Input floor:
  # never signal pid <= 1, and only a process that still looks like a daemon.
  if [[ -n "$SMOKE_TMP" && -f "$SMOKE_TMP/daemon/daemon.pid" ]]; then
    dpid="$(cat "$SMOKE_TMP/daemon/daemon.pid" 2>/dev/null || true)"
    if [[ "$dpid" =~ ^[0-9]+$ ]] && (( 10#$dpid > 1 )) && kill -0 "$dpid" 2>/dev/null; then
      dcmd="$(ps -o command= -p "$dpid" 2>/dev/null || true)"
      case "$dcmd" in
        *daemon*|*open-walnut*)
          kill -15 "$dpid" 2>/dev/null || true
          for _ in {1..6}; do
            kill -0 "$dpid" 2>/dev/null || break
            sleep 0.5
          done
          if kill -0 "$dpid" 2>/dev/null; then
            kill -9 "$dpid" 2>/dev/null || true
          fi
          ;;
      esac
    fi
  fi
  if [[ -n "$SMOKE_TMP" ]]; then
    rm -rf "$SMOKE_TMP" 2>/dev/null || true
  fi
  SMOKE_TMP=""
}
trap 'smoke_cleanup; stage_cleanup; release_lock' EXIT

# Distinct from listener_pids so that function's tested contract stays untouched.
port_is_free() {
  case "$PORT_PROBE" in
    lsof)  [[ -z "$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)" ]] ;;
    ss)    ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN ;;
    fuser) ! fuser -n tcp "$1" >/dev/null 2>&1 ;;
  esac
}

if [[ "${WALNUT_DEVPROD_SKIP_SMOKE:-0}" != "1" ]]; then
  smoke_port=""
  for cand in $(( 20000 + $$ % 20000 )) $(( 20001 + $$ % 20000 )) $(( 20002 + $$ % 20000 )); do
    if port_is_free "$cand"; then smoke_port="$cand"; break; fi
  done
  if [[ -z "$smoke_port" ]]; then
    echo "Smoke boot skipped: no free probe port found (machine state is odd)." >&2
  else
    SMOKE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/walnut-smoke.XXXXXX")"
    mkdir -p "$SMOKE_TMP/home" "$SMOKE_TMP/daemon"
    : > "$SMOKE_LOG"
    env -u VITEST -u OPEN_WALNUT_EPHEMERAL -u WALNUT_STREAMS_DIR \
      OPEN_WALNUT_HOME="$SMOKE_TMP/home" \
      WALNUT_DAEMON_DIR="$SMOKE_TMP/daemon" \
      WALNUT_DISABLE_SEARCH=1 \
      WALNUT_DAEMON_HEARTBEAT_MS=2000 \
      "$NODE_BIN" "$CLI_JS" web --port "$smoke_port" \
      >>"$SMOKE_LOG" 2>&1 &
    SMOKE_PID=$!
    smoke_ok=0
    for _ in $(seq 1 $(( SMOKE_SECS * 2 ))); do
      if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
        break
      fi
      if curl --connect-timeout 1 --max-time 2 -sf \
        "http://localhost:$smoke_port/api/config" >/dev/null 2>&1; then
        smoke_ok=1
        break
      fi
      sleep 0.5
    done
    # ── Smoke render: does `/` actually paint? ──────────────────────────────
    # /api/config proves the server booted; it says nothing about the SPA.
    # 2026-09-02 a dist whose bundle threw on first render passed this block and
    # took the home page down in every browser. Load `/` once in a headless
    # browser against the SAME isolated smoke server. Three-valued on purpose:
    # a definitive crash (error boundary fired / banner shown / #root empty)
    # fails the deploy with prod untouched; "could not tell" (no browser, page
    # never settled under machine load) proceeds with a warning, because a
    # deploy blocked by an overloaded Mac is its own outage. Set
    # WALNUT_DEVPROD_RENDER_STRICT=1 to fail closed on doubt too.
    smoke_render_rc=0
    if [[ "$smoke_ok" == "1" && "${WALNUT_DEVPROD_SKIP_RENDER:-0}" != "1" ]]; then
      RENDER_SECS="${WALNUT_DEVPROD_RENDER_SECS:-60}"
      "$NODE_BIN" "$REPO_ROOT/scripts/devprod-render-check.mjs" \
        "http://localhost:$smoke_port/" --timeout-ms "$(( RENDER_SECS * 1000 ))" \
        || smoke_render_rc=$?
      if [[ "$smoke_render_rc" == "2" && "${WALNUT_DEVPROD_RENDER_STRICT:-0}" != "1" ]]; then
        echo "Smoke render UNDETERMINED — proceeding (WALNUT_DEVPROD_RENDER_STRICT=1 fails closed here)." >&2
        smoke_render_rc=0
      fi
    fi
    smoke_cleanup
    if [[ "$smoke_ok" != "1" ]]; then
      echo "Smoke boot FAILED: fresh dist did not serve /api/config within ${SMOKE_SECS}s." >&2
      echo "Production server on :$PORT was NOT touched. Smoke log tail ($SMOKE_LOG):" >&2
      tail -n 25 "$SMOKE_LOG" >&2 || true
      exit 1
    fi
    if [[ "$smoke_render_rc" != "0" ]]; then
      echo "Smoke render FAILED: fresh dist serves /api/config but crashes on the first paint of /." >&2
      echo "Production server on :$PORT was NOT touched. Fix the render error above" >&2
      echo "(WALNUT_DEVPROD_SKIP_RENDER=1 skips this check for emergencies)." >&2
      exit 1
    fi
    echo "Smoke boot OK: fresh dist binds, serves, and paints /."
  fi
fi

# LAST thing before the outgoing server is stopped. Deliberately after the build
# and the smoke boot (those take minutes — draining first would just let new turns
# start), and before `launchctl remove`, which is itself a kill.
drain_active_turns

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
  # Only OUR production server; never an ephemeral/test instance. Three launch
  # shapes over time: repo dist (old deploys), staged dist (current deploys),
  # LKG dist (rollback servers).
  if [[ "$cmd" != *"$REPO_ROOT/dist/cli.js"* \
     && "$cmd" != *"open-walnut-stage."*"/dist/cli.js"* \
     && "$cmd" != *"open-walnut-lkg/dist/cli.js"* ]]; then
    continue
  fi
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

# Every prior server is dead at this point, so no process is serving web assets
# out of an older stage — safe to reap them all. (Reaping earlier would yank
# static files out from under the still-running prod server; failed deploys
# exit before reaching here and leave old stages alone.)
#
# "Dead" above is a conclusion drawn from lsof/ss and pgrep. On 2026-09-02 that
# conclusion was wrong and this loop deleted the stage of the LIVE :3456 server:
# node had cli.js in memory, so the API kept answering while every web asset
# 404ed (`ENOENT … /dist/web/static/index.html`) for four hours, which reached
# the user as "the Mac app is laggy". The static root is per-request state, so
# nothing recovers it — the only fix is to never delete a directory a running
# process is executing from. Ask the process table directly, per stage.
# Matched on the stage's BASENAME, never its full path: TMPDIR here ends in a
# slash, so a server's own command line reads `…/T//open-walnut-stage.X/dist/cli.js`
# (double slash) and `/private/var/…` vs `/var/…` differ by a symlink too — a
# full-path substring test looked correct and matched NOTHING, which is how this
# guard would have failed silently exactly when it was needed. The basename
# (`open-walnut-stage.<epoch>.<pid>`) is unique per deploy.
stage_has_live_process() {
  local stage="$1" spid cmd base
  base="$(basename "$stage")"
  for spid in $(pgrep -f 'dist/cli\.js' 2>/dev/null || true); do
    [[ -n "$spid" ]] || continue
    cmd="$(ps -o command= -p "$spid" 2>/dev/null || true)"
    if [[ "$cmd" == *"$base/dist/cli.js"* ]]; then
      echo "$spid"
      return 0
    fi
  done
  return 1
}

for old_stage in "$STAGE_ROOT"/open-walnut-stage.*; do
  if [[ ! -d "$old_stage" || "$old_stage" == "$STAGE_DIR" ]]; then
    continue
  fi
  live_pid="$(stage_has_live_process "$old_stage" || true)"
  if [[ -n "$live_pid" ]]; then
    echo "Keeping stage $old_stage: PID $live_pid is still running from it." >&2
    continue
  fi
  rm -rf "$old_stage" 2>/dev/null || true
done

# Rollback source: a dist snapshot taken only AFTER a deploy passes readiness.
LKG_DIR="${WALNUT_DEVPROD_LKG_DIR:-${TMPDIR:-/tmp}/open-walnut-lkg}"

# One launchctl submit for the given cli.js. launchd gives jobs a minimal PATH
# (/usr/bin:/bin:...) — pass the caller's full PATH through so child tools
# (ffmpeg, git, ssh, brew, agent CLIs) resolve exactly as they would from the
# deploying shell.
submit_launchd_job() {
  # Callers hold use_launchd=1 (Darwin-only); the guard keeps the helper inert
  # if one is ever added on another path.
  [[ "$(uname -s)" == "Darwin" ]] || return 1
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
    "$NODE_BIN" "$1" web --port "$PORT"
}

# The job's live PID — empty when the label is registered but has no process.
launchd_job_pid() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  launchctl list "$LAUNCH_LABEL" 2>/dev/null \
    | sed -n 's/.*"PID" = \([0-9][0-9]*\);.*/\1/p' | head -n 1
}

remove_launchd_job() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
}

# Launch a server for the given cli.js on :$PORT — launchd (KeepAlive, nice 0)
# on macOS, nohup elsewhere. Sets the global `pid` on the nohup path.
launch_server() {
  local cli_js="$1"
  pid=""
  if (( use_launchd )); then
    if ! submit_launchd_job "$cli_js"; then
      # Still on the use_launchd path: degrade to nohup rather than abort.
      echo "launchd submit failed outright; falling back to nohup." >&2
      use_launchd=0
    # use_launchd path: prove the submit actually registered. 2026-08-23: a
    # submit from one shell context silently created NOTHING (no job, no
    # process, zero log bytes) and the readiness window burned 180s probing a
    # server that never existed. Fall back to nohup; flipping use_launchd keeps
    # stop_new_server and the readiness death-check pointed at the right thing.
    elif ! launchctl list "$LAUNCH_LABEL" >/dev/null 2>&1; then
      echo "launchctl submit did not register '$LAUNCH_LABEL'; falling back to nohup." >&2
      use_launchd=0
    else
      # Registered is NOT spawned. 2026-08-27 (twice, morning + evening): the
      # job existed but launchd never gave it a process — zero output, zero
      # exit-trap line, while the very next submit of the same label spawned
      # instantly. Poll for a real PID; if none appears, retry the submit once,
      # then degrade to nohup (a direct fork can't silently no-spawn).
      spawned=""
      for attempt in 1 2; do
        for _ in {1..10}; do
          spawned="$(launchd_job_pid)"
          [[ -n "$spawned" ]] && break
          sleep 0.5
        done
        if [[ -n "$spawned" ]]; then break; fi
        echo "launchd job '$LAUNCH_LABEL' registered but never spawned (attempt $attempt); resubmitting." >&2
        remove_launchd_job
        sleep 1
        if (( attempt == 2 )) || ! submit_launchd_job "$cli_js"; then
          break
        fi
      done
      if [[ -z "$spawned" ]]; then
        echo "launchd would not spawn '$LAUNCH_LABEL'; falling back to nohup." >&2
        remove_launchd_job
        use_launchd=0
      fi
    fi
  fi
  if (( ! use_launchd )); then
    nohup env -u OPEN_WALNUT_EPHEMERAL \
      -u OPEN_WALNUT_HOME \
      -u WALNUT_DAEMON_DIR \
      -u VITEST \
      "$NODE_BIN" "$cli_js" web --port "$PORT" \
      </dev/null >>"$SERVER_LOG" 2>&1 &
    pid=$!
  fi
}

# Bounded /api/config poll used by the rollback path (the primary readiness
# loop below also checks the server's nice level; rollback only needs alive).
wait_for_config_ready() {
  local secs="$1"
  for _ in $(seq 1 $(( secs * 2 ))); do
    if (( ! use_launchd )) && [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if curl --connect-timeout 1 --max-time 2 -sf \
      "http://localhost:$PORT/api/config" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Best-effort dist snapshot for rollback. Clonefile (cp -c) is ~instant on
# APFS; plain cp -R elsewhere. node_modules rides as a symlink to the repo's —
# the bundle resolves native/spawned deps from there, same as a repo launch.
snapshot_lkg() {
  rm -rf "$LKG_DIR.tmp" 2>/dev/null || true
  mkdir -p "$LKG_DIR.tmp" || return 1
  local copied=0
  # Snapshot from the STAGE, not the repo: it is the exact artifact that just
  # passed readiness (byte-identical by construction), and the temp volume is
  # exempt from the on-access scanners that stall /Users reads under load.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if cp -Rc "$STAGE_DIR/dist" "$LKG_DIR.tmp/dist" 2>/dev/null; then copied=1; fi
  fi
  if (( ! copied )); then
    rm -rf "$LKG_DIR.tmp/dist" 2>/dev/null || true
    cp -R "$STAGE_DIR/dist" "$LKG_DIR.tmp/dist" || return 1
  fi
  ln -sfn "$REPO_ROOT/node_modules" "$LKG_DIR.tmp/node_modules" || return 1
  # Same reason as stage_dist: without a package.json the LKG boots as 0.0.0.
  cp "$REPO_ROOT/package.json" "$LKG_DIR.tmp/package.json" || return 1
  rm -rf "$LKG_DIR" 2>/dev/null || true
  mv "$LKG_DIR.tmp" "$LKG_DIR" || return 1
}

# First-output baseline: a candidate that appends NOTHING to the server log is
# a process that never started (launchctl submit registering nothing, instant
# module-init death) — judged in seconds below, not after the whole window.
server_log_baseline="$(wc -c < "$SERVER_LOG" 2>/dev/null | tr -d '[:space:]' || echo 0)"

STAGE_IN_USE=1
launch_server "$CLI_JS"

stop_new_server() {
  if (( use_launchd )); then
    launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
  elif [[ -n "$pid" ]]; then
    kill -15 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

# ── Last-known-good rollback ── shared by EVERY post-kill failure exit. The
# old server is already dead by the time any of these run, so exiting without
# restoring service leaves :$PORT dark until a human notices (2026-08-23:
# 7.5 min of prod down after a readiness failure — and the process-death and
# nice-abort exits had the same hole with no rollback at all). The deploy
# still FAILS (callers exit 1); this only restores service with the last dist
# that passed readiness. If the rollback server is slow, it is left running
# (launchd KeepAlive / nohup) rather than killed — availability wins.
rollback_to_lkg() {
  if [[ -f "$LKG_DIR/dist/cli.js" ]]; then
    echo "Rolling back to last-known-good dist: $LKG_DIR/dist" >&2
    launch_server "$LKG_DIR/dist/cli.js"
    if wait_for_config_ready 90; then
      echo "Rollback server is serving on :$PORT (this deploy itself still failed)." >&2
    else
      echo "Rollback server not ready after 90s; left running in case it settles late." >&2
    fi
  else
    echo "No last-known-good dist at $LKG_DIR; :$PORT is left unserved." >&2
  fi
}

# Readiness window, default 180s (override: WALNUT_DEVPROD_READY_SECS). The old
# 60s window was SMALLER than a real boot under machine load: 2026-08-22, two
# consecutive deploys each started a healthy server, hit the 60s ceiling while
# it was still initializing (~90s at load 30-50), and killed it — prod stayed
# down not because anything failed but because the deploy gave up too early.
# The check stays bounded; it just has to outlast the slowest observed boot
# with real margin.
READY_SECS="${WALNUT_DEVPROD_READY_SECS:-180}"
# Fast-fail judge: 2026-08-27, a candidate that never existed (silent launchctl
# submit) burned the full 180s window while :$PORT stayed dark. Zero bytes of
# output this far in means zero chance of readiness — roll back in seconds.
FIRSTLOG_SECS="${WALNUT_DEVPROD_FIRSTLOG_SECS:-15}"
ready=0
elapsed_halves=0
for _ in $(seq 1 $(( READY_SECS * 2 ))); do
  elapsed_halves=$(( elapsed_halves + 1 ))
  if (( ! use_launchd )) && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" || true
    echo "Server process exited before becoming ready." >&2
    rollback_to_lkg
    exit 1
  fi
  if (( elapsed_halves == FIRSTLOG_SECS * 2 )); then
    server_log_now="$(wc -c < "$SERVER_LOG" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    if [[ "$server_log_now" == "$server_log_baseline" ]]; then
      stop_new_server
      echo "No server output after ${FIRSTLOG_SECS}s — the process never started." >&2
      rollback_to_lkg
      exit 1
    fi
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
      # The rollback launches from this same (niced) shell, so it may inherit
      # the nice too — degraded scheduling still beats a dark port.
      rollback_to_lkg
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
  rollback_to_lkg
  exit 1
fi

# /api/config answers out of memory; it says nothing about whether the web app
# can be LOADED. 2026-09-02: the live server's staged dist was deleted under it,
# so `/` and every hashed asset 404ed while /api/config stayed green — the app
# only kept working in already-open windows, and a reload would have shown a raw
# ENOENT. Prove the SPA entry is servable, and name the static root when it is
# not (that is the whole diagnosis).
index_html="$(curl --connect-timeout 1 --max-time 5 -sf "http://localhost:$PORT/" 2>/dev/null || true)"
case "$index_html" in
  *"<script"*"assets/index-"*) ;;
  *)
    stop_new_server
    echo "Server answers /api/config but cannot serve the web app from $STAGE_DIR/dist/web/static." >&2
    echo "First 200 bytes of GET /: ${index_html:0:200}" >&2
    rollback_to_lkg
    exit 1
    ;;
esac

if ! snapshot_lkg; then
  echo "Warning: last-known-good snapshot failed; rollback will use the previous one." >&2
fi

pid="$(listener_pids | head -n 1)"
date +%s > "$SUCCESS_STAMP"
echo "Server ready (PID: $pid)"
