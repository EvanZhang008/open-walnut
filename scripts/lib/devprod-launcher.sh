# shellcheck shell=bash
# The Mac's production server kept by the service launcher. Sourced by scripts/dev-prod.sh.
#
#   launchd  $LAUNCH_LABEL (one job, as before; its plist kept, so it starts again at login)
#     └ /bin/sh $SVC_DIR/walnut-launcher.sh   (src/providers/service-launcher-script.ts)
#         └ <stage>/run                         (svc_write_run: env, own process group, session host)
#             └ Walnut.app --session-host -- <stage>/dist-bin/walnut-<target> web --port $PORT
#
# The launcher is the one record of which version runs and which is the good one (launcher/state).
# A deploy asks it to switch (launcher/request) and reads its answer (launcher/result): it stops the
# old server, starts the new one as a trial, commits it once the server wrote its ready mark (sessions
# adopted, port answering), and puts the good one back when the trial fails, or when the new one
# fails twice in its first 15 minutes. Every guard of the deploy before the stop stays as it was.
#
# A version is kept twice: its stage in the temp dir, where it runs as before (a first boot from /Users
# waits on the endpoint scanner, see STAGE_ROOT), and a clone of it in $SVC_DIR/versions/<stage>/ (APFS
# clonefile: no data copied), whose `run` the launcher names. macOS empties the temp dir at a reboot:
# the run script then puts the stage back from its clone before it starts, so a login brings back the
# version that ran, never an older one. The launcher's seed ($SVC_DIR/lkg-run, the last-known-good copy,
# which follows the launcher's good version) is only the last resort when even the clones are gone.
#
# Mode, a fact on disk: the plist with this launcher in it exists -> every deploy goes through it.
#   WALNUT_DEVPROD_LAUNCHER=1  installs it (this deploy stops the old server the old way, then loads
#                              the launcher job with the new build as its first version)
#   WALNUT_DEVPROD_LAUNCHER=0  takes it away (the launcher job goes with the old stop, the plist and
#                              the mark too, and the server starts the old way): the way back
# macOS only (launchd); elsewhere the deploy is the old one.

SVC_MODE=plain
SVC_DIR=""
SVC_L=""
SVC_SCRIPT=""
SVC_PLIST=""
SVC_MARK=""
SVC_SEED=""
# Seconds a new version has to write ready (busy ones get up to 900 s, the launcher's own bound).
SVC_TRIAL_SECS="${WALNUT_DEVPROD_LAUNCHER_TRIAL_SECS:-180}"

svc_shq() { local s=${1//\'/\'\\\'\'}; printf "'%s'" "$s"; }

# The launcher's files and the mode of this deploy.
svc_init() {
  [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1 || { SVC_MODE=plain; return 0; }
  if [[ "${REHEARSAL:-0}" == "1" ]]; then
    SVC_DIR="$TMPDIR/service"
    # A rehearsal's job is never a login item: its plist stays in its own dir.
    SVC_PLIST="$SVC_DIR/$LAUNCH_LABEL.plist"
  else
    SVC_DIR="${WALNUT_DEVPROD_SERVICE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/open-walnut/service}"
    SVC_PLIST="${WALNUT_DEVPROD_SERVICE_PLIST:-$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist}"
  fi
  SVC_L="$SVC_DIR/launcher"
  SVC_SCRIPT="$SVC_DIR/walnut-launcher.sh"
  SVC_SEED="$SVC_DIR/lkg-run"
  SVC_MARK="${REHEARSAL_HOME:-$HOME/.open-walnut}/local/service-launcher.json"
  case "${WALNUT_DEVPROD_LAUNCHER:-}" in
    1) if svc_installed; then SVC_MODE=launcher; else SVC_MODE=install; fi ;;
    0) if svc_installed; then SVC_MODE=remove; else SVC_MODE=plain; fi ;;
    *) if svc_installed; then SVC_MODE=launcher; else SVC_MODE=plain; fi ;;
  esac
}

svc_installed() {
  [[ -n "$SVC_PLIST" && -f "$SVC_PLIST" ]] && grep -q 'walnut-launcher.sh' "$SVC_PLIST" 2>/dev/null
}

svc_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }

