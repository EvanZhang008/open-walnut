/**
 * The cron boot backend's files, as text (no I/O): the supervisor script the
 * `@reboot` line runs, that line, and the edits to a crontab that add or remove
 * it. Used where systemd cannot start a user's daemon at boot (no user manager,
 * or linger off and not allowed to turn it on) and no root is at hand: every
 * common cron (cronie, Vixie/Debian cron, busybox crond) runs a user's `@reboot`
 * lines at boot.
 *
 * The script is the supervisor: it restarts the daemon on every exit (1 s after
 * a clean one, 5 s after a failure, gives up after 5 failures in 60 s, like the
 * systemd unit's start limit), and re-reads ITSELF from disk on each restart, so
 * an update is the new script written atomically plus the daemon's own update
 * exit, the same steps the systemd unit takes with daemon-reload. A stop file
 * beside it ends the loop (uninstall). The lock fd is never handed to the
 * daemon: a CLI it spawns would inherit it and hold the lock past the daemon.
 */
import path from 'node:path'
import { checkDaemonServiceConfig, DAEMON_BOOT_SCRIPT_NAME, type DaemonServiceConfig } from './daemon-service-config.js'

export { DAEMON_BOOT_SCRIPT_NAME } from './daemon-service-config.js'
export const DAEMON_BOOT_STOP_NAME = 'daemon-boot.stop'
export const DAEMON_BOOT_PID_NAME = 'daemon-boot.pid'
export const DAEMON_BOOT_LOCK_NAME = 'daemon-boot.lock'
/** Ends the crontab line Walnut writes, so it can find its own line and nobody else's. */
export const DAEMON_CRON_TAG = '# open-walnut-daemon'
/** First comment line of the script: a file without it was not written by Walnut. */
export const DAEMON_BOOT_SCRIPT_HEADER = '# Open Walnut session daemon, started at boot by the @reboot line in this account\'s crontab.'
/** Failures in this many seconds stop the loop; a cleanly exiting daemon is restarted at once. */
export const BOOT_FAIL_WINDOW_S = 60
export const BOOT_FAIL_LIMIT = 5

/** sh single quotes: everything literal, a quote closed, escaped and reopened. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function unshq(word: string): string | null {
  const parts = word.match(/^(?:'[^']*'|\\')+$/)
  if (!parts) return null
  return word.replace(/'([^']*)'|\\'/g, (_m, inner: string | undefined) => inner ?? "'")
}

export function renderDaemonBootScript(config: DaemonServiceConfig): string {
  const c = checkDaemonServiceConfig(config)
  const self = path.join(c.stateDir, DAEMON_BOOT_SCRIPT_NAME)
  const file = (name: string) => `"$STATE"/${name}`
  return [
    '#!/bin/sh',
    DAEMON_BOOT_SCRIPT_HEADER,
    '# It keeps the daemon running. Written by `walnut daemon install`; `walnut daemon uninstall --yes`',
    '# removes it and the crontab line. Do not edit: an update rewrites it.',
    `EXEC=${shq(c.executable)}`,
    `ARGS=${shq(c.args.join(' '))}`,
    `SELF=${shq(self)}`,
    `STATE=${shq(c.stateDir)}`,
    `export HOME=${shq(c.home)}`,
    `export PATH=${shq(c.path)}`,
    `export WALNUT_DAEMON_DIR=${shq(c.runtimeDir)}`,
    `export WALNUT_DAEMON_STATE_DIR=${shq(c.stateDir)}`,
    'export WALNUT_DAEMON_SUPERVISOR=cron',
    'umask 077',
    'cd "$HOME" || exit 1',
    `[ -e ${file(DAEMON_BOOT_STOP_NAME)} ] && exit 0`,
    'if command -v flock >/dev/null 2>&1; then',
    `  exec 9>>${file(DAEMON_BOOT_LOCK_NAME)}`,
    '  flock -n 9 || exit 0',
    'fi',
    `echo $$ > ${file(DAEMON_BOOT_PID_NAME)}`,
    // ARGS is one word ('--service'); left unquoted on purpose so a future second word splits.
    `"$EXEC" $ARGS 9>&- </dev/null >>${file('daemon-service.out.log')} 2>>${file('daemon-service.err.log')}`,
    'code=$?',
    `[ -e ${file(DAEMON_BOOT_STOP_NAME)} ] && { rm -f ${file(DAEMON_BOOT_PID_NAME)}; exit 0; }`,
    'now=$(date +%s)',
    'first=${WALNUT_BOOT_FIRST:-$now}',
    'fails=${WALNUT_BOOT_FAILS:-0}',
    `if [ $((now - first)) -gt ${BOOT_FAIL_WINDOW_S} ]; then first=$now; fails=0; fi`,
    'if [ "$code" -ne 0 ]; then fails=$((fails + 1)); fi',
    `if [ "$fails" -ge ${BOOT_FAIL_LIMIT} ]; then`,
    `  echo "daemon-boot: the daemon failed ${BOOT_FAIL_LIMIT} times in ${BOOT_FAIL_WINDOW_S}s (last exit $code); not restarting it" >>${file('daemon-service.err.log')}`,
    `  rm -f ${file(DAEMON_BOOT_PID_NAME)}`,
    '  exit "$code"',
    'fi',
    'export WALNUT_BOOT_FIRST=$first WALNUT_BOOT_FAILS=$fails',
    'if [ "$code" -eq 0 ]; then sleep 1; else sleep 5; fi',
    'exec /bin/sh "$SELF"',
    '',
  ].join('\n')
}

function assignment(text: string, name: string): string | null {
  const lines = text.split('\n').filter((line) => line.startsWith(`${name}=`) || line.startsWith(`export ${name}=`))
  if (lines.length !== 1) return null
  return unshq(lines[0].slice(lines[0].indexOf('=') + 1))
}

export function isDaemonBootScript(text: string): boolean {
  return text.split('\n')[1] === DAEMON_BOOT_SCRIPT_HEADER
}

export function readDaemonBootExecutable(text: string): string {
  const exe = isDaemonBootScript(text) ? assignment(text, 'EXEC') : null
  if (!exe || !exe.startsWith('/')) throw new Error('Boot script executable is not recognized; use an explicit installation')
  return exe
}

export function replaceDaemonBootExecutable(text: string, executable: string): string {
  readDaemonBootExecutable(text)
  if (!executable.startsWith('/') || /[\u0000-\u001f\u007f]/.test(executable)) throw new Error('executable must be an absolute path')
  return text.split('\n').map((line) => (line.startsWith('EXEC=') ? `EXEC=${shq(executable)}` : line)).join('\n')
}

/**
 * The crontab line. cron hands everything after the schedule to /bin/sh, except
 * that an unescaped `%` is a newline to it, so a path holding one is refused.
 */
