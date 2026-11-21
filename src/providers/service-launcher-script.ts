/**
 * The service launcher: one small POSIX sh script (dash and bash 3.2 run it; it loads no Walnut
 * code) that systemd (a user unit, Restart=always), launchd (a LaunchAgent, KeepAlive) or cron
 * (@reboot plus a check every minute) starts, and that keeps the service running. Behind the
 * experiment `service_launcher` (src/core/experimental.ts); with it off nothing here is written.
 *
 * What it does, once a second:
 *  - runs the current version (`<exe> --service`), and starts it again when it exits: 1 s after a
 *    clean exit, after a failure 1, 2, 4 ... 30 s (never gives up);
 *  - ends and restarts a service whose heartbeat (`launcher/heartbeat`, `<epoch> <busy until> <pid>`,
 *    written by the service every few seconds) is older than STALL_SECONDS, unless the service said
 *    it is doing one long thing (busy until a time, at most BUSY_MAX_SECONDS ahead of its beat);
 *  - is the only writer of `launcher/state` (current, good, phase), atomically (temp file, rename);
 *  - takes a switch asked in `launcher/request` (written by `walnut daemon update`): writes the new
 *    version as a trial first, stops the old one, starts the new one, and commits it only when the
 *    service wrote `launcher/ready` (its sessions adopted, its port listening). For PROBATION_SECONDS
 *    after that, a second failure puts the previous good version back; past them, it is the good one.
 *    A trial that exits or is not ready in TRIAL_SECONDS is put back at once. A put-back ends the work
 *    the new version started that an older one cannot follow (`detached/stop-detached.sh`, written by
 *    that work's registry, src/providers/detached-registry.ts), refuses that version for a day, and
 *    leaves `launcher/rollback`, which the service reports to Walnut Health when it is up.
 *  - A trial found at start (the launcher or the machine stopped mid-switch) is the old version again
 *    unless the trial process still runs and had become ready.
 *
 * One launcher per state dir: an flock on `launcher/lock` (flock(1), else perl's flock, else a pid
 * dir), never handed to the service. A launcher that comes back while its service still runs (the
 * pid and its start time match `launcher/service.pid`) watches it on and starts no second one.
 * SIGTERM or SIGINT (a stop of its unit or job) stops the service, then the launcher. A changed script
 * (an update wrote a newer launcher) is run again in place, outside a switch; the service it ran
 * is watched on by pid (its exit code is then unknown, and its zombie stays until the launcher ends).
 *
 * For the cron backend the script lives where the boot script was (daemon-boot.sh) and keeps that
 * file's header and its EXEC line, so an older Walnut can still read and rewrite it: an EXEC that is
 * not the one the launcher last followed (`pin`) is a version someone else chose, which it runs.
 */
import { DAEMON_BOOT_SCRIPT_HEADER, DAEMON_BOOT_PID_NAME, DAEMON_BOOT_STOP_NAME, shq } from './daemon-service-boot-script.js'
import { checkDaemonServiceConfig, type DaemonServiceConfig } from './daemon-service-config.js'

export const LAUNCHER_MARK = '# walnut-launcher/1'
export const LAUNCHER_HEADER = '# Open Walnut service launcher: keeps the session daemon running (started by systemd, launchd or cron).'
/** The launcher's file for systemd and launchd, in the install root (cron's is daemon-boot.sh). */
export const LAUNCHER_SCRIPT_NAME = 'walnut-launcher.sh'
/** Its own files, in the install root. */
export const LAUNCHER_DIR_NAME = 'launcher'
export const STALL_SECONDS = 60
export const BUSY_MAX_SECONDS = 3600
export const TRIAL_SECONDS = 90
export const PROBATION_SECONDS = 15 * 60
export const PROBATION_CRASHES = 2
export const BAD_SECONDS = 24 * 60 * 60
export const STOP_WAIT_SECONDS = 60
export const BACKOFF_MAX_SECONDS = 30
/** A request written before the old service prepared (prepared=0) that never got further is dropped after this. */
export const REQUEST_WAIT_SECONDS = 120
/** How long the launcher waits for the registry's stop script on a put-back. */
export const STOP_DETACHED_SECONDS = 60
const LOG_MAX_BYTES = 1024 * 1024

