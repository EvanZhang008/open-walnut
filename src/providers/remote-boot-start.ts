/**
 * Does a remote host's daemon come back by itself after the machine reboots,
 * and if not, can Walnut make it so without root? (2026-10-31, the user: "without
 * root, how does the daemon come back after a reboot by itself ... a public
 * feature, not a fix for our own box".)
 *
 * One shell probe answers the first question for any runtime and any daemon
 * version: which service config is on the host, whether systemd would start it
 * at boot (a user unit needs linger), whether the cron boot line is in place and
 * a cron daemon starts at boot. The server reads it at connect and shows it in
 * Settings, so the row is the host's own answer, never a guess from the daemon's
 * start mode.
 *
 * When nothing starts the daemon at boot, the setup runs on the host as
 * `walnut daemon install --yes` (daemon-service-scope.ts picks systemd with
 * linger, else cron), from the daemon binary of this server's build: the
 * running unmanaged daemon hands its sessions over to the service and exits, and
 * the connection's reconnect finds the service daemon. A host remembers its last
 * attempt (`boot-setup` in the install root), so a host that cannot be set up is
 * not retried, and re-uploaded to, on every server restart.
 */
import { CRON_BOOT_PROBE_SCRIPT, NO_CRONTAB_PATTERN, parseCronBootProbe, shq } from './daemon-service-boot-script.js'

export type BootStartMode = 'boot' | 'login' | 'none'
export type BootStartBackend = 'systemd-user' | 'systemd-system' | 'cron' | 'launchd'

export interface BootStartFacts {
  platform: string
  user: string
  linger: 'yes' | 'no' | 'unknown'
  userManager: boolean
  userUnit: boolean
  userUnitEnabled: string
  systemUnit: boolean
  systemUnitEnabled: string
  bootScript: boolean
  cronLine: boolean
  crontab: 'ok' | 'none' | 'denied' | 'missing'
  cron: ReturnType<typeof parseCronBootProbe>
  plist: boolean
  /** The host's record of Walnut's last setup attempt; `removed`: someone ran `walnut daemon uninstall` there since. */
  attempt: { version: string; at: number; ok: boolean; removed?: boolean } | null
}

export interface BootStart {
  mode: BootStartMode
  /** What starts it: set for boot and login. */
  backend: BootStartBackend | null
  /** One plain clause on why it does not start at boot (mode login or none). */
  reason: string | null
  /** A service config of Walnut's is on the host (any backend). */
  installed: boolean
}

const ROOT = '"$HOME"/.local/share/open-walnut/daemon'
export const BOOT_SETUP_MARKER = 'boot-setup'
const SENTINEL = 'walnut-boot-probe-done'