export function daemonCronLine(script: string): string {
  if (/[%\n\r]/.test(script)) throw new Error('the boot script path must not contain % or a newline (cron reads them specially)')
  return `@reboot /bin/sh ${shq(script)} >/dev/null 2>&1 ${DAEMON_CRON_TAG}`
}

export type CronLineState = 'ours' | 'stale' | 'foreign' | 'none'

/**
 * How a crontab stands for our script: `ours` (exactly our line, once), `stale`
 * (our tag or our script, but not the line this build writes: an older Walnut's,
 * or a copy), `foreign` (our tag on a line for another script: someone else's
 * install root), `none`.
 */
export function cronLineState(crontab: string, script: string): CronLineState {
  const want = daemonCronLine(script)
  const lines = crontab.split('\n')
  const exact = lines.filter((line) => line === want).length
  const related = lines.filter((line) => line !== want && (line.endsWith(DAEMON_CRON_TAG) || line.includes(script)))
  if (exact === 1 && related.length === 0) return 'ours'
  if (related.some((line) => !line.includes(script) && !line.trimStart().startsWith('#'))) return 'foreign'
  return exact || related.length ? 'stale' : 'none'
}

function ourLine(line: string, script: string): boolean {
  return line === daemonCronLine(script) || (line.includes(script) && (line.endsWith(DAEMON_CRON_TAG) || /^\s*@reboot\s/.test(line)))
}

/** The crontab with our line in place exactly once; every other line kept byte for byte. */
export function crontabWithDaemonLine(crontab: string, script: string): string {
  const kept = crontabWithoutDaemonLine(crontab, script)
  return `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${daemonCronLine(script)}\n`
}

/** The crontab without our line (or an older form of it); every other line kept. */
export function crontabWithoutDaemonLine(crontab: string, script: string): string {
  if (!crontab) return ''
  const lines = crontab.split('\n')
  const trailing = lines[lines.length - 1] === ''
  const kept = (trailing ? lines.slice(0, -1) : lines).filter((line) => !ourLine(line, script))
  return kept.length ? `${kept.join('\n')}\n` : ''
}

/** Every way `crontab -l` says the account has no crontab yet (cronie/Vixie, BusyBox), kept in step with the probe's grep. */
export const NO_CRONTAB_PATTERN = "no crontab for|can't open '[^']*': no such file"

/** `crontab -l` exits 1 with one of these when the account has no crontab yet: an empty one, not a failure. */
export function isNoCrontab(stderr: string): boolean {
  return new RegExp(NO_CRONTAB_PATTERN, 'i').test(stderr)
}

/**
 * Does a cron daemon start at boot here? On systemd, the unit's own enablement
 * says so (readable without root; `static` and `indirect` units start only when
 * something pulls them in, so they fall through to the next check); elsewhere
 * (OpenRC, busybox) a running crond is the best evidence there is. Prints one of:
 * enabled <unit> | running <name> | missing.
 */
export const CRON_BOOT_PROBE_SCRIPT = [
  'if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then',
  '  for u in cron.service crond.service cronie.service; do',
  '    s=$(systemctl is-enabled "$u" 2>/dev/null)',
  '    case "$s" in enabled|enabled-runtime|alias|generated) echo "enabled $u"; exit 0;; esac',
  '  done',
  'fi',
  'for n in cron crond cronie busybox; do',
  '  if command -v pgrep >/dev/null 2>&1; then',
  '    if [ "$n" = busybox ]; then pgrep -f "busybox crond" >/dev/null 2>&1 && { echo "running busybox-crond"; exit 0; }',
  '    else pgrep -x "$n" >/dev/null 2>&1 && { echo "running $n"; exit 0; }; fi',
  '  fi',
  'done',
  'echo missing',
].join('\n')

export type CronBoot = { ok: true; via: string } | { ok: false; reason: string }

export function parseCronBootProbe(stdout: string): CronBoot {
  const line = stdout.trim().split('\n').pop()?.trim() ?? ''
  const m = /^(enabled|running) (\S+)$/.exec(line)
  if (m) return { ok: true, via: m[1] === 'enabled' ? `${m[2]} is enabled at boot` : `${m[2]} is running` }
  return { ok: false, reason: line === 'missing' ? 'no cron daemon is enabled at boot or running here' : 'could not tell whether a cron daemon starts at boot' }
}
