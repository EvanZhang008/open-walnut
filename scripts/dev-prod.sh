#!/usr/bin/env bash
set -euo pipefail

# What runs: by default the compiled walnut file (`bun scripts/build-binary.mjs`,
# docs/plan/walnut-single-binary.md), built for this machine plus the Linux
# targets host servers take, staged on the temp volume and started as
# `<stage>/dist-bin/walnut-<target> web --port 3456`; its runtime tree (the web
# app, data files) is unpacked into `<stage>/runtime/`. WALNUT_DEVPROD_RUNTIME=node
# deploys the Node build instead (`node <stage>/dist/cli.js web`), the way every
# deploy did before; it stays for one release as the way back from a bad file.
# The `bun run web:build` dist is built in both modes: the walnut CLI on this
# machine runs the op registry from it (see the publish step at the end), and
# the file reuses its web assets, so both name the same hashed bundles.

# Dry run: execute every guard, then stop before the first mutating step (build,
# server kill, launchd submit). CI runs this on Linux so a macOS-only assumption
# in the deploy path fails a push instead of an actual deploy — the class of bug
# behind issue #11. The port override is honoured ONLY in dry-run and in a
# rehearsal (below): a real deploy on another port would put a second server on
# the production data dir, which is a task-deletion shape here.
DRY_RUN="${WALNUT_DEVPROD_DRY_RUN:-0}"
REHEARSAL="${WALNUT_DEVPROD_REHEARSAL:-0}"
PORT=3456
if [[ "$DRY_RUN" == "1" ]]; then
  PORT="${WALNUT_DEVPROD_PORT:-$PORT}"
fi
# Plain /tmp, not /private/tmp: on macOS /tmp is a symlink to /private/tmp so this
# is the same inode as before (existing log, existing fds, unchanged), while Linux
# — where /private/tmp does not exist — can finally write it. The old hardcoded
# macOS path made a Linux deploy kill the running server and then fail to start
# its replacement, leaving prod down (issue #11, Unraid x64).
SERVER_LOG="${WALNUT_SERVER_LOG:-/tmp/open-walnut-launchd.log}"
LAUNCH_LABEL=com.open-walnut.dev-prod