# The live launcher's pid, or nothing.
svc_launcher_pid() {
  local p
  p="$(cat "$SVC_DIR/daemon-boot.pid" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && kill -0 "$p" 2>/dev/null || return 0
  # A pid left by an earlier boot can name another program now.
  ps -o command= -p "$p" 2>/dev/null | grep -qF "$SVC_SCRIPT" && printf '%s' "$p"
  return 0
}

# Wait up to $1 s for the launcher to be running (launchd starts it a moment after a bootstrap).
svc_wait_launcher() {
  local n=0
  while [[ -z "$(svc_launcher_pid)" ]] && (( n < $1 * 4 )); do sleep 0.25; n=$(( n + 1 )); done
  [[ -n "$(svc_launcher_pid)" ]]
}

# The pid the launcher started (its service), or nothing.
svc_service_pid() {
  local p
  p="$(sed -n 1p "$SVC_L/service.pid" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && kill -0 "$p" 2>/dev/null && printf '%s' "$p"
  return 0
}

# The versions the launcher may run now: current, good, and the one a request names (their run files).
svc_named() {
  [[ -n "$SVC_L" ]] || return 0
  svc_get "$SVC_L/state" current; svc_get "$SVC_L/state" good; svc_get "$SVC_L/request" exe
}

# Is <dir> (a stage, or a clone in versions/) a version the launcher names? By name: the temp dir is
# spelled more than one way (T// against T/, /private/var against /var; see sweep_old_stages).
svc_keeps_stage() {
  local name exe
  name="$(basename "${1%/}")"
  while IFS= read -r exe; do
    [[ "$exe" == */run && "$(basename "$(dirname "$exe")")" == "$name" ]] && return 0
  done < <(svc_named)
  return 1
}

# Keep this deploy's version: its clone in versions/ (with the run script the launcher names). Sets svc_run.
svc_save_version() {
  local dest="$SVC_DIR/versions/$(basename "$STAGE_DIR")"
  mkdir -p "$SVC_DIR/versions" && chmod 700 "$SVC_DIR/versions" || return 1
  rm -rf "$dest" 2>/dev/null || true
  clone_copy "$STAGE_DIR" "$dest" || return 1
  rm -f "$dest/run"
  svc_run="$dest/run"
  svc_write_run "$svc_run" "$dest" "$STAGE_DIR"
}

# Clones the launcher names no more go (each is a version's whole tree).
svc_prune_versions() {
  local d root
  root="$(cd "$SVC_DIR/versions" 2>/dev/null && pwd -P)" || return 0
  for d in "$root"/open-walnut-stage.*; do
    [[ -d "$d" && "$(dirname "$d")" == "$root" ]] || continue
    svc_keeps_stage "$d" && continue
    rm -rf "$d" 2>/dev/null || true
  done
}

