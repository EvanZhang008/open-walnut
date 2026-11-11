/**
 * The sh pieces every daemon update script shares (daemon-update-tail.ts, its stand-in
 * daemon-update-standin.ts, the runner in daemon-net-update-io.ts): where the service lives,
 * whether it runs, whether a later update owns the host, and the service install lock.
 *
 * The lock is the one `walnut daemon` takes (src/utils/file-lock.ts, `<ownership record>.lock`),
 * in the form an older build writes it: the dir, then a `pid` file. Node's lockers honour that
 * while the pid lives and take it over once it is dead, so the snapshot and the tail never
 * interleave with a `walnut daemon` transaction or a revive (2026-11-04 review: a second
 * runner took its snapshot unlocked, after the first had written the new config, and its
 * put-back undid the first one's finished rollback). A holder still there after the wait (a
 * transaction that hangs) is not waited on for good: the tail must still run, unlocked.
 */
import path from 'node:path'
import {
  DAEMON_BOOT_SCRIPT_NAME,
  DAEMON_SERVICE_LABEL,
  DAEMON_SERVICE_UNIT_NAME,
  daemonInstallRoot,
} from './daemon-service-config.js'
import { DAEMON_BOOT_PID_NAME } from './daemon-service-boot-script.js'
import { DAEMON_OWNERSHIP_NAME } from './daemon-service-files.js'

/** How long the snapshot and the tail wait for a `walnut daemon` transaction to let go of the lock. */
export const LOCK_WAIT_SECONDS = 120