export interface LauncherScriptOptions {
  /** cron: written as daemon-boot.sh, with that file's header (an older Walnut reads it). */
  backend: 'systemd' | 'launchd' | 'cron'
  /** Where the script itself is. */
  self: string
  /** Tests only: shorter clocks. */
  clocks?: Partial<{ stall: number; trial: number; probation: number; tick: number; stopWait: number }>
}

/** The text of the launcher for `config` (config.executable is the seed: the version it runs when it has no state yet). */
export function renderLauncherScript(config: DaemonServiceConfig, o: LauncherScriptOptions): string {
  const c = checkDaemonServiceConfig({ ...config, platform: 'linux' })
  if (!o.self.startsWith('/') || /[\u0000-\u001f\u007f]/.test(o.self)) throw new Error('launcher path must be absolute')
  const k = { stall: STALL_SECONDS, trial: TRIAL_SECONDS, probation: PROBATION_SECONDS, tick: 1, stopWait: STOP_WAIT_SECONDS, ...o.clocks }
  return [
    '#!/bin/sh',
    o.backend === 'cron' ? DAEMON_BOOT_SCRIPT_HEADER : LAUNCHER_HEADER,
    LAUNCHER_MARK,
    '# Written by `walnut daemon install`; an update rewrites it. Do not edit. src/providers/service-launcher-script.ts',
    `EXEC=${shq(c.executable)}`,
    `ARGS=${shq(c.args.join(' '))}`,
    `SELF=${shq(o.self)}`,
    `STATE=${shq(c.stateDir)}`,
    `export HOME=${shq(c.home)}`,
    `export PATH=${shq(c.path)}`,
    `export WALNUT_DAEMON_DIR=${shq(c.runtimeDir)}`,
    `export WALNUT_DAEMON_STATE_DIR=${shq(c.stateDir)}`,
    `export WALNUT_DAEMON_SUPERVISOR=${o.backend === 'cron' ? 'cron' : 'launcher'}`,
    `L="$STATE"/${LAUNCHER_DIR_NAME}`,
    'export WALNUT_LAUNCHER_DIR="$L"',
    `K_STALL=${k.stall}; K_TRIAL=${k.trial}; K_PROB=${k.probation}; K_TICK=${k.tick}; K_STOP=${k.stopWait}`,
    'umask 077',
    'cd "$HOME" || exit 1',
    `[ -e "$STATE"/${DAEMON_BOOT_STOP_NAME} ] && exit 0`,
    'mkdir -p "$L" || exit 1',
    ...BODY,
    '',
  ].join('\n')
}

/** Is this text a launcher this build or a later one wrote? */
export function isLauncherScript(text: string): boolean {
  return text.split('\n')[2] === LAUNCHER_MARK
}