# The run script of a version: `svc_write_run <run file> [<clone dir> <stage dir>]` (server_argv,
# host_prefix set for its file). With a clone, a stage the temp dir lost is put back from it first.
# It leads its own process group, passes its pid down (the server's launcher marks name it), puts the
# server under Walnut.app's session host (a host that refuses it, exit 125, runs the file as its own
# program instead), and once the server ended it waits for the rest of its group, so the launcher never
# starts the next version while the old one still holds the instance lock.
svc_write_run() {
  local run="$1" clone="${2:-}" stage="${3:-}" last w envs="" host="" file
  mkdir -p "$(dirname "$run")" || return 1
  last=$(( ${#server_argv[@]} - 1 ))
  file="${server_argv[$last]}"
  for w in "${server_argv[@]:0:$last}"; do envs="$envs $(svc_shq "$w")"; done
  if [[ -n "${host_prefix[*]+x}" ]] && (( ${#host_prefix[@]} > 0 )); then
    for w in "${host_prefix[@]}"; do host="$host $(svc_shq "$w")"; done
  fi
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' "# Open Walnut: runs one version of this machine's Walnut server for the service launcher."
    printf '%s\n' '# Written by scripts/dev-prod.sh (scripts/lib/devprod-launcher.sh) for this version. Do not edit.'
    printf '%s\n' 'if [ "${WALNUT_RUN_GROUP:-}" != "$$" ] && [ -x /usr/bin/perl ]; then'
    printf '%s\n' '  WALNUT_RUN_GROUP=$$; export WALNUT_RUN_GROUP'
    printf '%s\n' "  exec /usr/bin/perl -e 'setpgrp(0, 0); exec { \$ARGV[0] } @ARGV or exit 127' /bin/sh \"\$0\" \"\$@\""
    printf '%s\n' 'fi'
    printf '%s\n' 'unset WALNUT_RUN_GROUP'
    # The launcher's umask (077) is its own: the server and its sessions get the usual one.
    printf '%s\n' 'umask 022'
    printf 'exec >>%s 2>&1\n' "$(svc_shq "$SERVER_LOG")"
    if [[ -n "$clone" ]]; then
      printf 'if [ ! -x %s ]; then\n' "$(svc_shq "$file")"
      printf '  echo "$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ) run: the stage is gone (a reboot empties the temp dir): putting it back from %s"\n' "$clone"
      printf '  mkdir -p %s && { cp -Rc %s/. %s/ 2>/dev/null || cp -R %s/. %s/; } || exit 1\n' \
        "$(svc_shq "$stage")" "$(svc_shq "$clone")" "$(svc_shq "$stage")" "$(svc_shq "$clone")" "$(svc_shq "$stage")"
      printf '  rm -f %s/run\n' "$(svc_shq "$stage")"
      printf '%s\n' 'fi'
    fi
    printf 'cd %s || exit 1\n' "$(svc_shq "$SERVE_ROOT")"
    printf '%s\n' 'WALNUT_LAUNCHER_SERVICE_PID=$$; export WALNUT_LAUNCHER_SERVICE_PID'
    printf '%s\n' 'c='
    printf 'run() { /usr/bin/env -u OPEN_WALNUT_EPHEMERAL -u OPEN_WALNUT_HOME -u WALNUT_DAEMON_DIR -u WALNUT_DAEMON_STATE_DIR -u WALNUT_DAEMON_SUPERVISOR -u VITEST -u WALNUT_RUNTIME_DIR -u BUN_BE_BUN -u WALNUT_LAUNCHER -u WALNUT_LAUNCHD_LABEL -u L_LOCKED PATH=%s%s "$@" %s web --port %s </dev/null & c=$!; }\n' \
      "$(svc_shq "$PATH")" "$envs" "$(svc_shq "$file")" "$(svc_shq "$PORT")"
    printf '%s\n' 'term=0'
    printf '%s\n' 'trap '"'"'term=1; [ -n "$c" ] && kill -TERM "$c" 2>/dev/null'"'"' TERM INT HUP'
    printf '%s\n' 'wait_c() { while :; do wait "$c"; r=$?; kill -0 "$c" 2>/dev/null || return $r; done; }'
    printf '%s\n' 'at=$(date +%s)'
    printf 'run%s\n' "$host"
    printf '%s\n' 'wait_c; rc=$?'
    if [[ -n "$host" ]]; then
      printf '%s\n' 'if [ "$rc" = 125 ] && [ "$term" = 0 ] && [ $(( $(date +%s) - at )) -lt 30 ]; then'
      printf '%s\n' "  echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) run: Walnut.app's session host refused the server (exit 125): running the file as its own program\""
      printf '%s\n' '  run; wait_c; rc=$?'
      printf '%s\n' 'fi'
    fi
    # The server's own children that share the group (not its sessions: they have their own) end with it.
    printf '%s\n' 'n=0; while [ "$n" -lt 600 ] && pgrep -g $$ -f " web --port " >/dev/null 2>&1; do sleep 0.1; n=$((n + 1)); done'
    printf '%s\n' 'exit $rc'
  } > "$run.tmp" && chmod 700 "$run.tmp" && mv -f "$run.tmp" "$run"
}

# Write the launcher script (its seed: $SVC_SEED), through the new build's file.
svc_write_launcher() {
  local seed="$SVC_SEED" tmp="$SVC_SCRIPT.$$.tmp"
  mkdir -p "$SVC_L" && chmod 700 "$SVC_DIR" "$SVC_L" || return 1
  # runs-plain: prints a script, opens no connection, ends at once.
  if ! env -u BUN_BE_BUN -u WALNUT_RUNTIME_DIR WALNUT_RUNTIME_DIR="$(dirname "$(dirname "$SERVER_FILE")")/runtime" \
    "$SERVER_FILE" __service-launcher-script --state "$SVC_DIR" --seed "$seed" --self "$SVC_SCRIPT" --trial "$SVC_TRIAL_SECS" > "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  [[ "$(sed -n 3p "$tmp")" == '# walnut-launcher/1' ]] || { echo "The launcher this build printed is no launcher." >&2; rm -f "$tmp"; return 1; }
  # An unchanged script stays as it is: the launcher runs a rewritten one again in place.
  if [[ -f "$SVC_SCRIPT" ]] && cmp -s "$tmp" "$SVC_SCRIPT"; then rm -f "$tmp"; return 0; fi
  chmod 700 "$tmp" && mv -f "$tmp" "$SVC_SCRIPT"
}

# The launchd job that runs the launcher (write_launchd_plist with launchd_argv): Interactive, KeepAlive,
# RunAtLoad, the QoS mark, the server log, as the job that ran the server before.
svc_write_plist() {
  local tmp="$SVC_PLIST.$$.tmp"
  mkdir -p "$(dirname "$SVC_PLIST")" || return 1
  launchd_argv=(/bin/sh "$SVC_SCRIPT")
  write_launchd_plist "$tmp" || { rm -f "$tmp"; return 1; }
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint -s "$tmp" >/dev/null 2>&1; then rm -f "$tmp"; return 1; fi
  mv -f "$tmp" "$SVC_PLIST"
}

svc_mark() {
  local tmp="$SVC_MARK.$$.tmp"
  mkdir -p "$(dirname "$SVC_MARK")" 2>/dev/null || return 0
  printf '{"state":"%s","label":"%s","plist":"%s"}\n' "$SVC_DIR" "$LAUNCH_LABEL" "$SVC_PLIST" > "$tmp" 2>/dev/null && mv -f "$tmp" "$SVC_MARK" 2>/dev/null || rm -f "$tmp"
  return 0
}
svc_unmark() { rm -f "$SVC_MARK" 2>/dev/null || true; }

# A server on :PORT the launcher did not start (the Mac app's own, a stray) is stopped before the
# switch, as the old deploy stops any listener: else the trial loses the instance lock to it.
svc_stop_foreign_listener() {
  local l svc g n
  svc="$(svc_service_pid)"
  for l in $(listener_pids); do
    g="$(ps -o pgid= -p "$l" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -n "$svc" && "$g" == "$svc" ]] && continue
    echo "Stopping PID $l on :$PORT, which the service launcher did not start: $(ps -o command= -p "$l" 2>/dev/null | cut -c1-160)" >&2
    kill -15 "$l" 2>/dev/null || true
    n=0; while kill -0 "$l" 2>/dev/null && (( n < ${STOP_GRACE_SECS:-8} * 4 )); do sleep 0.25; n=$(( n + 1 )); done
    kill -0 "$l" 2>/dev/null && kill -9 "$l" 2>/dev/null || true
  done
  return 0
}

# Take the launcher away (the way back): its job (its TERM stops the server), the plist, the mark.
svc_uninstall() {
  local svc n=0
  svc="$(svc_service_pid)"
  remove_launchd_job || true
  # launchd ends a job that does not stop in time with SIGKILL, which leaves its service to run on.
  while [[ -n "$svc" ]] && kill -0 "$svc" 2>/dev/null && (( n < 120 )); do sleep 0.25; n=$(( n + 1 )); done
  if [[ -n "$svc" ]] && kill -0 "$svc" 2>/dev/null; then kill -KILL -"$svc" 2>/dev/null || kill -KILL "$svc" 2>/dev/null || true; fi
  rm -f "$SVC_PLIST" 2>/dev/null || true
  svc_unmark
  echo "Service launcher removed: the server runs as launchd job '$LAUNCH_LABEL' again, with no launcher." >&2
}

svc_now() { perl -MTime::HiRes=time -e 'printf "%.2f", time' 2>/dev/null || date +%s; }

# Ask the launcher: `svc_request switch <exe> <build>` or `svc_request rollback <exe> <reason>`. Sets svc_id.
svc_request() {
  local op="$1" exe="$2" extra="$3" tmp="$SVC_L/request.tmp.$$"
  svc_id="d$(date +%s)$$"
  if [[ "$op" == switch ]]; then
    printf 'id=%s\nop=switch\nexe=%s\nbuild=%s\nprepared=1\nat=%s\n' "$svc_id" "$exe" "$extra" "$(date +%s)" > "$tmp"
  else
    printf 'id=%s\nop=rollback\nexe=%s\nreason=%s\nprepared=1\nat=%s\n' "$svc_id" "$exe" "${extra//$'\n'/ }" "$(date +%s)" > "$tmp"
  fi
  mv -f "$tmp" "$SVC_L/request"
}

# Wait for the launcher's answer to svc_id for at most $1 s: sets svc_outcome (committed, rolledback,
# refused, failed, interrupted, current; "timeout"; "gone" when the launcher is not running) and
# svc_reason. While it waits it reads :PORT, so svc_dark says how long it answered nothing.
svc_wait_result() {
  local secs="$1" deadline r_id dark_from="" t
  deadline=$(( SECONDS + secs ))
  svc_outcome=""; svc_reason=""; svc_dark=""
  while (( SECONDS < deadline )); do
    r_id="$(svc_get "$SVC_L/result" id)"
    if [[ -z "$svc_outcome" && "$r_id" == "$svc_id" ]]; then
      svc_outcome="$(svc_get "$SVC_L/result" outcome)"; svc_reason="$(svc_get "$SVC_L/result" reason)"
      # Answered: the version it serves now (the new one, or the good one put back) gets 2 minutes to answer.
      (( deadline > SECONDS + 120 )) && deadline=$(( SECONDS + 120 ))
    fi
    if curl --connect-timeout 1 --max-time 1 -sf "http://localhost:$PORT/api/config" >/dev/null 2>&1; then
      if [[ -n "$dark_from" && -z "$svc_dark" ]]; then
        t="$(svc_now)"; svc_dark="$(awk -v a="$dark_from" -v b="$t" 'BEGIN { printf "%.1f", b - a }')"
      fi
      [[ -n "$svc_outcome" ]] && return 0
    elif [[ -z "$dark_from" ]]; then
      dark_from="$(svc_now)"
    fi
    if [[ -z "$(svc_launcher_pid)" ]]; then svc_outcome=gone; return 0; fi
    sleep 0.2
  done
  [[ -n "$svc_outcome" ]] || svc_outcome=timeout
}

# The build's commit, for the check that the server serves this deploy (empty when not a git checkout).
svc_build_commit() { git -C "$REPO_ROOT" rev-parse --verify --quiet HEAD 2>/dev/null || true; }

# The checks after the launcher committed the new version, the same as the old path's after its
# readiness (nice, GET /, live render), plus two it did not have: :PORT is served by the launcher's
# service (its process group), and that server reports this deploy's commit. 0 when all hold.
svc_check_served() {
  local cfg nice served want l g svc
  cfg="$(curl --connect-timeout 1 --max-time 5 -sf "http://localhost:$PORT/api/config" 2>/dev/null || true)"
  if [[ -z "$cfg" ]]; then echo "The new server does not answer /api/config." >&2; return 1; fi
  nice="$(printf '%s' "$cfg" | sed -n 's/.*"processNice"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p' | head -n 1 || true)"
  if [[ "$nice" =~ ^-?[0-9]+$ ]] && (( nice > 0 )); then echo "New server inherited nice=$nice." >&2; return 1; fi
  want="$(svc_build_commit)"
  served="$(printf '%s' "$cfg" | "$JS_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=JSON.parse(s).build||{};if(/^[0-9a-f]{7,40}$/.test(b.commit||""))process.stdout.write(b.commit)}catch{}})' 2>/dev/null || true)"
  if [[ -n "$want" && -n "$served" && "$want" != "$served"* ]]; then
    echo ":$PORT reports commit $served, not this deploy's ${want:0:12}: another server answers." >&2; return 1
  fi
  l="$(listener_pids | sed -n 1p)"; svc="$(svc_service_pid)"
  if [[ -n "$l" && -n "$svc" ]]; then
    g="$(ps -o pgid= -p "$l" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$g" != "$svc" ]] && ! ps -o command= -p "$l" 2>/dev/null | grep -qF "$STAGE_DIR/"; then
      echo ":$PORT is served by PID $l, which the launcher did not start (its service is $svc)." >&2; return 1
    fi
  fi
  local index_html
  index_html="$(curl --connect-timeout 1 --max-time 5 -sf "http://localhost:$PORT/" 2>/dev/null || true)"
  case "$index_html" in
    *"<script"*"assets/index-"*) ;;
    *) echo "Server answers /api/config but cannot serve the web app from its runtime tree under $STAGE_DIR/runtime." >&2; return 1 ;;
  esac
  if [[ "${WALNUT_DEVPROD_SKIP_RENDER:-0}" != "1" ]]; then
    local rc=0
    "$JS_BIN" "$REPO_ROOT/scripts/devprod-render-check.mjs" "http://localhost:$PORT/" --timeout-ms "$(( ${WALNUT_DEVPROD_RENDER_SECS:-60} * 1000 ))" || rc=$?
    if [[ "$rc" == "2" && "${WALNUT_DEVPROD_RENDER_STRICT:-0}" != "1" ]]; then
      echo "Live render UNDETERMINED: keeping the new server (WALNUT_DEVPROD_RENDER_STRICT=1 fails closed here)." >&2; rc=0
    fi
    if [[ "$rc" != "0" ]]; then echo "Live render FAILED: :$PORT serves the app but crashes on the first paint of /." >&2; return 1; fi
  fi
  return 0
}

