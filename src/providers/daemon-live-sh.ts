/**
 * "Is this pid the daemon of that dir": the one set of shell helpers every script that reads a
 * daemon dir's daemon.pid uses (a leader's live-dir scan and its stay check, the isolated-root
 * sweep, the update scripts' t_up, the stop command's identity reads). Plain POSIX sh: dash,
 * bash, busybox ash and macOS /bin/sh run them (tests/providers/daemon-live-scan-stamp.test.ts).
 *
 * A pid file whose pid now names another process (a restarted container reuses pids) is no live
 * daemon: taking it for one pointed every connect at the dead daemon's port, again on every try,
 * until that process ended. Two proofs, in order:
 *
 * 1. The stamp. A daemon writes `<dir>/daemon.stamp` = `<pid> <start time>` right after
 *    daemon.pid (daemon-door.ts stampDoor, both twins; on Linux the start time is field 22 and the
 *    boot id, since ticks since boot repeat in a later boot). When it names this pid, it decides:
 *    the process is that daemon only if its start time is still the one stamped, whatever its
 *    command line (a host's one service runs as `walnut serve`). A stamp naming this pid with
 *    another start time is a dead daemon's whose pid came back: not live, even if the command line
 *    looks right. A stamp older than daemon.pid is an earlier writer's: a daemon from before the
 *    stamp never touches the file, and when it got the same pid (a restarted container's boot
 *    order) that stamp would read it as dead (review A3b S34-M1). It counts as no stamp.
 * 2. No stamp for this pid (a daemon from before the stamp, or one whose start time could not be
 *    read): the command line decides, the way the Mac starts one (`<dir>/<binary> --start`,
 *    `<runtime> <dir>/daemon.cjs --start`) or an OS service's (`.../versions/<sha>/daemon --service`).
 *    A Walnut server (`walnut serve`) is never taken for a daemon this way: only its stamp names
 *    it (review 2026-11-21 #4: a stale daemon.pid that names some other dir's server is no daemon).
 */

import { DAEMON_STAMP_NAME } from './daemon-door.js'

/** The daemon files the Mac starts in a daemon dir, as `<dir>/<name> --start` (the binary) or `<runtime> <dir>/daemon.cjs --start`. */
export const DAEMON_BINARY_NAMES: readonly string[] = ['daemon-linux-x64', 'daemon-linux-arm64', 'daemon-darwin-arm64', 'daemon-darwin-x64']

/**
 * The start-time readers, shared with the stop command (daemon-start-cmd.ts), which wraps them in
 * its own error handling. `w_stat_start <stat file>`: field 22 of a Linux /proc stat (clock ticks
 * since boot); "<pid> (<comm>) " comes first and comm may hold ") ", so it strips to the last one.
 * `w_ps_start <pid>`: ps's start time where there is no /proc, under LC_ALL=C TZ=UTC so a login
 * shell and a service read the same words (its stderr is the caller's).
 */
export const START_READER_SH: readonly string[] = [
  `w_stat_start() { sed 's/.*) //' "$1" 2>/dev/null | cut -d' ' -f20; }`,
  'w_ps_start() { LC_ALL=C TZ=UTC ps -p "$1" -o lstart=; }',
]

/** `w_args <pid>`: its command line, one space between words (Linux /proc; ps elsewhere, which a slim Linux image does not have). */
export const W_ARGS_SH = `w_args() { if [ -r /proc/self/cmdline ]; then tr '\\000' ' ' < "/proc/$1/cmdline" 2>/dev/null; else ps -ww -o args= -p "$1" 2>/dev/null; fi; }`

const commandPatterns = [...DAEMON_BINARY_NAMES, 'daemon.cjs'].map((name) => `*" $2/${name} --start"`).join('|')

/**
 * `w_pstart <pid>`: its start time as daemon-door.ts stamps it (Linux: field 22 and the boot id when
 * readable; elsewhere one space between ps's words).
 * `w_stamp <pid> <dir>`: 0 the dir's stamp names this pid and its start time matches, 1 it names
 * this pid with another start time (the pid was reused), 2 no stamp for this pid, a stamp older
 * than daemon.pid (an earlier writer's), or no start time to compare: the command line decides.
 * `-nt` is in dash, bash, busybox ash and macOS sh. DAEMON_STAMP_SH is these two alone (the update
 * script's check); DAEMON_PID_SH adds `w_daemon <pid> <dir>`: the stamp, else the command line.
 */
export const DAEMON_STAMP_SH: readonly string[] = [
  ...START_READER_SH,
  'w_pstart() { if [ -r /proc/self/stat ]; then [ -r "/proc/$1/stat" ] || return 1; wh_p=$(w_stat_start "/proc/$1/stat"); [ -n "$wh_p" ] || return 1; '
    + `wh_b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null); case "$wh_b" in *[!0-9a-f-]*|'') echo "$wh_p";; *) echo "$wh_p $wh_b";; esac; `
    + `else w_ps_start "$1" 2>/dev/null | awk '{ $1 = $1; print }'; fi; }`,
  `w_stamp() { [ -f "$2/${DAEMON_STAMP_NAME}" ] || return 2; [ "$2/daemon.pid" -nt "$2/${DAEMON_STAMP_NAME}" ] && return 2; `
    + `wh_s=$(cat "$2/${DAEMON_STAMP_NAME}" 2>/dev/null); case "$wh_s" in "$1 "?*) ;; *) return 2;; esac; `
    + 'wh_t=$(w_pstart "$1"); [ -n "$wh_t" ] || return 2; [ "$wh_s" = "$1 $wh_t" ]; }',
]

export const DAEMON_PID_SH: readonly string[] = [
  ...DAEMON_STAMP_SH,
  W_ARGS_SH,
  // /proc ends the line with one NUL (now a space); the leading space makes `<dir>/<binary> --start` a suffix match too.
  'w_daemon() { w_stamp "$1" "$2"; case $? in 0) return 0;; 1) return 1;; esac; wh_a=$(w_args "$1"); wh_a=" ${wh_a% }"; case "$wh_a" in '
    + commandPatterns + '|*"/daemon --service") return 0;; esac; return 1; }',
]
