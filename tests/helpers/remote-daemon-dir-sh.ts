/**
 * A POSIX sh line that sets `$d` to the session daemon's dir on the remote host a live test
 * drives. The connect picks it per host (src/providers/remote-daemon-dir.ts): `$HOME/.cache/open-walnut`
 * on a host nothing ran on, the shared temp dir where a daemon already ran since the boot. So a
 * live test reads the daemon's files through this line, or from the connection's own
 * `remoteDaemonDir`, never by a fixed path (tests/scripts/daemon-files-no-fixed-path.test.ts).
 *
 * The dir whose daemon runs, else the one that holds a registry, else the home dir.
 */
const SHARED = '/tmp/open-walnut'
const HOME_DIR = '"$HOME/.cache/open-walnut"'

export const REMOTE_DAEMON_DIR_SH = [
  'd=',
  `for c in ${SHARED} ${HOME_DIR}; do p=$(cat "$c/daemon.pid" 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then d=$c; break; fi; done`,
  `if [ -z "$d" ]; then for c in ${HOME_DIR} ${SHARED}; do if [ -e "$c/sessions.json" ]; then d=$c; break; fi; done; fi`,
  `[ -n "$d" ] || d=${HOME_DIR}`,
].join('; ')