# The seed: a run script for the last-known-good copy, approved under the session host (the host
# hashes the file, so it is approved again whenever the LKG changes). With no LKG yet, this deploy's
# version (its clone puts its stage back, as its own run script does).
svc_write_seed() {
  local lkg rc=0 clone=""
  lkg="$(lkg_file)"
  if [[ -z "$lkg" ]]; then
    svc_argv_for_new
    clone="${svc_run%/run}"
  else
    set_server_argv "$lkg"
    host_prefix=()
    if [[ "${WALNUT_SESSION_HOST:-1}" != "0" ]]; then
      host_env=("${server_argv[@]:0:$(( ${#server_argv[@]} - 1 ))}")
      host_prefix_for "$lkg" web --port "$PORT"
    fi
  fi
  if [[ -n "$clone" ]]; then svc_write_run "$SVC_SEED" "$clone" "$STAGE_DIR" || rc=1; else svc_write_run "$SVC_SEED" || rc=1; fi
  set_server_argv "$SERVER_FILE"
  return "$rc"
}

# Ask for the switch to this deploy's run and judge it. 0 when the new version serves and passed the
# checks; else 1, with the launcher back on its good version (a put-back it made or one asked here).
svc_switch() {
  local run="$svc_run" build
  build="$(svc_build_commit)"; build="${build:0:12}"
  STAGE_IN_USE=1
  STOP_STARTED=1
  echo "Asking the service launcher to switch to $run (a trial until the new server says it is ready)."
  svc_request switch "$run" "${build:-unknown}"
  svc_wait_result $(( 60 * 2 + 900 + 30 ))
  echo "Switch: :$PORT answered nothing for ${svc_dark:-under 0.2} s."
  if [[ "$svc_outcome" != committed ]]; then
    echo "The service launcher did not take the new version ($svc_outcome${svc_reason:+: $svc_reason}); it serves the good one." >&2
    if [[ "$svc_outcome" == timeout ]]; then svc_request rollback "$run" "the deploy gave up waiting for it"; svc_wait_result 120; fi
    return 1
  fi
  if ! svc_check_served; then
    echo "Asking the service launcher to put the previous version back." >&2
    svc_request rollback "$run" "the deploy's checks after the switch failed"
    svc_wait_result 300
    echo "Rollback: $svc_outcome${svc_reason:+ ($svc_reason)}." >&2
    return 1
  fi
  return 0
}