/** One `sh -s` round trip; prints key=value lines and a sentinel. Reads only. */
export function buildBootStartProbeScript(): string {
  return [
    'U=$(id -un 2>/dev/null)',
    'echo "platform=$(uname -s 2>/dev/null)"',
    'echo "user=$U"',
    // No --value: systemd before 230 rejects it; Linger=yes is what every version prints.
    'L=$(loginctl show-user "$U" -p Linger 2>/dev/null) && L=${L#Linger=} || L=unknown',
    'echo "linger=${L:-unknown}"',
    'if systemctl --user show-environment >/dev/null 2>&1; then echo user_manager=1; else echo user_manager=0; fi',
    `if [ -e "$HOME"/.config/systemd/user/open-walnut-daemon.service ]; then echo user_unit=1; echo "user_unit_enabled=$(systemctl --user is-enabled open-walnut-daemon.service 2>/dev/null)"; else echo user_unit=0; fi`,
    'if [ -e /etc/systemd/system/open-walnut-daemon.service ]; then echo system_unit=1; echo "system_unit_enabled=$(systemctl is-enabled open-walnut-daemon.service 2>/dev/null)"; else echo system_unit=0; fi',
    `if [ -e ${ROOT}/daemon-boot.sh ]; then echo boot_script=1; else echo boot_script=0; fi`,
    'if ! command -v crontab >/dev/null 2>&1; then echo crontab=missing',
    'else',
    '  T=$(crontab -l 2>&1); R=$?',
    `  if [ $R -eq 0 ]; then echo crontab=ok; elif printf "%s" "$T" | grep -qiE ${shq(NO_CRONTAB_PATTERN)}; then echo crontab=none; else echo crontab=denied; fi`,
    // ${HOME%/}: the crontab line names the normalized path, and a passwd home may end in a slash.
    `  if [ $R -eq 0 ] && printf '%s\\n' "$T" | grep -F -- "\${HOME%/}/.local/share/open-walnut/daemon/daemon-boot.sh" | grep -q '^@reboot'; then echo cron_line=1; else echo cron_line=0; fi`,
    'fi',
    `C=$(sh -c ${shq(CRON_BOOT_PROBE_SCRIPT)} 2>/dev/null)`,
    'echo "cron=$C"',
    'if [ -e "$HOME"/Library/LaunchAgents/dev.openwalnut.session-daemon.plist ]; then echo plist=1; else echo plist=0; fi',
    `if [ -r ${ROOT}/${BOOT_SETUP_MARKER} ]; then echo "attempt=$(head -c 200 ${ROOT}/${BOOT_SETUP_MARKER} | tr -d '\\n')"; fi`,
    `echo ${SENTINEL}`,
  ].join('\n')
}

/** Null when the reply was cut short: silence is never "nothing installed". */
export function parseBootStartProbe(output: string): BootStartFacts | null {
  if (!output.split('\n').some((line) => line.trim() === SENTINEL)) return null
  const kv = new Map<string, string>()
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const flag = (key: string) => kv.get(key) === '1'
  const linger = kv.get('linger')
  const tab = kv.get('crontab')
  const attempt = /^v=(\S+) at=(\d+) result=(ok|failed|removed)$/.exec(kv.get('attempt') ?? '')
  return {
    platform: (kv.get('platform') ?? '').toLowerCase(),
    user: kv.get('user') ?? '',
    linger: linger === 'yes' || linger === 'no' ? linger : 'unknown',
    userManager: flag('user_manager'),
    userUnit: flag('user_unit'),
    userUnitEnabled: kv.get('user_unit_enabled') ?? '',
    systemUnit: flag('system_unit'),
    systemUnitEnabled: kv.get('system_unit_enabled') ?? '',
    bootScript: flag('boot_script'),
    cronLine: flag('cron_line'),
    crontab: tab === 'ok' || tab === 'none' || tab === 'denied' || tab === 'missing' ? tab : 'missing',
    cron: parseCronBootProbe(kv.get('cron') ?? ''),
    plist: flag('plist'),
    attempt: attempt ? { version: attempt[1], at: Number(attempt[2]), ok: attempt[3] === 'ok', ...(attempt[3] === 'removed' ? { removed: true } : {}) } : null,
  }
}