const BODY: string[] = String.raw`
LOG="$L/launcher.log"
l_now() { date +%s; }
l_log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$*" >> "$LOG" 2>/dev/null; }
l_rotate() { lo_s=$(wc -c < "$LOG" 2>/dev/null); lo_s=$((lo_s + 0)); [ "$lo_s" -gt ${LOG_MAX_BYTES} ] && mv -f "$LOG" "$LOG.1"; :; }
l_num() { case $1 in ''|*[!0-9]*) return 1;; esac; return 0; }
# A live process, not a zombie: kill -0 alone answers yes for a child nobody waited for.
l_alive() {
  l_num "$1" || return 1; [ "$1" -gt 1 ] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then
    la_s=; read -r la_s < "/proc/$1/stat" 2>/dev/null || return 1
    la_s=${"$"}{la_s##*") "}; case $la_s in Z*|X*) return 1;; esac
  else
    case $(ps -o stat= -p "$1" 2>/dev/null) in *Z*) return 1;; esac
  fi
  return 0
}
# A process's start time, its blanks folded (macOS pads ps columns), to tell a pid used again.
l_start_of() { lso=$(LC_ALL=C ps -ww -o lstart= -p "$1" 2>/dev/null); set -f; set -- $lso; set +f; printf '%s' "$*"; }
# One launcher per state dir. fd 9 stays open across a re-exec (L_LOCKED), and never reaches the service.
l_lock() {
  if command -v flock >/dev/null 2>&1; then flock -n 9; return; fi
  if command -v perl >/dev/null 2>&1; then
    perl -e 'use Fcntl qw(:flock); open(my $f, ">&=", 9) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1; exit 0'; return
  fi
  if mkdir "$L/lock.d" 2>/dev/null; then echo $$ > "$L/lock.d/pid"; return 0; fi
  ll_p=$(cat "$L/lock.d/pid" 2>/dev/null); [ "$ll_p" = "$$" ] && return 0
  l_alive "$ll_p" && return 1
  rm -rf "$L/lock.d"; mkdir "$L/lock.d" 2>/dev/null && echo $$ > "$L/lock.d/pid"
}
if [ -z "${"$"}{L_LOCKED:-}" ]; then
  exec 9>>"$L/lock" || exit 1
  l_lock || exit 0
fi
export L_LOCKED=1
echo $$ > "$STATE/${DAEMON_BOOT_PID_NAME}"
l_rotate

s_cur=; s_good=; s_phase=; s_since=0; s_crash=0; s_pin=; s_build=; s_gbuild=; s_req=
l_read() {
  s_cur=; s_good=; s_phase=; s_since=0; s_crash=0; s_pin=; s_build=; s_gbuild=; s_req=
  [ -s "$L/state" ] || return 1
  while IFS='=' read -r lr_k lr_v; do
    case $lr_k in
      current) s_cur=$lr_v;; good) s_good=$lr_v;; phase) s_phase=$lr_v;; since) s_since=$lr_v;;
      crashes) s_crash=$lr_v;; pin) s_pin=$lr_v;; build) s_build=$lr_v;; good_build) s_gbuild=$lr_v;; request) s_req=$lr_v;;
    esac
  done < "$L/state"
  l_num "$s_since" || s_since=0; l_num "$s_crash" || s_crash=0
  [ -n "$s_cur" ]
}
l_write() {
  printf 'current=%s\ngood=%s\nphase=%s\nsince=%s\ncrashes=%s\npin=%s\nbuild=%s\ngood_build=%s\nrequest=%s\nlauncher=%s\n' \
    "$s_cur" "$s_good" "$s_phase" "$s_since" "$s_crash" "$s_pin" "$s_build" "$s_gbuild" "$s_req" "$$" > "$L/state.tmp.$$" \
    && mv -f "$L/state.tmp.$$" "$L/state"
}
# key=value line of a small file (request, ready): l_get FILE KEY
l_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
l_result() { # id outcome exe reason
  printf 'id=%s\noutcome=%s\nexe=%s\nat=%s\nreason=%s\n' "$1" "$2" "$3" "$(l_now)" "$4" > "$L/result.tmp.$$" && mv -f "$L/result.tmp.$$" "$L/result"
}
l_bad() { # exe: refused when it failed here in the last day
  [ -f "$L/bad" ] || return 1
  lb_n=$(l_now)
  while read -r lb_t lb_e; do
    [ "$lb_e" = "$1" ] && l_num "$lb_t" && [ $((lb_n - lb_t)) -lt ${BAD_SECONDS} ] && return 0
  done < "$L/bad"
  return 1
}

c_pid=; c_last=; c_own=0; c_at=0; c_exe=; c_code=; fails=0; next_start=0
l_spawn() {
  rm -f "$L/ready" "$L/leaving"
  "$1" $ARGS 9>&- </dev/null >>"$STATE/daemon-service.out.log" 2>>"$STATE/daemon-service.err.log" &
  c_pid=$!; c_own=1; c_at=$(l_now); c_exe=$1; c_code=
  printf '%s\n%s\n%s\n' "$c_pid" "$1" "$(l_start_of "$c_pid")" > "$L/service.pid.tmp" && mv -f "$L/service.pid.tmp" "$L/service.pid"
  l_log "started $1 (pid $c_pid, phase $s_phase)"
}
l_reap() {
  if [ "$c_own" = 1 ]; then wait "$c_pid" 2>/dev/null; c_code=$?; else c_code=unknown; fi
  c_last=$c_pid; c_pid=; rm -f "$L/service.pid"
}
# Stop the service: TERM, then KILL after $1 s.
l_stop() {
  [ -n "$c_pid" ] || return 0
  if l_alive "$c_pid"; then
    kill -TERM "$c_pid" 2>/dev/null
    ls_n=0; while l_alive "$c_pid" && [ "$ls_n" -lt $(($1 * 10)) ]; do sleep 0.1 9>&-; ls_n=$((ls_n + 1)); done
    if l_alive "$c_pid"; then l_log "pid $c_pid did not stop in $1 s: KILL"; kill -KILL "$c_pid" 2>/dev/null; sleep 0.2; fi
  fi
  l_reap
}
# Run "$@" for at most $1 s.
l_bounded() {
  lt_s=$1; shift
  "$@" 9>&- </dev/null >>"$LOG" 2>&1 &
  lt_p=$!; lt_n=0
  while l_alive "$lt_p" && [ "$lt_n" -lt $((lt_s * 10)) ]; do sleep 0.1 9>&-; lt_n=$((lt_n + 1)); done
  l_alive "$lt_p" && { l_log "gave up waiting for $1 after $lt_s s"; kill -KILL "$lt_p" 2>/dev/null; }
  wait "$lt_p" 2>/dev/null; :
}
# The service went back to the good version: why, from which, to which. $2 = keep: not the version's
# fault (a switch cut off by a power loss), so it is not refused for a day.
l_rollback() {
  lr_bad=$s_cur; lr_why=$1; lr_keep=${"$"}{2:-}
  if [ -z "$s_good" ] || [ "$s_good" = "$lr_bad" ]; then
    l_log "$lr_why; there is no earlier good version to go back to, so $lr_bad is started again"
    [ -n "$s_req" ] && l_result "$s_req" failed "$lr_bad" "$lr_why"
    s_req=; s_phase=committed; s_since=$(l_now); s_crash=0; l_write
    return 0
  fi
  l_log "rolling back from $lr_bad to $s_good: $lr_why"
  l_stop "$K_STOP"
  if [ -f "$STATE/detached/stop-detached.sh" ]; then
    l_log "ending the work $lr_bad started that $s_good cannot follow"
    l_bounded ${STOP_DETACHED_SECONDS} /bin/sh "$STATE/detached/stop-detached.sh" "$STATE/detached"
  fi
  lr_n=$(l_now)
  [ -z "$lr_keep" ] && { [ -f "$L/bad" ] && tail -n 19 "$L/bad"; printf '%s %s\n' "$lr_n" "$lr_bad"; } > "$L/bad.tmp.$$" && mv -f "$L/bad.tmp.$$" "$L/bad"
  # The hold an older update runner already reads (daemon-update-probation.ts PROBATION_FAILED_NAME).
  [ -z "$lr_keep" ] && [ -n "$s_build" ] && printf '%s\n%s\n%s\n' "$s_build" "$lr_n" "$lr_why" > "$STATE/update-probation.failed.tmp" \
    && mv -f "$STATE/update-probation.failed.tmp" "$STATE/update-probation.failed"
  printf 'at=%s\nfrom=%s\nto=%s\nbuild=%s\nreason=%s\n' "$lr_n" "$lr_bad" "$s_good" "$s_build" "$lr_why" > "$L/rollback.tmp" && mv -f "$L/rollback.tmp" "$L/rollback"
  [ -n "$s_req" ] && l_result "$s_req" rolledback "$lr_bad" "$lr_why"
  s_cur=$s_good; s_build=$s_gbuild; s_phase=committed; s_since=$lr_n; s_crash=0; s_req=; l_write
  fails=0; next_start=0
}
# The service exited (or was ended for a stalled heartbeat) without being asked to.
l_exited() {
  le_up=$(( $(l_now) - c_at )); le_why="exited with $1 after $le_up s"
  le_left=$(l_get "$L/leaving" pid); le_for=$(l_get "$L/leaving" reason); rm -f "$L/leaving"
  if [ -n "$le_left" ] && [ "$le_left" = "$c_last" ]; then
    # It said it was leaving on purpose (it prepared for an update an older Walnut runs): no crash, no wait.
    l_log "$c_exe left on purpose (${"$"}{le_for:-planned}) after $le_up s"
    fails=0; next_start=$(l_now); return
  fi
  l_log "$c_exe $le_why"
  case $s_phase in
    trial) l_rollback "the new version $le_why, before it was ready"; return;;
    probation)
      if [ "$1" != 0 ]; then
        s_crash=$((s_crash + 1)); l_write
        if [ "$s_crash" -ge ${PROBATION_CRASHES} ]; then l_rollback "the new version failed $s_crash times in its first $((K_PROB / 60)) minutes (last: $le_why)"; return; fi
      fi;;
  esac
  if [ "$1" = 0 ] || [ "$le_up" -ge 60 ]; then fails=0; else fails=$((fails + 1)); fi
  le_d=1; le_i=1; while [ "$le_i" -lt "$fails" ] && [ "$le_d" -lt ${BACKOFF_MAX_SECONDS} ]; do le_d=$((le_d * 2)); le_i=$((le_i + 1)); done
  [ "$le_d" -gt ${BACKOFF_MAX_SECONDS} ] && le_d=${BACKOFF_MAX_SECONDS}
  next_start=$(( $(l_now) + le_d ))
}
# A request from walnut daemon update: switch to exe (op=switch), or put the good version back (op=rollback).
l_request() {
  lq_id=$(l_get "$L/request" id); lq_exe=$(l_get "$L/request" exe); lq_op=$(l_get "$L/request" op)
  lq_b=$(l_get "$L/request" build); lq_p=$(l_get "$L/request" prepared); lq_at=$(l_get "$L/request" at)
  [ "$lq_id" = "$s_req" ] && [ "$s_phase" = trial ] && { rm -f "$L/request"; return 0; }
  if [ "$lq_op" = rollback ]; then
    rm -f "$L/request"; s_req=$lq_id
    lq_why=$(l_get "$L/request" reason)
    if [ "$lq_exe" = "$s_cur" ] && [ "$s_good" != "$s_cur" ]; then l_rollback "${"$"}{lq_why:-asked to put the previous version back}"
    else l_result "$lq_id" current "$s_cur" "nothing to put back"; s_req=; fi
    return 0
  fi
  case $lq_exe in /*) ;; *) rm -f "$L/request"; l_result "$lq_id" refused "$lq_exe" "not an absolute path"; return 0;; esac
  if [ ! -x "$lq_exe" ]; then rm -f "$L/request"; l_result "$lq_id" refused "$lq_exe" "not an executable file"; return 0; fi
  if l_bad "$lq_exe"; then rm -f "$L/request"; l_result "$lq_id" refused "$lq_exe" "this version failed here in the last day"; return 0; fi
  if [ "$lq_exe" = "$s_cur" ] && [ "$s_phase" != trial ]; then rm -f "$L/request"; l_result "$lq_id" committed "$lq_exe" "already the current version"; return 0; fi
  if [ "$lq_p" != 1 ]; then
    # Written before the running service prepared for its update: wait for prepared=1 (or its removal).
    l_num "$lq_at" && [ $(( $(l_now) - lq_at )) -le ${REQUEST_WAIT_SECONDS} ] && return 1
    l_log "dropped a switch to $lq_exe that never got ready to start"; rm -f "$L/request"; return 0
  fi
  l_log "switching from $s_cur to $lq_exe"
  [ "$s_phase" = committed ] && { s_good=$s_cur; s_gbuild=$s_build; }
  s_cur=$lq_exe; s_build=$lq_b; s_phase=trial; s_since=$(l_now); s_crash=0; s_req=$lq_id; l_write
  rm -f "$L/request"
  l_stop "$K_STOP"
  fails=0; l_spawn "$s_cur"
}
# The script was rewritten: a newer launcher runs on in place (its service watched on by pid); a script
# that is no launcher any more (the experiment turned off: the classic boot script) gets a stopped service.
l_selfcheck() {
  [ "$s_phase" = trial ] && return 0; [ -f "$L/request" ] && return 0
  lc_sum=$(cksum < "$SELF" 2>/dev/null); [ -n "$lc_sum" ] && [ "$lc_sum" != "$l_sum" ] || return 0
  if [ "$(sed -n 3p "$SELF")" = '${LAUNCHER_MARK}' ]; then l_log "the launcher script changed: running the new one"
  else l_log "the script is no launcher any more: stopping the service and running it"; l_stop "$K_STOP"; fi
  exec /bin/sh "$SELF"
}
l_term() { l_log "stopping (signal): the service first"; l_stop "$K_STOP"; rm -f "$STATE/${DAEMON_BOOT_PID_NAME}"; exit 0; }
trap 'l_term' TERM INT

# Start-up: state, a version someone else chose, the service still running, a switch left unconfirmed.
if ! l_read || [ "$s_pin" != "$EXEC" ]; then
  [ -n "$s_cur" ] && l_log "the script names $EXEC, not $s_pin as before: running it"
  s_cur=$EXEC; s_good=$EXEC; s_phase=committed; s_since=$(l_now); s_crash=0; s_pin=$EXEC; s_build=; s_gbuild=; s_req=; l_write
fi
if [ -f "$L/service.pid" ]; then
  { read -r sp_p; read -r sp_e; read -r sp_s; } < "$L/service.pid"
  if l_alive "$sp_p" && [ -n "$sp_s" ] && [ "$(l_start_of "$sp_p")" = "$sp_s" ]; then
    c_pid=$sp_p; c_exe=$sp_e; c_at=$(l_now); c_own=0
    l_log "watching the service already running (pid $c_pid, $c_exe)"
  else rm -f "$L/service.pid"; fi
fi
if [ "$s_phase" = trial ]; then
  r_p=$(l_get "$L/ready" pid)
  if [ -n "$c_pid" ] && [ "$c_exe" = "$s_cur" ] && [ "$r_p" = "$c_pid" ]; then
    s_phase=probation; s_since=$(l_now); l_write; [ -n "$s_req" ] && l_result "$s_req" committed "$s_cur" ""
    l_log "the trial of $s_cur was ready before the launcher stopped: committed"
  else
    l_rollback "the switch to $s_cur was not confirmed before the launcher or the machine stopped" keep
  fi
fi
if [ -n "$c_pid" ] && [ "$c_exe" != "$s_cur" ]; then l_log "pid $c_pid runs $c_exe, not $s_cur: replacing it"; l_stop "$K_STOP"; fi
l_sum=$(cksum < "$SELF" 2>/dev/null); l_tick=0
l_log "launcher up (current $s_cur, phase $s_phase)"

while :; do
  if [ -e "$STATE/${DAEMON_BOOT_STOP_NAME}" ]; then l_log "stop file: the launcher ends and leaves the service to its stop"; rm -f "$STATE/${DAEMON_BOOT_PID_NAME}"; exit 0; fi
  l_hold=0
  if [ -f "$L/request" ]; then l_request || l_hold=1; fi
  if [ -n "$c_pid" ] && ! l_alive "$c_pid"; then
    l_reap
    [ "$l_hold" = 1 ] || l_selfcheck
    # An exit while a switch is being prepared is that switch's (the old service's update exit).
    [ "$l_hold" = 1 ] || l_exited "$c_code"
  fi
  w_n=$(l_now)
  if [ -z "$c_pid" ]; then
    [ "$l_hold" = 0 ] && [ "$w_n" -ge "$next_start" ] && l_spawn "$s_cur"
  else
    if [ "$s_phase" = trial ]; then
      if [ "$(l_get "$L/ready" pid)" = "$c_pid" ]; then
        s_phase=probation; s_since=$w_n; s_crash=0; l_write; l_result "$s_req" committed "$s_cur" ""; s_req=; l_write
        l_log "$s_cur is ready: committed, watched for $K_PROB s"
      elif [ $((w_n - s_since)) -gt "$K_TRIAL" ]; then
        l_rollback "the new version was not ready within $K_TRIAL s"; continue
      fi
    elif [ "$s_phase" = probation ] && [ $((w_n - s_since)) -ge "$K_PROB" ]; then
      s_good=$s_cur; s_gbuild=$s_build; s_phase=committed; s_since=$w_n; s_crash=0; l_write
      l_log "$s_cur stayed up for $K_PROB s: it is the good version now"
    fi
    if [ -f "$L/heartbeat" ]; then
      hb_t=; hb_b=; hb_p=; read -r hb_t hb_b hb_p < "$L/heartbeat" 2>/dev/null
      if [ "$hb_p" = "$c_pid" ] && l_num "$hb_t"; then
        l_num "$hb_b" || hb_b=0; [ "$hb_b" -gt $((hb_t + ${BUSY_MAX_SECONDS})) ] && hb_b=$((hb_t + ${BUSY_MAX_SECONDS}))
        if [ $((w_n - hb_t)) -gt "$K_STALL" ] && [ "$w_n" -ge "$hb_b" ]; then
          l_log "no heartbeat from pid $c_pid for $((w_n - hb_t)) s: ending it"
          l_stop 10; l_exited stalled
        fi
      fi
    fi
  fi
  l_tick=$((l_tick + 1))
  if [ $((l_tick % 60)) = 0 ]; then
    l_selfcheck
    [ $((l_tick % 3600)) = 0 ] && l_rotate
  fi
  # fd 9 closed: a sleep that outlives a killed launcher must not hold its lock.
  sleep "$K_TICK" 9>&-
done
`.split('\n').slice(1, -1)