# server_argv and host_prefix for this deploy's file (approved while the old server still served).
svc_argv_for_new() {
  set_server_argv "$SERVER_FILE"
  host_prefix=(${preapproved_prefix[@]+"${preapproved_prefix[@]}"})
}

# The deploy with the launcher installed: everything before the stop already ran. Exits.
svc_deploy() {
  svc_argv_for_new
  svc_save_version || { echo "Could not keep this version under $SVC_DIR/versions; prod untouched." >&2; exit 1; }
  [[ -x "$SVC_SEED" ]] || svc_write_seed || true
  svc_write_launcher || { echo "Could not write the launcher script; prod untouched." >&2; exit 1; }
  if [[ -z "$(svc_launcher_pid)" ]]; then
    # Installed but not running (its job was taken out by hand): load it; it starts its current version.
    LAUNCHD_DOMAIN="$(launchd_domain)"
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$SVC_PLIST" >/dev/null 2>&1 || true
    if ! svc_wait_launcher 30; then echo "The service launcher is not running and could not be loaded; prod untouched." >&2; exit 1; fi
  fi
  svc_mark
  svc_stop_foreign_listener
  if ! svc_switch; then restore_serving_dist; exit 1; fi
  svc_finish
}

# The first deploy with the launcher (SVC_MODE install): the old server is stopped by now, the old way.
# The launcher job starts with the LKG as its seed and good version and this build as a switch it finds
# waiting, so the first version goes through the same trial as every later one. Exits.
svc_first_start() {
  rm -rf "$SVC_L" 2>/dev/null || true
  svc_argv_for_new
  if ! svc_save_version || ! svc_write_seed || ! svc_write_launcher || ! svc_write_plist; then
    echo "Could not write the service launcher; starting the server the old way." >&2
    rm -f "$SVC_PLIST"; return 1
  fi
  mkdir -p "$SVC_L" && chmod 700 "$SVC_L"
  local build; build="$(svc_build_commit)"
  svc_request switch "$svc_run" "${build:0:12}"
  STAGE_IN_USE=1
  LAUNCHD_DOMAIN="${LAUNCHD_DOMAIN:-$(launchd_domain)}"
  # A pid an earlier launcher left must not read as this one.
  rm -f "$SVC_DIR/daemon-boot.pid"
  if ! launchctl bootstrap "$LAUNCHD_DOMAIN" "$SVC_PLIST" 2>&1 || ! svc_wait_launcher 30; then
    echo "launchctl would not load and start the service launcher; starting the server the old way." >&2
    remove_launchd_job || true
    rm -f "$SVC_PLIST" "$SVC_L/request"; return 1
  fi
  svc_mark
  echo "Service launcher installed: $SVC_PLIST runs $SVC_SCRIPT, which keeps the server."
  # The request is already there: wait for its answer like any switch.
  svc_wait_result $(( 900 + 60 ))
  if [[ "$svc_outcome" == committed ]] && svc_check_served; then svc_finish; fi
  echo "The first start under the service launcher failed ($svc_outcome${svc_reason:+: $svc_reason}); taking the launcher away and rolling back." >&2
  svc_uninstall
  rollback_to_lkg
  exit 1
}