export function classifyBootStart(f: BootStartFacts): BootStart {
  const installed = f.userUnit || f.systemUnit || f.bootScript || f.plist
  if (f.platform === 'darwin') {
    return f.plist
      ? { mode: 'login', backend: 'launchd', reason: 'a login agent starts it when you log in on that Mac', installed }
      : { mode: 'none', backend: null, reason: 'no login agent is installed', installed }
  }
  if (f.systemUnit && f.systemUnitEnabled === 'enabled') return { mode: 'boot', backend: 'systemd-system', reason: null, installed }
  if (f.userUnit) {
    if (f.userUnitEnabled !== 'enabled') return { mode: 'none', backend: null, reason: 'its systemd user service is not enabled', installed }
    if (f.linger === 'yes') return { mode: 'boot', backend: 'systemd-user', reason: null, installed }
    return { mode: 'login', backend: 'systemd-user', reason: 'its systemd user service starts only when you log in there, because linger is off', installed }
  }
  if (f.bootScript) {
    if (!f.cronLine) return { mode: 'none', backend: null, reason: 'the @reboot line is missing from its crontab', installed }
    if (!f.cron.ok) return { mode: 'none', backend: null, reason: `the @reboot line is in place, but ${f.cron.reason}`, installed }
    return { mode: 'boot', backend: 'cron', reason: null, installed }
  }
  return { mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', installed }
}

/**
 * Can this account have a boot start without root, as far as the probe can
 * tell? Null when it can (or may: linger is tried during the install), else why
 * not, in words. Spares a 30+ MB upload to a host that would refuse anyway.
 */
export function bootSetupBlocker(f: BootStartFacts): string | null {
  if (f.platform !== 'linux') {
    return f.platform === 'darwin'
      ? 'Walnut sets this up by itself on Linux hosts only; a Mac host\'s daemon starts again when Walnut next connects to it'
      : `Walnut cannot set up a boot start on ${f.platform || 'this system'}`
  }
  if (f.cron.ok && (f.crontab === 'ok' || f.crontab === 'none')) return null
  if (f.userManager) return null
  const cron = f.crontab === 'missing' ? 'crontab is not installed' : f.crontab === 'denied' ? 'this account may not use crontab' : f.cron.ok ? 'cron is unusable' : f.cron.reason
  return `this account cannot start the daemon at boot without root: no systemd user manager answers for it, and ${cron}. `
    + `An administrator can run "loginctl enable-linger ${f.user || '<user>'}" once (or enable a cron daemon), then Walnut finishes the setup by itself`
}

/** Hours a failed attempt keeps a host from being tried again: the same build a day, any build six hours. */
export const BOOT_SETUP_RETRY_SAME_BUILD_MS = 24 * 3_600_000
export const BOOT_SETUP_RETRY_ANY_BUILD_MS = 6 * 3_600_000

export function bootSetupDue(f: BootStartFacts, expected: string, now: number): boolean {
  const a = f.attempt
  // An uninstall on the host is the user's choice: never undone from here.
  if (a?.removed) return false
  if (!a || a.ok) return true
  const ago = now - a.at
  if (ago < 0) return true
  if (a.version === expected && ago < BOOT_SETUP_RETRY_SAME_BUILD_MS) return false
  return ago >= BOOT_SETUP_RETRY_ANY_BUILD_MS
}

/** Shell that records an attempt on the host (private, in the install root). */
export function bootSetupMarkerCommand(version: string, at: number, ok: boolean): string {
  if (!/^walnut-daemon-[a-zA-Z0-9]+$/.test(version)) throw new Error('Invalid daemon build version')
  return `umask 077; mkdir -p ${ROOT} && printf '%s\\n' ${shq(`v=${version} at=${Math.floor(at)} result=${ok ? 'ok' : 'failed'}`)} > ${ROOT}/${BOOT_SETUP_MARKER}`
}

/** The Settings words for a host's boot start (null mode: not checked yet). */
export function bootStartWords(b: Pick<BootStart, 'mode' | 'reason'> & { backend: string | null }, setup?: { running?: boolean; error?: string | null } | null): string {
  if (setup?.running) return 'Walnut is setting it up to start after a reboot'
  if (b.mode === 'boot') {
    const via = b.backend === 'cron' ? 'from its crontab' : b.backend === 'systemd-user' ? 'as a systemd user service' : b.backend === 'systemd-system' ? 'as a systemd service' : null
    return via ? `starts by itself after a reboot (${via})` : 'starts by itself after a reboot'
  }
  if (b.mode === 'login') return `starts after a reboot only once you log in there (${b.reason ?? 'login only'})`
  const why = setup?.error ?? b.reason
  return why ? `does not start by itself after a reboot: ${why}` : 'does not start by itself after a reboot'
}