/** A path under the account's home, as the shell writes it ("$HOME/..."). */
function underHome(absolute: (home: string) => string): string {
  const rel = path.relative('/H', absolute('/H'))
  if (/["$`\\]/.test(rel)) throw new Error(`unexpected character in ${rel}`)
  return `"$HOME/${rel}"`
}

/** Sets tb (the install root) only, the same for every scope: for a script that changes nothing of the service (the launcher). */
export function installRootLine(): string {
  return `case "$(uname -s)" in Darwin) tb=${underHome((h) => daemonInstallRoot('darwin', h))};; *) tb=${underHome((h) => daemonInstallRoot('linux', h))};; esac`
}

/** Sets tk (launchd|systemd|cron), tc (the config), tb (the install root), to (the ownership record), tu (uid). */
export function servicePreamble(scope: 'user' | 'cron'): string[] {
  const macRoot = underHome((h) => daemonInstallRoot('darwin', h))
  const linuxRoot = underHome((h) => daemonInstallRoot('linux', h))
  return [
    'tu=$(id -u)',
    // The SSH path has no latest marker; the runner sets its own before this.
    ': "${L:=}"',
    'case "$(uname -s)" in',
    `  Darwin) tk=launchd; tb=${macRoot}; tc="$HOME/Library/LaunchAgents/${DAEMON_SERVICE_LABEL}.plist";;`,
    scope === 'cron'
      ? `  *) tk=cron; tb=${linuxRoot}; tc="$tb/${DAEMON_BOOT_SCRIPT_NAME}";;`
      : `  *) tk=systemd; tb=${linuxRoot}; tc="$HOME/.config/systemd/user/${DAEMON_SERVICE_UNIT_NAME}"; export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$tu}";;`,
    'esac',
    `to="$tb/${DAEMON_OWNERSHIP_NAME}"`,
  ]
}

/**
 * How long a runner's update.pid may go untouched while it counts as at work. A runner of this
 * build touches it every RUNNER_BEAT_SECONDS (its heartbeat), so for one of them this is how long
 * it may go without a beat; one of an older build only wrote it at its start.
 */
export const RUNNER_MAX_MINUTES = 60
/** How often a runner touches its update.pid (daemon-net-update-io.ts runnerScript). */
export const RUNNER_BEAT_SECONDS = 15
/**
 * How long t_later waits for a beat before it counts a stale runner as gone: a Mac that slept
 * past RUNNER_MAX_MINUTES wakes with every runner frozen until its next tick (2026-11-04 review 5:
 * the first check after such a wake stood the update's runner down).
 */
export const RUNNER_WAKE_GRACE_SECONDS = RUNNER_BEAT_SECONDS + 5

/**
 * t_later: the latest marker ($L, a file of this user's) names another update's dir whose
 * runner is still at work: no update.done, its update.pid alive AS that runner (its command
 * line names the dir's update.sh, where it can be read), and that pid file younger than
 * RUNNER_MAX_MINUTES. 2026-11-04 review: any other dir counted, so a runner that never ran or
 * had died stood the only working tail down; a live pid alone is not enough, since a dead
 * runner's pid is reused by whatever starts next, and every update, revive and stand-in would
 * then wait on it for good; and the age held only where ps could not say (the next review: a
 * runner that hangs, its command line still readable, blocked them all for as long as it lived).
 */
export function laterLines(): string[] {
  const fresh = `[ -n "$(find "$tl_d/update.pid" -mmin -${RUNNER_MAX_MINUTES} 2>/dev/null)" ]`
  return [
    't_later() { [ -n "${L:-}" ] && [ -f "$L" ] && [ -O "$L" ] || return 1',
    '  tl_d=$(cat "$L" 2>/dev/null); [ "$tl_d" != "${d:-}" ] || return 1',
    '  case "$tl_d" in /tmp/open-walnut-update.*) ;; *) return 1;; esac',
    '  [ -e "$tl_d/update.done" ] && return 1',
    '  tl_p=$(cat "$tl_d/update.pid" 2>/dev/null); case "$tl_p" in ""|*[!0-9]*) return 1;; esac',
    '  [ "$tl_p" -gt 1 ] && kill -0 "$tl_p" 2>/dev/null || return 1',
    // Its command line: /proc where there is one (a slim image has no ps), else ps.
    `  if [ -r "/proc/$tl_p/cmdline" ]; then tl_a=$(tr '\\000' ' ' < "/proc/$tl_p/cmdline" 2>/dev/null); else tl_a=$(ps -ww -o args= -p "$tl_p" 2>/dev/null); fi`,
    '  if [ -n "$tl_a" ]; then case "$tl_a" in *"$tl_d/update.sh"*) ;; *) return 1;; esac; fi',
    `  ${fresh} && return 0`,
    // Untouched too long: a runner known by its command line gets one beat's wait (a wake from a
    // long sleep), once per dir in this shell; a pid not known so (no ps) is gone at once.
    '  [ -n "$tl_a" ] && [ "${tl_stale:-}" != "$tl_d" ] || return 1',
    `  tl_w=0; while [ "$tl_w" -lt ${RUNNER_WAKE_GRACE_SECONDS} ]; do sleep 1; tl_w=$((tl_w + 1)); kill -0 "$tl_p" 2>/dev/null || return 1; ${fresh} && return 0; done`,
    '  tl_stale=$tl_d; return 1; }',
  ]
}

/**
 * How much older than this boot a pid file must be to count as left by the boot before it (the
 * margin covers a clock set forward soon after the boot).
 */
export const PREBOOT_MARGIN_SECONDS = 600

/**
 * t_mtime FILE: its mtime (epoch s; GNU and busybox stat -c, BSD stat -f). t_boot: when this boot
 * began (Linux /proc/stat btime, macOS kern.boottime; sysctl is in /usr/sbin, which a PATH of
 * /usr/bin:/bin lacks: 2026-11-11, such a Mac never took over a lock left before its boot). t_preboot
 * FILE: written before this boot, by a process a reboot or a power loss ended, whatever process has
 * its pid now.
 */
export function bootLines(): string[] {
  return [
    't_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }',
    't_boot() { if [ -r /proc/stat ]; then sed -n "s/^btime //p" /proc/stat; else { sysctl -n kern.boottime 2>/dev/null || /usr/sbin/sysctl -n kern.boottime 2>/dev/null; } | sed -n "s/^{ sec = \\([0-9]*\\),.*/\\1/p"; fi; }',
    `t_preboot() { tz_f=$(t_mtime "$1"); tz_o=$(t_boot); case "$tz_f$tz_o" in ""|*[!0-9]*) return 1;; esac; [ -n "$tz_f" ] && [ -n "$tz_o" ] && [ "$tz_f" -lt $((tz_o - ${PREBOOT_MARGIN_SECONDS})) ]; }`,
  ]
}

/**
 * t_lock / t_unlock: the service install lock (see above); nothing when there is no install root.
 * t_held: someone else holds it now (every holder, Node's too, writes its pid to `pid`). A pid
 * file from before this boot holds nothing: 2026-11-04 review 5, a power loss left the tail's
 * lock, and the process that got its pid after the boot held every `walnut daemon` off.
 */
export function lockLines(waitSeconds = LOCK_WAIT_SECONDS): string[] {
  return [
    ...bootLines(),
    't_held() { [ -d "$to.lock" ] || return 1; tk_h=$(cat "$to.lock/pid" 2>/dev/null); case "$tk_h" in ""|*[!0-9]*) return 1;; esac; [ "$tk_h" != "$$" ] && kill -0 "$tk_h" 2>/dev/null && ! t_preboot "$to.lock/pid"; }',
    // The takeover claim: made by one shell only (mkdir); one a killed shell left is taken a minute on.
    't_claim() { [ -n "$(find "$to.lock-claim" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$to.lock-claim" 2>/dev/null; mkdir "$to.lock-claim" 2>/dev/null; }',
    't_lock() { tk_l=; [ -d "$tb" ] || return 0; tk_i=0',
    '  while ! mkdir "$to.lock" 2>/dev/null; do',
    // A holder of the older form (a pid file, no owner) that died is taken over in place, as Node's
    // lockers do. The new pid file is written beside the lock and renamed in: inside it, a file of
    // any other name reads to Node as a lock path taken by something else. The takeover itself is
    // one shell's at a time (t_claim, a dir beside the lock), and only of the pid it read, still
    // there under the claim. 2026-11-04 review: two shells that both read the dead pid and wrote
    // their own more than 0.2 s apart both held the lock.
    '    if [ ! -e "$to.lock/owner" ]; then tk_p=$(cat "$to.lock/pid" 2>/dev/null)',
    '      case "$tk_p" in ""|*[!0-9]*) ;; *) if { ! kill -0 "$tk_p" 2>/dev/null || t_preboot "$to.lock/pid"; } && t_claim; then',
    '        if [ "$(cat "$to.lock/pid" 2>/dev/null)" = "$tk_p" ]; then',
    '          echo $$ > "$to.lock-pid.$$" && { mv -f "$to.lock-pid.$$" "$to.lock/pid" 2>/dev/null || rm -f "$to.lock-pid.$$"; }; sleep 0.2',
    '          [ ! -e "$to.lock/owner" ] && [ "$(cat "$to.lock/pid" 2>/dev/null)" = "$$" ] && { rmdir "$to.lock-claim" 2>/dev/null; tk_l="$to.lock"; return 0; }',
    '        fi; rmdir "$to.lock-claim" 2>/dev/null',
    '      fi;; esac',
    '    fi',
    `    [ "$tk_i" -ge ${waitSeconds} ] && return 0`,
    '    sleep 1; tk_i=$((tk_i + 1))',
    '  done',
    '  tk_l="$to.lock"; echo $$ > "$to.lock-pid.$$" && mv -f "$to.lock-pid.$$" "$tk_l/pid"; }',
    't_unlock() { [ -n "${tk_l:-}" ] && [ "$(cat "$tk_l/pid" 2>/dev/null)" = "$$" ] && { rm -f "$tk_l/pid"; rmdir "$tk_l" 2>/dev/null; }; tk_l=; }',
  ]
}

/** What the record says when the user turned the launchd job off (t_disabled). */
export const LAUNCHD_DISABLED_WORDS = 'the service is turned off in launchd (launchctl disable), so Walnut left it alone and started no daemon outside it'

/**
 * t_disabled: the user turned the launchd job off (`launchctl disable`, read with print-disabled).
 * Nothing starts it then, inside launchd or out: 2026-11-04 review, a revive and the update's
 * stand-in ran the daemon outside launchd past that choice. An answer that cannot be read is no
 * disable.
 */
export function disabledLines(): string[] {
  const label = DAEMON_SERVICE_LABEL.replace(/\./g, '\\.')
  return [`t_disabled() { [ "$tk" = launchd ] || return 1; launchctl print-disabled "gui/$tu" 2>/dev/null | grep -Eq '"${label}"[[:space:]]*=>[[:space:]]*(true|disabled)'; }`]
}

/** t_loaded: the job is loaded (launchd), the unit active (systemd), the supervisor alive (cron). */
export function loadedLines(): string[] {
  const job = `"gui/$tu/${DAEMON_SERVICE_LABEL}"`
  return [
    't_loaded() { case $tk in',
    `  launchd) launchctl print ${job} >/dev/null 2>&1;;`,
    // A unit waiting out a crash (activating, SubState auto-restart) is not running: systemd gives it up at its start limit.
    // No --value: systemd before 230 rejects it (2026-11-04 review: the crash loop read as running); all print SubState=<word>.
    `  systemd) case "$(systemctl --user is-active ${DAEMON_SERVICE_UNIT_NAME} 2>/dev/null)" in active|reloading) return 0;;`,
    `    activating) case "$(systemctl --user show -p SubState ${DAEMON_SERVICE_UNIT_NAME} 2>/dev/null)" in *=auto-restart|auto-restart) return 1;; esac;; *) return 1;; esac;;`,
    `  cron) p=$(cat "$tb/${DAEMON_BOOT_PID_NAME}" 2>/dev/null); case "$p" in ""|*[!0-9]*) return 1;; esac; [ "$p" -gt 1 ] && kill -0 "$p" 2>/dev/null;;`,
    'esac; }',
  ]
}

/**
 * t_up: a daemon serves the runtime dir $tr (its pid alive, its port file there). kill -0 only
 * asks (busybox ps has no -p); a zombie answers it too, so /proc's state is read where there is
 * one (a daemon that exited under a parent that has not reaped it yet is not up). And the process
 * with that pid started before the pid file was written (ps etime; where ps cannot say, trusted):
 * 2026-11-04 review 5, a daemon that died left its pid file, and whatever got that pid next read
 * as the daemon serving.
 */
export const UP_LINE = [
  // The process's start (epoch s) from ps etime ([[dd-]hh:]mm:ss); nothing where ps has no -p.
  `t_pstart() { tz_e=$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' '); case "$tz_e" in ""|*[!0-9:-]*) return 1;; esac; echo "$tz_e" | awk -F'[-:]' -v now="$(date +%s)" '{ s = $NF + 60 * $(NF - 1); if (NF > 2) s += 3600 * $(NF - 2); if (NF > 3) s += 86400 * $(NF - 3); print now - s }'; }`,
  't_up() { p=$(cat "$tr/daemon.pid" 2>/dev/null); case "$p" in ""|*[!0-9]*) return 1;; esac; [ "$p" -gt 1 ] && kill -0 "$p" 2>/dev/null && [ -s "$tr/daemon.port" ] || return 1',
  '  if [ -r "/proc/$p/stat" ]; then tz_s=$(cat "/proc/$p/stat" 2>/dev/null) || return 1; tz_s=${tz_s##*) }; case "$tz_s" in Z*|X*) return 1;; esac; fi',
  '  tz_m=$(stat -c %Y "$tr/daemon.pid" 2>/dev/null || stat -f %m "$tr/daemon.pid" 2>/dev/null); tz_b=$(t_pstart "$p")',
  '  case "$tz_m" in ""|*[!0-9]*) return 0;; esac; case "$tz_b" in ""|*[!0-9]*) return 0;; esac',
  // Linux counts etime on the boot clock, so a wall clock set forward moves "now - etime" as far:
  // what the wall gained over /proc/uptime since this shell's first look is taken off. 2026-11-04
  // review 6: a clock step inside a probation read a healthy daemon as gone, twice, and put it back.
  '  tz_j=0; tz_u=$(sed -n "s/[. ].*//p" /proc/uptime 2>/dev/null); tz_w=$(date +%s)',
  '  case "$tz_u:$tz_w" in :*|*:|*[!0-9:]*) ;; *) : "${tz_u0:=$tz_u}" "${tz_w0:=$tz_w}"; tz_j=$(( (tz_w - tz_w0) - (tz_u - tz_u0) )); [ "$tz_j" -gt 0 ] || tz_j=0;; esac',
  '  [ "$tz_b" -le $((tz_m + 5 + tz_j)) ]; }',
].join('\n')

/**
 * Start the script file in $1 (its arguments after it) out of this shell's session: setsid
 * (Linux), else perl's (every Mac has perl), else bash job control, else sh's. A group kill of
 * whoever ran this (a server stopped with its process group, an SSH session) does not reach it.
 */
export const DETACH_LINE = 't_detach() { td_p=; if command -v setsid >/dev/null 2>&1; then setsid /bin/sh "$@" </dev/null >/dev/null 2>&1 & td_p=$!;'
  + " elif command -v perl >/dev/null 2>&1; then perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh \"$@\" </dev/null >/dev/null 2>&1 & td_p=$!;"
  + " elif command -v bash >/dev/null 2>&1; then bash -c 'set -m; /bin/sh \"$@\" </dev/null >/dev/null 2>&1 &' sh \"$@\" 2>/dev/null;"
  + ' else (set -m; /bin/sh "$@" </dev/null >/dev/null 2>&1 &) 2>/dev/null; fi; }'