# After a switch that held: the LKG copy follows the launcher's good version (not this build: it is in
# its probation), the seed with it, then the usual end. Exits 0.
svc_finish() {
  local good good_stage
  good="$(svc_get "$SVC_L/state" good)"
  good_stage="${good%/run}"
  if [[ "$good" == */run && -d "$good_stage/dist-bin" && "$(cat "$SVC_DIR/lkg-from" 2>/dev/null || true)" != "$good_stage" ]]; then
    local STAGE_DIR="$good_stage"
    if snapshot_lkg; then
      printf '%s\n' "$good_stage" > "$SVC_DIR/lkg-from"
      svc_write_seed || echo "Warning: the launcher's seed was not rewritten for the new last-known-good copy." >&2
    else
      echo "Warning: last-known-good snapshot failed; the launcher still holds its good version." >&2
    fi
  fi
  sweep_old_stages
  svc_prune_versions
  date +%s > "$SUCCESS_STAMP"
  echo "Server ready (PID: $(listener_pids | sed -n 1p), $RUNTIME_DESC, kept by the service launcher)"
  if [[ -n "$CLI_NOT_PUBLISHED" ]]; then
    echo "Deploy incomplete: the server runs the new build, but the walnut CLI in $CLI_NOT_PUBLISHED was NOT updated and keeps its last build, so its op help can be older than the server's (the publish's error is above). Deploy again with WALNUT_DEVPROD_FORCE=1 to publish it."
  fi
  exit 0
}