# ── Rehearsal: the whole real deploy, away from production ──────────────────
# WALNUT_DEVPROD_REHEARSAL=1 runs every step for real (build, smoke, kill and
# launch, readiness, last-known-good, rollback) on a private port, data dir,
# daemon dir and temp dir, under its own launchd label, so the deploy path itself
# can be proven end to end. It refuses :3456 and :3457, the production data dir
# and the production daemon dirs, it stops only a listener that runs from its own
# stages or LKG, and everything it writes lives in the directories it is given.
# Required:
#   WALNUT_DEVPROD_PORT          the port (not 3456, production; not 3457, the
#                                Playwright fixture server)
#   WALNUT_DEVPROD_REHEARSAL_DIR an existing directory: its rehearsal-state/ subdir,
#                                made here, becomes TMPDIR (lock, stamps, stages,
#                                smoke, LKG, log), so no state file can ever be a
#                                production one, whatever the caller's TMPDIR is
#   OPEN_WALNUT_HOME             the data dir (never ~/.open-walnut, never named open-walnut-*)
#   WALNUT_DAEMON_DIR            the daemon dir (never /tmp/open-walnut or ~/.cache/open-walnut;
#                                the daemon also keeps <daemon dir>-streams beside it)
# Optional knobs for the failure paths: WALNUT_DEVPROD_REHEARSAL_FAIL_LAUNCH=1
# starts the new server unable to serve the web app (the post-kill rollback to
# the last-known-good build runs); WALNUT_DEVPROD_REHEARSAL_FAIL_SMOKE=1 makes
# the smoke boot fail (nothing is killed).
REHEARSAL_HOME=""
REHEARSAL_DAEMON_DIR=""
REHEARSAL_ROOT=""
if [[ "$REHEARSAL" == "1" ]]; then
  PORT="${WALNUT_DEVPROD_PORT:-}"
  if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( 10#$PORT < 1024 || 10#$PORT > 65535 )) || (( 10#$PORT == 3456 || 10#$PORT == 3457 )); then
    echo "Rehearsal refused: WALNUT_DEVPROD_PORT='$PORT' must be a port from 1024 to 65535 other than 3456 (production) and 3457 (the Playwright fixture server)." >&2
    exit 1
  fi
  PORT=$(( 10#$PORT ))
  rehearsal_dir="${WALNUT_DEVPROD_REHEARSAL_DIR:-}"
  if [[ "$rehearsal_dir" != /* || ! -d "$rehearsal_dir" ]]; then
    echo "Rehearsal refused: WALNUT_DEVPROD_REHEARSAL_DIR must be an existing absolute directory." >&2
    exit 1
  fi
  # The physical path of a dir that need not exist yet (its parent must): every
  # check runs on it BEFORE anything is created, so a refused run makes nothing.
  canon_dir() {
    if [[ -d "$1" ]]; then (cd "$1" && pwd -P); return; fi
    local parent
    parent="$(dirname "$1")"
    [[ -d "$parent" ]] || return 1
    printf '%s/%s' "$(cd "$parent" && pwd -P)" "$(basename "$1")"
  }
  REHEARSAL_HOME="${OPEN_WALNUT_HOME:-}"
  REHEARSAL_DAEMON_DIR="${WALNUT_DAEMON_DIR:-}"
  if [[ "$REHEARSAL_HOME" != /* || "$REHEARSAL_DAEMON_DIR" != /* ]]; then
    echo "Rehearsal refused: set OPEN_WALNUT_HOME and WALNUT_DAEMON_DIR to absolute private paths." >&2
    exit 1
  fi
  if ! REHEARSAL_HOME="$(canon_dir "$REHEARSAL_HOME")" || ! REHEARSAL_DAEMON_DIR="$(canon_dir "$REHEARSAL_DAEMON_DIR")"; then
    echo "Rehearsal refused: the parents of OPEN_WALNUT_HOME and WALNUT_DAEMON_DIR must exist." >&2
    exit 1
  fi
  prod_home="$(canon_dir "$HOME/.open-walnut" || printf '%s' "$HOME/.open-walnut")"
  case "$REHEARSAL_HOME/" in
    "$prod_home/"*)
      echo "Rehearsal refused: OPEN_WALNUT_HOME is the production data dir (or inside it): $REHEARSAL_HOME" >&2
      exit 1 ;;
  esac
  # resolveOpenWalnutHome() (src/constants.ts) reverts a temp-dir home named
  # open-walnut-* to ~/.open-walnut for any process that is not an ephemeral child.
  if [[ "$(basename "$REHEARSAL_HOME")" == open-walnut* ]]; then
    echo "Rehearsal refused: a data dir named open-walnut* can be read as a leaked ephemeral dir and swapped for the production one." >&2
    exit 1
  fi
  # /tmp is a symlink on macOS: compare with both spellings of the production dirs.
  # ~/.cache/open-walnut is where a host's daemon goes when /tmp cannot take it, and
  # a daemon there treats itself as production (daemon-standalone.ts IS_PROD_DAEMON_DIR).
  tmp_real="$(cd /tmp && pwd -P)"
  prod_cache_daemon="$(canon_dir "$HOME/.cache/open-walnut" || printf '%s' "$HOME/.cache/open-walnut")"
  for prod_daemon in /tmp/open-walnut "$tmp_real/open-walnut" "$HOME/.cache/open-walnut" "$prod_cache_daemon"; do
    case "$REHEARSAL_DAEMON_DIR/" in
      "$prod_daemon/"*)
        echo "Rehearsal refused: WALNUT_DAEMON_DIR is a production daemon dir (or inside one): $REHEARSAL_DAEMON_DIR" >&2
        exit 1 ;;
    esac
  done
  # Its own state dir, never the caller's TMPDIR itself: a deploy's lock, cooldown
  # stamps and LKG are named files in TMPDIR, so a rehearsal handed the same dir as
  # production would take production's lock, arm its cooldown and replace its
  # rollback build.
  REHEARSAL_ROOT="$(cd "$rehearsal_dir" && pwd -P)"
  TMPDIR="$REHEARSAL_ROOT/rehearsal-state"
  export TMPDIR
  LAUNCH_LABEL="com.open-walnut.dev-prod-rehearsal.$PORT"
  # Never the production server log.
  SERVER_LOG="${WALNUT_SERVER_LOG:-$TMPDIR/open-walnut-launchd.log}"
  if [[ "$SERVER_LOG" == /tmp/open-walnut-launchd.log* || "$SERVER_LOG" == "$tmp_real"/open-walnut-launchd.log* ]]; then
    echo "Rehearsal refused: WALNUT_SERVER_LOG is the production server log." >&2
    exit 1
  fi
  # The rollback snapshot is replaced whole on success: a rehearsal keeps its own
  # in its state dir, never one it is pointed at.
  if [[ -n "${WALNUT_DEVPROD_LKG_DIR:-}" ]]; then
    echo "Rehearsal refused: a rehearsal keeps its LKG in $TMPDIR; unset WALNUT_DEVPROD_LKG_DIR." >&2
    exit 1
  fi
  mkdir -p "$TMPDIR" "$REHEARSAL_HOME" "$REHEARSAL_DAEMON_DIR"
  echo "Rehearsal: the real deploy path on :$PORT (data $REHEARSAL_HOME, daemon $REHEARSAL_DAEMON_DIR, temp $TMPDIR, label $LAUNCH_LABEL)."
fi

LOCK_DIR="${TMPDIR:-/tmp}/open-walnut-dev-prod.lock"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The checkout the server RUNS AS: its working directory, the node_modules the
# staged dist resolves from, and the source repo it reports ("Fix Walnut" works
# there). REPO_ROOT is what gets type-checked and built. They differ only when
# scripts/deploy-committed.sh builds the committed HEAD in a clean clone, so a
# shared working tree's uncommitted files never ship, while the server keeps
# running as the real checkout.
SERVE_ROOT="${WALNUT_DEVPROD_SERVE_ROOT:-$REPO_ROOT}"
if [[ ! -f "$SERVE_ROOT/package.json" || ! -d "$SERVE_ROOT/node_modules" ]]; then
  echo "WALNUT_DEVPROD_SERVE_ROOT is not a Walnut checkout with node_modules: $SERVE_ROOT" >&2
  exit 1
fi
SERVE_ROOT="$(cd "$SERVE_ROOT" && pwd -P)"
SUCCESS_STAMP="${TMPDIR:-/tmp}/open-walnut-dev-prod.last-success"
ATTEMPT_STAMP="${TMPDIR:-/tmp}/open-walnut-dev-prod.last-attempt"
# Rollback source: a snapshot of the build that passed readiness (snapshot_lkg).
# It is kept off the temp dir (2026-10-25: a restart emptied /tmp, and the first
# deploy after a reboot had nothing to roll back to); rollback_to_lkg stages a
# copy on the temp volume before it boots one, for the scanner reason at
# STAGE_ROOT. The old temp location is still read until the first snapshot lands
# here. A rehearsal keeps its own in its state dir: ~/.local/state is production's.
if [[ "$REHEARSAL" == "1" ]]; then
  LKG_DIR="$TMPDIR/open-walnut-lkg"
else
  LKG_DIR="${WALNUT_DEVPROD_LKG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/open-walnut/open-walnut-lkg}"
fi
LKG_LEGACY_DIR="${TMPDIR:-/tmp}"
LKG_LEGACY_DIR="${LKG_LEGACY_DIR%/}/open-walnut-lkg"
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
# BusyBox (Alpine) ships applets under these names that take none of the options
# used here: its lsof ignores them and lists every open file of the box, its
# fuser has no -n, its ps no -p. A probe that misreads is worse than none, so an
# applet does not count. Captured, not piped: under pipefail a `| grep -q` that
# matches early fails the pipeline with SIGPIPE.
is_busybox() {
  local out
  command -v "$1" >/dev/null 2>&1 || return 1
  out="$("$1" --help </dev/null 2>&1 || true)"
  [[ "$out" == *BusyBox* ]]
}
PORT_PROBE=""
for probe in lsof ss fuser; do
  if command -v "$probe" >/dev/null 2>&1 && ! is_busybox "$probe"; then PORT_PROBE="$probe"; break; fi
done
if [[ -z "$PORT_PROBE" ]]; then
  echo "Need one of lsof / ss / fuser (not BusyBox's) to tell whether :$PORT is already served." >&2
  echo "Install one (e.g. iproute2 for ss) and retry." >&2
  exit 1
fi
if is_busybox ps; then
  echo "ps here is BusyBox's, which cannot look up one process (-p); every server check needs that." >&2
  echo "Install procps and retry." >&2
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

# ── A rehearsal stops only what it started ──────────────────────────────────
# Its port is any free one the caller picked, so whatever else listens there (a
# test fixture server, a demo, another agent's server) is not its to stop: every
# listener must run from one of this rehearsal's stages or its LKG, which its
# command line names. Checked here, before anything is built, and again right
# before the kill.
rehearsal_owns_pid() {
  local cmd
  cmd="$(ps -o command= -p "$1" 2>/dev/null || true)"
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd" == *"$TMPDIR/open-walnut-stage."* || "$cmd" == *"$LKG_DIR/"* ]]
}
rehearsal_refuse_foreign_listeners() {
  [[ "$REHEARSAL" == "1" ]] || return 0
  local lpid
  for lpid in $(listener_pids); do
    if ! rehearsal_owns_pid "$lpid"; then
      echo "Rehearsal refused: :$PORT is served by PID $lpid, which this rehearsal did not start:" >&2
      echo "  $(ps -o command= -p "$lpid" 2>/dev/null || echo '(gone)')" >&2
      echo "Pick a free port." >&2
      exit 1
    fi
  done
}
rehearsal_refuse_foreign_listeners

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

# ── Runtime and tools ───────────────────────────────────────────────────────
# Decided before anything is touched, so a missing tool fails the deploy (and
# the dry run) with the old server still serving.
RUNTIME="${WALNUT_DEVPROD_RUNTIME:-file}"
case "$RUNTIME" in
  file|node) ;;
  *)
    echo "WALNUT_DEVPROD_RUNTIME='$RUNTIME' is neither file (the compiled walnut file) nor node." >&2
    exit 1 ;;
esac

# `command -v` exits 1 when the tool is missing: `|| true` keeps `set -e` from
# ending the script on a box without node, which file mode does not need.
NODE_BIN="$(command -v node || true)"

# The bun package.json pins (packageManager "bun@X.Y.Z"), or empty.
bun_pin() {
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    "$REPO_ROOT/package.json" 2>/dev/null | head -n 1
  return 0
}

# True when version $1 is $2 or newer (both X.Y.Z).
version_at_least() {
  local IFS=. i
  local -a a b
  read -r -a a <<< "$1"
  read -r -a b <<< "$2"
  for i in 0 1 2; do
    if (( 10#${a[i]:-0} != 10#${b[i]:-0} )); then
      (( 10#${a[i]:-0} > 10#${b[i]:-0} ))
      return
    fi
  done
  return 0
}

# A bun of the pinned version or newer: $WALNUT_BUN, PATH, then the usual
# install places (the same order as src/core/host-server/host-file-build.ts).
# The compiled file carries the runtime of the bun that built it, so an older
# bun would ship an older runtime than the code was written for. Sets BUN_BIN
# and BUN_VERSION (empty when none fits) and BUN_SEEN (what else was found).
find_bun() {
  local pin cand v dir tried="|"
  local -a cands=()
  pin="$(bun_pin)"
  BUN_BIN="" BUN_VERSION="" BUN_SEEN=""
  if [[ -n "${WALNUT_BUN:-}" ]]; then cands+=("$WALNUT_BUN"); fi
  local IFS=:
  for dir in $PATH; do
    if [[ -n "$dir" ]]; then cands+=("$dir/bun"); fi
  done
  unset IFS
  cands+=("$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun)
  for cand in "${cands[@]}"; do
    [[ "$cand" == /* && -x "$cand" && ! -d "$cand" ]] || continue
    [[ "$tried" != *"|$cand|"* ]] || continue
    tried="$tried$cand|"
    v="$("$cand" --version 2>/dev/null || true)"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || continue
    v="${BASH_REMATCH[0]}"
    if [[ -z "$pin" ]] || version_at_least "$v" "$pin"; then
      BUN_BIN="$cand"
      BUN_VERSION="$v"
      return 0
    fi
    BUN_SEEN="${BUN_SEEN:+$BUN_SEEN, }$v at $cand"
  done
  return 0
}

# The release target of THIS machine (scripts/build-binary.mjs TARGETS), or
# nothing when no compiled file is built for it. A shell under Rosetta reports
# x86_64 on an arm64 Mac: the native file is the one to run there.
self_target() {
  local os arch out loader
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) return 0 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) return 0 ;;
  esac
  if [[ "$os" == darwin && "$arch" == x64 && "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
    arch=arm64
  fi
  if [[ "$os" == linux ]]; then
    out="$(ldd --version 2>&1 || true)"
    for loader in /lib/ld-musl-*; do
      if [[ -e "$loader" ]]; then out="musl"; fi
    done
    if [[ "$out" == *musl* ]]; then
      printf '%s-%s-musl' "$os" "$arch"
      return 0
    fi
  fi
  printf '%s-%s' "$os" "$arch"
}

find_bun
# This machine's target, in both modes: a rollback can start a compiled file
# left by an earlier file deploy even while this one deploys the Node build.
MACHINE_TARGET="$(self_target)"
SELF_TARGET=""
if [[ "$RUNTIME" == "file" ]]; then
  if [[ -z "$BUN_BIN" ]]; then
    echo "Building the compiled walnut file needs bun $(bun_pin) or newer (package.json packageManager)." >&2
    if [[ -n "$BUN_SEEN" ]]; then echo "Found only: $BUN_SEEN." >&2; fi
    echo "Put a newer bun first on PATH or set WALNUT_BUN to it, or deploy the Node build: WALNUT_DEVPROD_RUNTIME=node." >&2
    exit 1
  fi
  SELF_TARGET="$MACHINE_TARGET"
  if [[ -z "$SELF_TARGET" ]]; then
    echo "No compiled walnut file is built for $(uname -s) $(uname -m); deploy the Node build: WALNUT_DEVPROD_RUNTIME=node." >&2
    exit 1
  fi
else
  if [[ -z "$NODE_BIN" ]]; then
    echo "WALNUT_DEVPROD_RUNTIME=node needs node on PATH." >&2
    exit 1
  fi
fi
# Runs the repo's own helper scripts (render check, publish): bun when there is
# one (Playwright included), else node.
JS_BIN="${BUN_BIN:-$NODE_BIN}"
if [[ -z "$JS_BIN" ]]; then
  echo "Need bun or node to run the deploy's helper scripts." >&2
  exit 1
fi
# The extra targets built beside this machine's file, from the same build, for
# host servers (src/core/host-server/). WALNUT_DEVPROD_FILE_TARGETS="" builds none.
FILE_TARGETS="${WALNUT_DEVPROD_FILE_TARGETS-linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl}"
if [[ "$RUNTIME" != "file" ]]; then FILE_TARGETS=""; fi
for t in $FILE_TARGETS; do
  if [[ ! "$t" =~ ^(darwin|linux)-(x64|arm64)(-musl)?$ ]]; then
    echo "WALNUT_DEVPROD_FILE_TARGETS: unknown target '$t'." >&2
    exit 1
  fi
done

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
# How long the outgoing server may take to exit after SIGTERM before SIGKILL
# (see the kill below). Its own bail is 4s; the rest is slack for a loaded Mac.
STOP_GRACE_SECS="${WALNUT_DEVPROD_STOP_GRACE_SECS:-8}"
if [[ ! "$STOP_GRACE_SECS" =~ ^[0-9]+$ ]]; then
  echo "WALNUT_DEVPROD_STOP_GRACE_SECS='$STOP_GRACE_SECS' is not a whole number of seconds; using 8." >&2
  STOP_GRACE_SECS=8
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

# What this deploy runs, in words, for the dry run and the log.
if [[ "$RUNTIME" == "file" ]]; then
  RUNTIME_DESC="the compiled file walnut-$SELF_TARGET (bun $BUN_VERSION at $BUN_BIN)"
else
  RUNTIME_DESC="node $NODE_BIN with dist/cli.js (WALNUT_DEVPROD_RUNTIME=node)"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  # Exercise the drain end to end without ever waiting: a dry run deploys
  # nothing, so a zero budget still proves the probe + parse + both proceed
  # branches run on this OS. WALNUT_DEVPROD_PORT normally points at a free port,
  # so this takes the "did not answer → proceed" arm.
  DRAIN_SECS=0
  drain_active_turns
  echo "[dry-run] every guard passed on $(uname -s) (probe: $PORT_PROBE, log: $SERVER_LOG)."
  echo "[dry-run] would run $RUNTIME_DESC${FILE_TARGETS:+, with $FILE_TARGETS beside it}."
  echo "[dry-run] helper scripts (type-check, render checks, publish) run on $JS_BIN; temp dir $TMPDIR."
  echo "[dry-run] stopping before build, server kill and launch — nothing was deployed."
  exit 0
fi
echo "Deploying $RUNTIME_DESC on :$PORT."

# ── Type-check the SPA before building it ───────────────────────────────────
# 2026-09-02: a deploy built the shared working tree while another agent was
# mid-refactor in a component (state variable deleted, a useMemo deps array
# still naming it). vite does not type-check, the smoke boot only asks for
# /api/config, so the bundle shipped and crashed on the first paint of `/` in
# every browser. `tsc --noEmit` on web/ names exactly that class of defect
# (`Cannot find name 'groupBy'`) in under a minute. A failure here is usually
# someone else's unfinished edit: wait for them or coordinate, and only reach
# for WALNUT_DEVPROD_SKIP_TSC=1 when the error is provably unrelated to `/`.
# tsc runs on $JS_BIN (bun when there is one): its own `#!/usr/bin/env node`
# line would need a node.
if [[ "${WALNUT_DEVPROD_SKIP_TSC:-0}" != "1" ]]; then
  WEB_TSC="$REPO_ROOT/web/node_modules/.bin/tsc"
  [[ -x "$WEB_TSC" ]] || WEB_TSC="$REPO_ROOT/node_modules/.bin/tsc"
  if [[ -x "$WEB_TSC" ]]; then
    echo "Type-checking web/ before the build (WALNUT_DEVPROD_SKIP_TSC=1 skips)."
    if ! (cd "$REPO_ROOT/web" && "$JS_BIN" "$WEB_TSC" --noEmit -p tsconfig.json); then
      echo "web/ type-check FAILED — deploy aborted, production server on :$PORT untouched." >&2
      echo "A half-edited component ships as a first-paint crash; fix (or wait for the" >&2
      echo "author of) the errors above, or WALNUT_DEVPROD_SKIP_TSC=1 if provably unrelated." >&2
      exit 1
    fi
  else
    echo "web/ type-check skipped: no tsc binary found under web/ or the repo root." >&2
  fi
fi

# ── Build ───────────────────────────────────────────────────────────────────
# The dist first (both modes): the server bundle, web assets, data files and
# daemon binaries. Its bun goes first on PATH for the build only, so every
# script under it (build-daemon.sh, bun run) uses the same bun.
if [[ -n "$BUN_BIN" ]]; then
  (cd "$REPO_ROOT" && PATH="$(dirname "$BUN_BIN"):$PATH" "$BUN_BIN" run web:build)
else
  (cd "$REPO_ROOT" && npm run web:build)
fi

# Then, in file mode, the compiled files from that dist's web assets
# (--reuse-web: the file and the dist name the same hashed bundles, so the
# web-asset mirror, src/web/static-mirror.ts, sees one build either way). This
# machine's target and the Linux ones come from ONE build-binary run, so every
# file names the same commit. A sibling is optional: when the run fails, this
# machine's file alone is built again, and a deploy without it aborts.
build_files() {
  local -a args=(--reuse-web --target "$SELF_TARGET")
  local t
  for t in "$@"; do
    if [[ "$t" != "$SELF_TARGET" ]]; then args+=(--target "$t"); fi
  done
  (cd "$REPO_ROOT" && PATH="$(dirname "$BUN_BIN"):$PATH" "$BUN_BIN" "$REPO_ROOT/scripts/build-binary.mjs" "${args[@]}")
}
BUILT_TARGETS=""
build_marker=""
SELFTEST_TMP=""
# Scratch this deploy makes before the smoke boot; also removed on any exit.
scratch_cleanup() {
  if [[ -n "${build_marker:-}" ]]; then rm -f "$build_marker" 2>/dev/null || true; fi
  if [[ -n "${SELFTEST_TMP:-}" ]]; then rm -rf "$SELFTEST_TMP" 2>/dev/null || true; fi
}
trap 'scratch_cleanup; release_lock' EXIT
if [[ "$RUNTIME" == "file" ]]; then
  build_marker="${TMPDIR:-/tmp}/open-walnut-dev-prod.build.$$"
  : > "$build_marker"
  # shellcheck disable=SC2086
  if build_files $FILE_TARGETS; then
    BUILT_TARGETS="$SELF_TARGET $FILE_TARGETS"
  elif [[ -n "$FILE_TARGETS" ]]; then
    echo "Building the files for $FILE_TARGETS failed; building walnut-$SELF_TARGET alone (host servers then fetch their own file)." >&2
    if ! build_files; then
      rm -f "$build_marker"
      echo "Building the compiled file failed: deploy aborted, production server on :$PORT untouched." >&2
      exit 1
    fi
    BUILT_TARGETS="$SELF_TARGET"
  else
    rm -f "$build_marker"
    echo "Building the compiled file failed: deploy aborted, production server on :$PORT untouched." >&2
    exit 1
  fi
fi

# ── Stage the build on the temp volume before ANY boot ──────────────────────
# 2026-08-27: four consecutive deploys burned their whole readiness window and
# rolled back — a byte-identical cli.js booted in ~1s from the LKG copy under
# /var/folders but produced not one log line in 6+ minutes when launched from
# the repo path under /Users. Cause: on-access endpoint scanners hold the
# first open of every freshly written file, and a deploy always boots a
# freshly built dist at the exact moment the machine (and the scan queue) is
# busiest. The temp volume is outside the scan scope, so EVERY boot this
# script performs (smoke AND prod) runs from a staged copy there, never from
# the repo path. Staging itself is clonefile (metadata-only, no content
# reads), so it cannot stall on the scanner either. The compiled file's
# runtime tree is unpacked there too (<stage>/runtime), not into the data home.
STAGE_ROOT="${TMPDIR:-/tmp}"
STAGE_DIR="$STAGE_ROOT/open-walnut-stage.$(date +%s).$$"
STAGE_IN_USE=0

# Copy one file or tree: clonefile on macOS (APFS: metadata only), plain cp elsewhere.
clone_copy() {
  if [[ "$(uname -s)" == "Darwin" ]] && cp -Rc "$1" "$2" 2>/dev/null; then
    return 0
  fi
  rm -rf "$2" 2>/dev/null || true
  cp -R "$1" "$2"
}

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
  ln -sfn "$SERVE_ROOT/node_modules" "$STAGE_DIR/node_modules" || return 1
  # getVersion() walks UP from dist/cli.js for the nearest package.json; a stage
  # without one reports 0.0.0 and every version-gated builtin plugin turns off.
  cp "$REPO_ROOT/package.json" "$STAGE_DIR/package.json" || return 1
  stage_source_root || return 1
}

# WALNUT_INSTALL_DIR (constants.ts) walks up from the bundle looking for a .git
# next to a package.json, which a stage never has: since staging landed, the
# server believed it was an npm install, so "Fix Walnut" hid and "Ask AI to
# fix" would have cloned upstream instead of repairing THIS checkout. The
# marker hands it the repo the stage was built from (the file's walk starts in
# <stage>/runtime/<build>/dist and reaches the stage dir the same way).
stage_source_root() {
  printf '%s\n' "$SERVE_ROOT" > "$STAGE_DIR/.walnut-source-root"
}

# The compiled files this deploy built (only those newer than the build's
# marker: a dist-bin/ of an earlier build may still hold other targets).
stage_files() {
  mkdir -p "$STAGE_DIR/dist-bin" || return 1
  local t src
  for t in $BUILT_TARGETS; do
    src="$REPO_ROOT/dist-bin/walnut-$t"
    if [[ ! -f "$src" || ! "$src" -nt "$build_marker" ]]; then
      if [[ "$t" == "$SELF_TARGET" ]]; then
        echo "The build left no fresh $src." >&2
        return 1
      fi
      echo "Warning: no fresh walnut-$t from this build; it is not staged." >&2
      continue
    fi
    clone_copy "$src" "$STAGE_DIR/dist-bin/walnut-$t" || return 1
  done
  stage_source_root || return 1
}

# A stage that never became the running server is trash on exit (smoke failure,
# staging failure, aborted deploy). One that DID launch stays: the server reads
# web assets from it per-request for its whole lifetime.
stage_cleanup() {
  if [[ -n "${STAGE_DIR:-}" && "$STAGE_IN_USE" != "1" ]]; then
    rm -rf "$STAGE_DIR" 2>/dev/null || true
  fi
}

trap 'scratch_cleanup; stage_cleanup; release_lock' EXIT
if [[ "$RUNTIME" == "file" ]]; then
  staged_ok=1
  stage_files || staged_ok=0
else
  staged_ok=1
  stage_dist || staged_ok=0
fi
if (( ! staged_ok )); then
  # Pre-kill: the old server is still serving. A staging failure usually means
  # the disk is full — this deploy would only get worse past this point.
  rm -rf "$STAGE_DIR" 2>/dev/null || true
  echo "Failed to stage the build at $STAGE_DIR (disk full?); deploy aborted, prod untouched." >&2
  exit 1
fi
CLI_JS="$STAGE_DIR/dist/cli.js"
SERVER_FILE="$STAGE_DIR/dist-bin/walnut-$SELF_TARGET"
if [[ "$RUNTIME" == "file" ]]; then
  SERVER_KIND=file
  SERVER_PATH="$SERVER_FILE"
  echo "Staged the compiled files for boot: $(cd "$STAGE_DIR/dist-bin" && ls | tr '\n' ' ')in $STAGE_DIR/dist-bin"
else
  SERVER_KIND=node
  SERVER_PATH="$CLI_JS"
  echo "Staged dist for boot: $CLI_JS"
fi

# The server program for a build: the compiled file, whose runtime tree lives
# in the runtime/ dir beside its dist-bin/ (WALNUT_RUNTIME_DIR names that
# parent, src/binary/runtime-tree.ts), or node with the dist's cli.js. Sets the
# global array server_argv; `web --port N` follows it, after `env` and its -u
# options. A rehearsal adds its private data and daemon dirs.
set_server_argv() {
  case "$1" in
    file) server_argv=(WALNUT_RUNTIME_DIR="$(dirname "$(dirname "$2")")/runtime" "$2") ;;
    node) server_argv=("$NODE_BIN" "$2") ;;
    *) echo "unknown server kind: $1" >&2; return 1 ;;
  esac
  if [[ "$REHEARSAL" == "1" ]]; then
    server_argv=(OPEN_WALNUT_HOME="$REHEARSAL_HOME" WALNUT_DAEMON_DIR="$REHEARSAL_DAEMON_DIR" "${server_argv[@]}")
  fi
  if [[ "$REHEARSAL" == "1" && "${WALNUT_DEVPROD_REHEARSAL_FAIL_LAUNCH:-0}" == "1" && "${rehearsal_fail_armed:-0}" == "1" ]]; then
    # The new server (the real build) answers /api/config but cannot serve the
    # web app: its static root and the asset mirror point at nothing, so the
    # check after readiness fails and the deploy rolls back to the LKG.
    server_argv=(WALNUT_WEB_STATIC_DIR="$TMPDIR/rehearsal-no-static" WALNUT_WEB_STATIC_MIRROR="$TMPDIR/rehearsal-no-mirror/none" "${server_argv[@]}")
  fi
}

# ── Self-test of the compiled file ──────────────────────────────────────────
# `walnut __selftest` checks the parts of the file a server boot does not reach
# on a fresh machine (SQLite on bun, the worker threads, the tokenizer, the
# daemon source) and unpacks the runtime tree the server will run from, into
# the stage, so the first boot does not write it. Isolated like the smoke boot.
if [[ "$RUNTIME" == "file" && "${WALNUT_DEVPROD_SKIP_SELFTEST:-0}" != "1" ]]; then
  SELFTEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/walnut-selftest.XXXXXX")"
  mkdir -p "$SELFTEST_TMP/home" "$SELFTEST_TMP/daemon"
  echo "Self-testing $SERVER_FILE."
  if ! env -u VITEST -u OPEN_WALNUT_EPHEMERAL -u WALNUT_STREAMS_DIR \
    OPEN_WALNUT_HOME="$SELFTEST_TMP/home" \
    WALNUT_DAEMON_DIR="$SELFTEST_TMP/daemon" \
    WALNUT_RUNTIME_DIR="$STAGE_DIR/runtime" \
    "$SERVER_FILE" __selftest; then
    rm -rf "$SELFTEST_TMP" "$STAGE_DIR" 2>/dev/null || true
    echo "Self-test FAILED: the compiled file is broken; deploy aborted, production server on :$PORT untouched." >&2
    exit 1
  fi
  rm -rf "$SELFTEST_TMP" 2>/dev/null || true
  SELFTEST_TMP=""
fi

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
trap 'smoke_cleanup; scratch_cleanup; stage_cleanup; release_lock' EXIT

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
    # The smoke server's program: the staged build, the compiled file with its
    # own runtime tree in the smoke dir (nothing it unpacks or writes reaches the
    # stage the production server will run from).
    if [[ "$SERVER_KIND" == "file" ]]; then
      smoke_argv=(WALNUT_RUNTIME_DIR="$SMOKE_TMP/runtime" "$SERVER_FILE")
    else
      smoke_argv=("$NODE_BIN" "$CLI_JS")
    fi
    if [[ "$REHEARSAL" == "1" && "${WALNUT_DEVPROD_REHEARSAL_FAIL_SMOKE:-0}" == "1" ]]; then
      smoke_argv=(/bin/sh -c 'echo "rehearsal: forced smoke failure" >&2; exit 3' rehearsal-smoke)
    fi
    env -u VITEST -u OPEN_WALNUT_EPHEMERAL -u WALNUT_STREAMS_DIR -u WALNUT_RUNTIME_DIR \
      OPEN_WALNUT_HOME="$SMOKE_TMP/home" \
      WALNUT_DAEMON_DIR="$SMOKE_TMP/daemon" \
      WALNUT_DISABLE_SEARCH=1 \
      WALNUT_DAEMON_HEARTBEAT_MS=2000 \
      "${smoke_argv[@]}" web --port "$smoke_port" \
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
      "$JS_BIN" "$REPO_ROOT/scripts/devprod-render-check.mjs" \
        "http://localhost:$smoke_port/" --timeout-ms "$(( RENDER_SECS * 1000 ))" \
        || smoke_render_rc=$?
      if [[ "$smoke_render_rc" == "2" && "${WALNUT_DEVPROD_RENDER_STRICT:-0}" != "1" ]]; then
        echo "Smoke render UNDETERMINED — proceeding (WALNUT_DEVPROD_RENDER_STRICT=1 fails closed here)." >&2
        smoke_render_rc=0
      fi
    fi
    smoke_cleanup
    if [[ "$smoke_ok" != "1" ]]; then
      echo "Smoke boot FAILED: the fresh build did not serve /api/config within ${SMOKE_SECS}s." >&2
      echo "Production server on :$PORT was NOT touched. Smoke log tail ($SMOKE_LOG):" >&2
      tail -n 25 "$SMOKE_LOG" >&2 || true
      exit 1
    fi
    if [[ "$smoke_render_rc" != "0" ]]; then
      echo "Smoke render FAILED: the fresh build serves /api/config but crashes on the first paint of /." >&2
      echo "Production server on :$PORT was NOT touched. Fix the render error above" >&2
      echo "(WALNUT_DEVPROD_SKIP_RENDER=1 skips this check for emergencies)." >&2
      exit 1
    fi
    echo "Smoke boot OK: the fresh build binds, serves, and paints /."
  fi
fi

# LAST thing before the outgoing server is stopped. Deliberately after the build
# and the smoke boot (those take minutes — draining first would just let new turns
# start), and before `launchctl remove`, which is itself a kill.
drain_active_turns

# ── One launchd domain for the job's whole life ─────────────────────────────
# The job is loaded with `launchctl bootstrap <domain>`, and every later look at
# it (is it loaded, which pid) and its removal name the SAME domain:
# `launchctl print|bootout <domain>/<label>`. The legacy `list`/`remove` act in
# the caller's own domain, which is not gui/<uid> in an ssh session, so mixing
# them with a gui/<uid> bootstrap could load the job in one domain and look for
# it in another. A GUI login session (managername "Aqua") is gui/<uid>, where a
# legacy `submit` from that shell also lands (checked 2026-10-03: a submitted
# probe job printed `domain = gui/<uid>`, and user/<uid> did not know it). Any
# other session (ssh: "Background") uses user/<uid>.
LAUNCHD_DOMAIN=""
LAUNCHD_BOOTOUT_WAIT_SECS="${WALNUT_DEVPROD_BOOTOUT_WAIT_SECS:-25}"
if [[ ! "$LAUNCHD_BOOTOUT_WAIT_SECS" =~ ^[0-9]+$ ]]; then
  LAUNCHD_BOOTOUT_WAIT_SECS=25
fi

launchd_domain() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local uid
  uid="$(id -u)"
  if [[ "$(launchctl managername 2>/dev/null || true)" == "Aqua" ]]; then
    printf 'gui/%s' "$uid"
  else
    printf 'user/%s' "$uid"
  fi
}

launchd_job_exists() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  launchctl print "$LAUNCHD_DOMAIN/$LAUNCH_LABEL" >/dev/null 2>&1
}

# The top-level `pid = N` line of `launchctl print` output on stdin (nested
# blocks are indented deeper). Empty when the job is loaded but not running.
launchd_print_pid() {
  awk '/^\tpid = [0-9]+$/ { print $3; exit }'
}

# The job's live PID: empty when the label is loaded but has no process, or is
# not loaded at all.
launchd_job_pid() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  launchctl print "$LAUNCHD_DOMAIN/$LAUNCH_LABEL" 2>/dev/null | launchd_print_pid || true
}

# The two per-user domains the label can be in: a deploy from a GUI login loads
# it into gui/<uid>, one over ssh into user/<uid>.
launchd_label_domains() {
  local uid
  uid="$(id -u)"
  printf '%s\n' "gui/$uid" "user/$uid"
}

# The domains that still hold the label, space separated (empty: none).
launchd_label_loaded_in() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local d out=""
  for d in $(launchd_label_domains); do
    if launchctl print "$d/$LAUNCH_LABEL" >/dev/null 2>&1; then
      out="${out:+$out }$d"
    fi
  done
  printf '%s' "$out"
}

# bootout returns before a slow job has exited: measured 2026-10-03, 47 ms for
# a job whose process took 3 s to exit, while `print` still showed it loaded.
# A bootstrap of the same label in that window fails (a remove followed at
# once by a bootstrap fell back to submit that way, 2026-10-03), so wait,
# bounded, until launchd has let go. launchd SIGKILLs a job that ignores SIGTERM
# about 5 s after a bootout or a remove (measured 2026-10-03: 5.3 s and 5.1 s),
# so the default 25 s wait covers that with margin. The label goes from both
# per-user domains, so a job an earlier deploy loaded from the other kind of
# session goes too. Returns 1 when the label is still loaded after the wait:
# the caller decides, since a bootstrap of that label would fail. The wait is
# on the clock ($SECONDS), not a count of rounds: each round also runs one
# `launchctl print` per domain, and on a loaded Mac those take their own time.
remove_launchd_job() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local d left deadline
  for d in $(launchd_label_domains); do
    launchctl bootout "$d/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  done
  deadline=$(( SECONDS + LAUNCHD_BOOTOUT_WAIT_SECS ))
  while left="$(launchd_label_loaded_in)" && [[ -n "$left" ]]; do
    if (( SECONDS >= deadline )); then
      echo "launchd job '$LAUNCH_LABEL' is still loaded in $left ${LAUNCHD_BOOTOUT_WAIT_SECS}s after bootout." >&2
      return 1
    fi
    sleep 0.2
  done
  return 0
}

use_launchd=0
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  use_launchd=1
  LAUNCHD_DOMAIN="$(launchd_domain)"
  # The old job got its SIGTERM from the bootout, so this deploy is past the
  # point of refusing: a label launchd will not let go of cannot be loaded
  # again, and the new server starts under nohup instead.
  if ! remove_launchd_job; then
    echo "Starting the new server with nohup; remove the stuck job later with: launchctl bootout $LAUNCHD_DOMAIN/$LAUNCH_LABEL" >&2
    use_launchd=0
  fi
fi

rehearsal_refuse_foreign_listeners
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
  #
  # But the server closes its listener FIRST and only then finishes its
  # teardown (an import mid-write, embed runs, the stores), bounded by its own
  # 4s bail (src/commands/web.ts). 2026-09-30: this loop SIGKILLed the outgoing
  # server a second after the port freed, mid-teardown. So each PID gets
  # STOP_GRACE_SECS to exit on its own before the SIGKILL.
  stop_deadline=$(( SECONDS + STOP_GRACE_SECS ))
  for zpid in $existing_pids; do
    while kill -0 "$zpid" 2>/dev/null && (( SECONDS < stop_deadline )); do
      sleep 0.2
    done
    kill -0 "$zpid" 2>/dev/null || continue
    echo "Server PID $zpid did not exit ${STOP_GRACE_SECS}s after SIGTERM; sending SIGKILL." >&2
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
stray_pids="$(pgrep -f 'dist/cli\.js web|dist-bin/walnut-[a-z0-9-]+ web' 2>/dev/null || true)"
for spid in $stray_pids; do
  [[ -n "$spid" && "$spid" != "$self_pid" ]] || continue
  kill -0 "$spid" 2>/dev/null || continue
  cmd="$(ps -o command= -p "$spid" 2>/dev/null || true)"
  # Only OUR production server; never an ephemeral/test instance. The launch
  # shapes over time: repo dist (old deploys), staged dist (Node deploys), LKG
  # dist (Node rollback servers), and the compiled file staged, in its LKG, or
  # in a checkout's dist-bin/. A daemon (`walnut-<target> __daemon`) never matches.
  if [[ "$cmd" != *"$REPO_ROOT/dist/cli.js"* && "$cmd" != *"$SERVE_ROOT/dist/cli.js"* \
     && "$cmd" != *"open-walnut-stage."*"/dist/cli.js"* \
     && "$cmd" != *"open-walnut-lkg/dist/cli.js"* \
     && "$cmd" != *"$REPO_ROOT/dist-bin/walnut-"*" web"* && "$cmd" != *"$SERVE_ROOT/dist-bin/walnut-"*" web"* \
     && "$cmd" != *"open-walnut-stage."*"/dist-bin/walnut-"*" web"* \
     && "$cmd" != *"open-walnut-lkg/dist-bin/walnut-"*" web"* ]]; then
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
  # A rehearsal reaps only its own: a server that names its port AND runs from one
  # of its stages or its LKG. One with no --port serves :3456, production's.
  if [[ "$REHEARSAL" == "1" ]] && { [[ "$port_arg" != "$PORT" ]] || ! rehearsal_owns_pid "$spid"; }; then
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
#
# Fails CLOSED. `pgrep`/`ps` can be missing or unusable (a launchd or `env -i`
# shell with a minimal PATH), and `|| true` on the probe would then read as "no
# process is alive" and delete every stage — the guard turning into the bug it
# exists to prevent. When the process table cannot be READ, keep the directory.
stage_has_live_process() {
  local stage="$1" spid cmd base pids
  base="$(basename "$stage")"
  if ! command -v pgrep >/dev/null 2>&1 || ! command -v ps >/dev/null 2>&1; then
    echo "unknown"
    return 0
  fi
  local rc=0
  pids="$(pgrep -f 'dist/cli\.js|dist-bin/walnut-' 2>/dev/null)" || rc=$?
  # pgrep exit 1 means "matched nothing", which is a real answer. Anything else
  # (usage error, no permission, killed) means the probe failed and we know nothing.
  if (( rc > 1 )); then
    echo "unknown"
    return 0
  fi
  # A Node server runs <stage>/dist/cli.js; the compiled file's server AND its
  # local daemon run <stage>/dist-bin/walnut-<target>, and both read the
  # runtime tree in <stage>/runtime for as long as they live.
  for spid in $pids; do
    [[ -n "$spid" ]] || continue
    cmd="$(ps -o command= -p "$spid" 2>/dev/null || true)"
    if [[ "$cmd" == *"$base/dist/cli.js"* || "$cmd" == *"$base/dist-bin/walnut-"* ]]; then
      echo "$spid"
      return 0
    fi
  done
  return 1
}

# stage_has_live_process for one exact directory whose basename is not unique
# (the LKG: a rehearsal's is named the same). Matched on the full path, in both
# spellings (/var and /private/var), with runs of slashes squeezed (TMPDIR ends
# in one). Fails closed like the stage check.
dir_has_live_process() {
  local dir phys spid cmd pids rc=0
  dir="$(printf '%s' "${1%/}" | tr -s /)"
  phys="$(cd "$1" 2>/dev/null && pwd -P || printf '%s' "$dir")"
  if ! command -v pgrep >/dev/null 2>&1 || ! command -v ps >/dev/null 2>&1; then
    echo "unknown"
    return 0
  fi
  pids="$(pgrep -f 'dist/cli\.js|dist-bin/walnut-' 2>/dev/null)" || rc=$?
  if (( rc > 1 )); then
    echo "unknown"
    return 0
  fi
  for spid in $pids; do
    [[ -n "$spid" ]] || continue
    cmd="$(ps -o command= -p "$spid" 2>/dev/null | tr -s / || true)"
    if [[ "$cmd" == *"$dir/"* || "$cmd" == *"$phys/"* ]]; then
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
  if [[ "$live_pid" == "unknown" ]]; then
    echo "Keeping stage $old_stage: the process table could not be read, so nothing here is provably dead." >&2
    continue
  fi
  if [[ -n "$live_pid" ]]; then
    echo "Keeping stage $old_stage: PID $live_pid is still running from it." >&2
    continue
  fi
  rm -rf "$old_stage" 2>/dev/null || true
done

# One launchd job for the given cli.js. launchd gives jobs a minimal PATH
# (/usr/bin:/bin:...) — pass the caller's full PATH through so child tools
# (ffmpeg, git, ssh, brew, agent CLIs) resolve exactly as they would from the
# deploying shell.
# WALNUT_LAUNCHD_LABEL names the job to the server: a server that loses the
# instance lock removes its OWN job (after launchd confirms its pid is the job's),
# so KeepAlive cannot relaunch a duplicate forever (src/core/launchd-self-remove.ts).
#
# Scheduling: the job is loaded from a plist with ProcessType Interactive, not
# with a bare `launchctl submit`. A submitted job is launchd's Standard type
# ("spawn type = daemon"), which macOS runs in the utility band, base priority
# 20, the same band as all the agent work on a busy Mac; measured 2026-10-02,
# the server then got 1 to 30% of one core through 5 to 25 s freezes at load
# 200+. Interactive is what apps get (base priority 31). The same plist sets
# WALNUT_DAEMON_QOS_CLAMP=1, which tells the server it was raised, so it keeps
# its background children (the local daemon and every agent session, the
# embedding model worker, the git backups) in the utility band where they ran
# before (src/lib/background-qos.ts) and only the server moves. The submit
# fallback stays in the utility band, so it does not carry the flag, and a
# server started any other way leaves its children alone. No root is needed
# (the gui domain is the user's own). The plist is written to a private temp
# file and deleted once loaded: launchd keeps the definition, KeepAlive
# restarts included. Any failure falls back to submit.
#
# Every replacement below is a QUOTED variable in an UNQUOTED assignment. Bash
# 5.2 turned on `patsub_replacement`, which makes an unquoted `&` in a
# `${s//pat/rep}` replacement stand for the matched text, so `&lt;` came out as
# `<lt;` and the plist would not parse (the Linux CI runner and a Homebrew bash
# first on PATH both run 5.2); a quoted replacement is literal there. The outer
# double quotes must stay off: bash 3.2 keeps quotes nested inside a
# double-quoted `${...}` as literal characters. An assignment neither splits
# nor globs, so the bare form is safe on both.
xml_escape() {
  local s="$1" amp='&amp;' lt='&lt;' gt='&gt;' quot='&quot;'
  s=${s//&/"$amp"}; s=${s//</"$lt"}; s=${s//>/"$gt"}; s=${s//\"/"$quot"}
  printf '%s' "$s"
}

# The job's command line, shared by the plist and the submit fallback: the
# server program set_server_argv chose (the compiled file runs directly, no node).
# WALNUT_RUNTIME_DIR is dropped first: a deploy started from inside a session of
# the old server inherits that server's, which names the OLD stage.
launchd_job_argv() {
  launchd_argv=(/bin/sh -c 'cd "$1" && shift && exec "$@"' open-walnut
    "$SERVE_ROOT" /usr/bin/env
    -u OPEN_WALNUT_EPHEMERAL
    -u OPEN_WALNUT_HOME
    -u WALNUT_DAEMON_DIR
    -u VITEST
    -u WALNUT_RUNTIME_DIR
    PATH="$PATH"
    WALNUT_LAUNCHD_LABEL="$LAUNCH_LABEL"
    "${server_argv[@]}" web --port "$PORT")
}

write_launchd_plist() {
  local out="$1" arg
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '<key>Label</key><string>%s</string>\n' "$(xml_escape "$LAUNCH_LABEL")"
    printf '%s\n' '<key>ProgramArguments</key><array>'
    for arg in "${launchd_argv[@]}"; do
      printf '<string>%s</string>\n' "$(xml_escape "$arg")"
    done
    printf '%s\n' '</array>'
    printf '%s\n' '<key>ProcessType</key><string>Interactive</string>'
    printf '%s\n' '<key>EnvironmentVariables</key><dict><key>WALNUT_DAEMON_QOS_CLAMP</key><string>1</string></dict>'
    printf '%s\n' '<key>KeepAlive</key><true/>'
    printf '%s\n' '<key>RunAtLoad</key><true/>'
    printf '<key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$SERVER_LOG")"
    printf '<key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$SERVER_LOG")"
    printf '%s\n' '</dict></plist>'
  } > "$out"
}

# Load the job from a plist as ProcessType Interactive into $LAUNCHD_DOMAIN.
# Returns 1 (the caller then submits) when that is turned off or anything in it
# fails. The reason (plutil's or launchctl's own words) goes to the deploy's
# stderr and into the server log, so a silent fall back to the utility band can
# be told apart from a deliberate one afterwards.
bootstrap_interactive_job() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  [[ "${WALNUT_DEVPROD_PROCESS_TYPE:-Interactive}" == "Interactive" ]] || return 1
  local plist_dir plist rc=1 why=""
  plist_dir="$(mktemp -d "${TMPDIR:-/tmp}/open-walnut-launchd.XXXXXX" 2>/dev/null)" || return 1
  plist="$plist_dir/$LAUNCH_LABEL.plist"
  if ! write_launchd_plist "$plist"; then
    why="could not write $plist"
  elif command -v plutil >/dev/null 2>&1 && ! why="$(plutil -lint -s "$plist" 2>&1)"; then
    why="plutil: ${why:-lint failed}"
  elif ! why="$(launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist" 2>&1)"; then
    why="launchctl bootstrap $LAUNCHD_DOMAIN: ${why:-failed}"
  else
    rc=0
  fi
  if (( rc != 0 )); then
    why="$(printf '%s' "$why" | tr '\n' ' ')"
    echo "Could not load '$LAUNCH_LABEL' as an Interactive job ($why); using launchctl submit (utility priority)." >&2
    printf '%s dev-prod.sh: Interactive load of %s failed, using launchctl submit: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LAUNCH_LABEL" "$why" >> "$SERVER_LOG" 2>/dev/null || true
    # That line is the deploy's, not the server's: move the first-output
    # baseline past it, or a server that never starts would look like it wrote.
    server_log_baseline="$(wc -c < "$SERVER_LOG" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  fi
  rm -rf "$plist_dir"
  return "$rc"
}

submit_launchd_job() {
  # Callers hold use_launchd=1 (Darwin-only); the guard keeps the helper inert
  # if one is ever added on another path.
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  launchd_job_argv
  bootstrap_interactive_job && return 0
  # A legacy submit lands in the caller's own domain, which launchd_domain
  # picked to match; launch_server checks it really did.
  launchctl submit \
    -l "$LAUNCH_LABEL" \
    -o "$SERVER_LOG" \
    -e "$SERVER_LOG" \
    -- "${launchd_argv[@]}"
}

# Launch a server on :$PORT for a build: `launch_server file <walnut file>` or
# `launch_server node <cli.js>`: launchd (KeepAlive, nice 0) on macOS, nohup
# elsewhere. Sets the global `pid` on the nohup path.
launch_server() {
  set_server_argv "$1" "$2" || return 1
  pid=""
  if (( use_launchd )); then
    if ! submit_launchd_job; then
      # Still on the use_launchd path: degrade to nohup rather than abort.
      echo "launchd submit failed outright; falling back to nohup." >&2
      use_launchd=0
    # use_launchd path: prove the submit actually registered. 2026-08-23: a
    # submit from one shell context silently created NOTHING (no job, no
    # process, zero log bytes) and the readiness window burned 180s probing a
    # server that never existed. Fall back to nohup; flipping use_launchd keeps
    # stop_new_server and the readiness death-check pointed at the right thing.
    elif ! launchd_job_exists; then
      echo "launchctl did not load '$LAUNCH_LABEL' into $LAUNCHD_DOMAIN; falling back to nohup." >&2
      # A submit that landed in some other domain would KeepAlive a second
      # server next to the nohup one: take it back out of the domain it went to
      # (the caller's own, which is what the legacy remove acts on).
      launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
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
        # Still loaded after the wait: a resubmit of the label would fail too.
        remove_launchd_job || break
        sleep 1
        if (( attempt == 2 )) || ! submit_launchd_job; then
          break
        fi
      done
      if [[ -z "$spawned" ]]; then
        echo "launchd would not spawn '$LAUNCH_LABEL'; falling back to nohup." >&2
        # A job that stays loaded has no process; the nohup server takes the port.
        remove_launchd_job || true
        use_launchd=0
      fi
    fi
  fi
  if (( ! use_launchd )); then
    nohup env -u OPEN_WALNUT_EPHEMERAL \
      -u OPEN_WALNUT_HOME \
      -u WALNUT_DAEMON_DIR \
      -u VITEST \
      -u WALNUT_RUNTIME_DIR \
      "${server_argv[@]}" web --port "$PORT" \
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

# Best-effort snapshot of the build that just passed readiness, for rollback.
# Clonefile (cp -c) is ~instant on APFS; plain cp -R elsewhere. Taken from the
# STAGE, not the repo: it is the exact artifact that just passed readiness
# (byte-identical by construction), and the temp volume is exempt from the
# on-access scanners that stall /Users reads under load. One kind per snapshot:
#   file  dist-bin/ (this machine's file and its siblings) + runtime/ (its tree)
#   node  dist/ + a node_modules symlink to the serve root's (the bundle
#         resolves native/spawned deps there, same as a repo launch) + package.json
snapshot_lkg() {
  # Rollback servers run from a stage cloned from the LKG (rollback_to_lkg), so
  # nothing runs from it here; an older deploy's rollback server, or the daemon it
  # respawned from its own path, may. Replacing the LKG then would delete their
  # executable and runtime tree from under them: keep it, and this build is not
  # snapshotted (the LKG stays an older good build).
  local live
  live="$(dir_has_live_process "$LKG_DIR" || true)"
  if [[ -n "$live" ]]; then
    echo "Keeping the last-known-good build at $LKG_DIR: process $live still runs from it, so this build is not snapshotted." >&2
    return 0
  fi
  rm -rf "$LKG_DIR.tmp" 2>/dev/null || true
  mkdir -p "$LKG_DIR.tmp" || return 1
  if [[ "$SERVER_KIND" == "file" ]]; then
    clone_copy "$STAGE_DIR/dist-bin" "$LKG_DIR.tmp/dist-bin" || return 1
    # The tree the server unpacked; without it the LKG file unpacks its own at boot.
    if [[ -d "$STAGE_DIR/runtime" ]]; then
      clone_copy "$STAGE_DIR/runtime" "$LKG_DIR.tmp/runtime" || return 1
    fi
  else
    local copied=0
    if [[ "$(uname -s)" == "Darwin" ]]; then
      if cp -Rc "$STAGE_DIR/dist" "$LKG_DIR.tmp/dist" 2>/dev/null; then copied=1; fi
    fi
    if (( ! copied )); then
      rm -rf "$LKG_DIR.tmp/dist" 2>/dev/null || true
      cp -R "$STAGE_DIR/dist" "$LKG_DIR.tmp/dist" || return 1
    fi
    ln -sfn "$SERVE_ROOT/node_modules" "$LKG_DIR.tmp/node_modules" || return 1
    # Same reason as stage_dist: without a package.json the LKG boots as 0.0.0.
    cp "$REPO_ROOT/package.json" "$LKG_DIR.tmp/package.json" || return 1
  fi
  # A rollback server keeps "Fix Walnut" pointed at this checkout (stage_source_root).
  printf '%s\n' "$SERVE_ROOT" > "$LKG_DIR.tmp/.walnut-source-root" || return 1
  rm -rf "$LKG_DIR" 2>/dev/null || true
  mv "$LKG_DIR.tmp" "$LKG_DIR" || return 1
}

# First-output baseline: a candidate that appends NOTHING to the server log is
# a process that never started (launchctl submit registering nothing, instant
# module-init death) — judged in seconds below, not after the whole window.
server_log_baseline="$(wc -c < "$SERVER_LOG" 2>/dev/null | tr -d '[:space:]' || echo 0)"

STAGE_IN_USE=1
rehearsal_fail_armed=1
launch_server "$SERVER_KIND" "$SERVER_PATH"
rehearsal_fail_armed=0

stop_new_server() {
  if (( use_launchd )); then
    # A label launchd will not let go of cannot be loaded again: the rollback
    # that follows starts under nohup instead (never an abort under set -e).
    remove_launchd_job || use_launchd=0
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
# Does a snapshot dir hold a build this machine can roll back to?
lkg_has_build() {
  [[ ( -n "$MACHINE_TARGET" && -x "$1/dist-bin/walnut-$MACHINE_TARGET" ) || -f "$1/dist/cli.js" ]]
}

# A rollback server never runs from the LKG itself: the next good deploy replaces
# the LKG whole, and the server (or the daemon it respawns from its own path)
# would lose its executable and runtime tree under it. It runs from a stage on
# the temp volume (see STAGE_ROOT) cloned from the LKG, which the stage reaper
# keeps while anything runs from it.
# Prints the stage, or fails (the caller then starts the LKG in place).
stage_lkg_for_rollback() {
  local kind="$1" src="${2:-$LKG_DIR}" dir
  dir="$STAGE_ROOT/open-walnut-stage.rollback.$(date +%s).$$"
  mkdir -p "$dir" || return 1
  if [[ "$kind" == "file" ]]; then
    # The file and its unpacked runtime tree (without it the file unpacks its own at boot).
    if ! clone_copy "$src/dist-bin" "$dir/dist-bin" \
      || { [[ -d "$src/runtime" ]] && ! clone_copy "$src/runtime" "$dir/runtime"; }; then
      rm -rf "$dir"
      return 1
    fi
  else
    if ! clone_copy "$src/dist" "$dir/dist" \
      || ! ln -sfn "$SERVE_ROOT/node_modules" "$dir/node_modules" \
      || ! cp "$src/package.json" "$dir/package.json"; then
      rm -rf "$dir"
      return 1
    fi
  fi
  # Keeps "Fix Walnut" pointed at this checkout, as from the snapshot itself.
  printf '%s\n' "$SERVE_ROOT" > "$dir/.walnut-source-root" || { rm -rf "$dir"; return 1; }
  printf '%s' "$dir"
}

rollback_to_lkg() {
  # Whatever kind the last good build was: a file deploy that fails right after
  # a Node one rolls back to that Node build, and the other way round. The old
  # temp location is read until the first snapshot lands in LKG_DIR.
  local lkg="$LKG_DIR"
  if ! lkg_has_build "$lkg" && [[ -z "${WALNUT_DEVPROD_LKG_DIR:-}" ]] && lkg_has_build "${LKG_LEGACY_DIR:-}"; then
    lkg="$LKG_LEGACY_DIR"
  fi
  local lkg_kind="" lkg_rel="" from=""
  if [[ -n "$MACHINE_TARGET" && -x "$lkg/dist-bin/walnut-$MACHINE_TARGET" ]]; then
    lkg_kind=file
    lkg_rel="dist-bin/walnut-$MACHINE_TARGET"
  elif [[ -f "$lkg/dist/cli.js" ]]; then
    lkg_kind=node
    lkg_rel="dist/cli.js"
    if [[ -z "$NODE_BIN" ]]; then
      echo "The last-known-good build at $lkg is a Node build and this machine has no node; :$PORT is left unserved." >&2
      return 0
    fi
  fi
  if [[ -n "$lkg_kind" ]]; then
    if ! from="$(stage_lkg_for_rollback "$lkg_kind" "$lkg")"; then
      from="$lkg"
      echo "Could not stage the last-known-good build; starting it from $lkg itself." >&2
    fi
    echo "Rolling back to the last-known-good build ($lkg_kind): $from/$lkg_rel" >&2
    launch_server "$lkg_kind" "$from/$lkg_rel"
    if wait_for_config_ready 90; then
      echo "Rollback server is serving on :$PORT (this deploy itself still failed)." >&2
    else
      echo "Rollback server not ready after 90s; left running in case it settles late." >&2
    fi
  else
    echo "No last-known-good build at $lkg; :$PORT is left unserved." >&2
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
    # processNice is a top-level key after `config` (src/web/routes/config.ts);
    # the greedy `.*` takes its LAST occurrence, so a config value spelling the
    # key cannot stand in for it. No jq and no node: neither is guaranteed here.
    process_nice="$(printf '%s' "$config_json" \
      | sed -n 's/.*"processNice"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p' \
      | head -n 1 || true)"
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

# ── Foreign supervisor: is :$PORT served by THIS deploy's job? ─────────────────
# 2026-09-25: this script killed the server the Mac app had started, the Mac app
# restarted it one second later, and that server won the instance lock. Readiness
# passed (the Mac app's server answered), while this job's own server exited as a
# duplicate and launchd KeepAlive relaunched it about every 11s for seven hours.
# New servers remove their own job when they lose the lock; this also covers an
# old dist in the job. Removes only a job PROVABLY not serving: it is loaded
# (`launchctl print` answered for the job's domain) and its PID is absent or
# differs from the listener's. A probe that answers nothing removes nothing.
if (( use_launchd )); then
  listener_now="$(listener_pids | head -n 1)"
  if [[ -n "$listener_now" ]] && job_info="$(launchctl print "$LAUNCHD_DOMAIN/$LAUNCH_LABEL" 2>/dev/null)"; then
    job_pid_now="$(printf '%s\n' "$job_info" | launchd_print_pid || true)"
    if [[ "$job_pid_now" != "$listener_now" ]]; then
      listener_cmd="$(ps -o command= -p "$listener_now" 2>/dev/null || true)"
      echo "Port :$PORT is served by PID $listener_now, not by launchd job '$LAUNCH_LABEL' (PID ${job_pid_now:-none})." >&2
      echo "Another supervisor (for example the Mac app) restarted the server first: ${listener_cmd:-unknown command}" >&2
      echo "Removing the redundant job so KeepAlive cannot relaunch a duplicate server." >&2
      remove_launchd_job || echo "Until it goes, KeepAlive can relaunch a duplicate: launchctl bootout $LAUNCHD_DOMAIN/$LAUNCH_LABEL" >&2
    fi
  fi
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
    if [[ "$SERVER_KIND" == "file" ]]; then
      echo "Server answers /api/config but cannot serve the web app from its runtime tree under $STAGE_DIR/runtime." >&2
    else
      echo "Server answers /api/config but cannot serve the web app from $STAGE_DIR/dist/web/static." >&2
    fi
    echo "First 200 bytes of GET /: ${index_html:0:200}" >&2
    rollback_to_lkg
    exit 1
    ;;
esac

# ── Live render: does `/` paint against the REAL data? ─────────────────────────
# Serving the entry HTML is not painting it, and the smoke render above cannot
# answer this: it runs against a TEMP data dir, so every component that only
# mounts once there are real sessions/tasks never renders there at all.
# 2026-09-18: a bundle built while a component was half-saved (a ref deleted from
# its declaration but not from its JSX) passed the smoke render on the empty
# dataset, then crashed the live home page — error boundary, "Something went wrong
# rendering the page", for ten minutes, while /api/config and GET / both stayed
# green. This check runs the same script against :$PORT, where the real data is.
#
# Ordering matters twice: AFTER readiness (the server must be up to be loaded) and
# BEFORE snapshot_lkg, so a crashing build can never become the thing we roll back
# TO. Three-valued like the smoke render — only a definitive crash rolls back;
# "could not tell" (no browser, page never settled under load) keeps the new
# server, because a deploy blocked by a busy Mac is its own outage.
live_render_rc=0
if [[ "${WALNUT_DEVPROD_SKIP_RENDER:-0}" != "1" ]]; then
  RENDER_SECS="${WALNUT_DEVPROD_RENDER_SECS:-60}"
  "$JS_BIN" "$REPO_ROOT/scripts/devprod-render-check.mjs" \
    "http://localhost:$PORT/" --timeout-ms "$(( RENDER_SECS * 1000 ))" \
    || live_render_rc=$?
  if [[ "$live_render_rc" == "2" && "${WALNUT_DEVPROD_RENDER_STRICT:-0}" != "1" ]]; then
    echo "Live render UNDETERMINED — keeping the new server (WALNUT_DEVPROD_RENDER_STRICT=1 fails closed here)." >&2
    live_render_rc=0
  fi
fi
if [[ "$live_render_rc" != "0" ]]; then
  stop_new_server
  echo "Live render FAILED: :$PORT serves the app but crashes on the first paint of /." >&2
  rollback_to_lkg
  exit 1
fi

if ! snapshot_lkg; then
  echo "Warning: last-known-good snapshot failed; rollback will use the previous one." >&2
fi

# The `walnut` CLI here runs $SERVE_ROOT/dist and its op registry in process, so
# op descriptions, schemas and outcomes come from that bundle, not the server. A
# deploy from a clean clone (deploy-committed.sh) never built there, and the CLI
# kept the last working-tree build (2026-10-05). Publish the build now serving:
# its staged dist, or for the compiled file the dist of the same build it was
# made from (the publish leaves build-binary's staging dir out).
# Best effort: the server is up either way.
if [[ "$SERVE_ROOT" != "$REPO_ROOT" ]]; then
  publish_from="$STAGE_DIR/dist"
  if [[ "$SERVER_KIND" == "file" ]]; then publish_from="$REPO_ROOT/dist"; fi
  publish_to="$SERVE_ROOT/dist"
  # A rehearsal writes only into its own dirs: the checkout's CLI keeps its build,
  # and the publish goes to a stand-in checkout (the script wants a package.json).
  if [[ "$REHEARSAL" == "1" ]]; then
    mkdir -p "$TMPDIR/rehearsal-serve-root"
    cp "$SERVE_ROOT/package.json" "$TMPDIR/rehearsal-serve-root/package.json" || true
    publish_to="$TMPDIR/rehearsal-serve-root/dist"
  fi
  if ! "$JS_BIN" "$REPO_ROOT/scripts/publish-serve-root-dist.mjs" "$publish_from" "$publish_to"; then
    echo "Warning: could not publish the serving build to $publish_to; the walnut CLI there keeps its last build." >&2
  fi
fi

pid="$(listener_pids | head -n 1)"
date +%s > "$SUCCESS_STAMP"
echo "Server ready (PID: $pid, $RUNTIME_DESC)"
