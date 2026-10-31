import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BOOT_SETUP_RETRY_ANY_BUILD_MS,
  BOOT_SETUP_RETRY_SAME_BUILD_MS,
  bootSetupBlocker,
  bootSetupDue,
  bootSetupMarkerCommand,
  bootStartWords,
  buildBootStartProbeScript,
  classifyBootStart,
  parseBootStartProbe,
  type BootStartFacts,
} from '../../src/providers/remote-boot-start.js'
import { daemonCronLine } from '../../src/providers/daemon-service-boot-script.js'

const FAKES: Record<string, string> = {
  id: '[ "$1" = -un ] && echo walnut',
  uname: 'echo "${FAKE_UNAME:-Linux}"',
  loginctl: [
    '[ "$1" = show-user ] || exit 1',
    '[ -n "$FAKE_LINGER" ] || exit 1',
    // As systemd 219 does: --value is unknown there; every version prints Linger=<value>.
    'for a; do [ "$a" = --value ] && { echo "unrecognized option \'--value\'" >&2; exit 1; }; done',
    'echo "Linger=$FAKE_LINGER"',
  ].join('\n'),
  systemctl: [
    'if [ "$1" = --user ]; then',
    '  [ -n "$FAKE_USER_MANAGER" ] || exit 1',
    '  case "$2" in',
    '    show-environment) echo "HOME=$HOME"; exit 0;;',
    '    is-enabled) echo "${FAKE_USER_UNIT_ENABLED:-disabled}"; [ "$FAKE_USER_UNIT_ENABLED" = enabled ]; exit;;',
    '  esac',
    '  exit 1',
    'fi',
    'case "$1 $2" in',
    '  "is-enabled cron.service") if [ -n "$FAKE_CRON" ]; then echo enabled; exit 0; fi; echo disabled; exit 1;;',
    'esac',
    'echo disabled',
    'exit 1',
  ].join('\n'),
  crontab: [
    '[ "$1" = -l ] || exit 2',
    'if [ -n "$FAKE_CRONTAB_DENIED" ]; then echo "You (walnut) are not allowed to use this program (crontab)" >&2; exit 1; fi',
    'if [ -f "$HOME/.fake-crontab" ]; then cat "$HOME/.fake-crontab"; exit 0; fi',
    'if [ -n "$FAKE_BUSYBOX" ]; then echo "crontab: can\'t open \'walnut\': No such file or directory" >&2; exit 1; fi',
    'echo "no crontab for walnut" >&2',
    'exit 1',
  ].join('\n'),
  pgrep: [
    '[ -n "$FAKE_CRON" ] && [ "$1" = -x ] && [ "$2" = cron ] && exit 0',
    'exit 1',
  ].join('\n'),
}
const REAL_TOOLS = ['sh', 'head', 'tr', 'grep', 'cat', 'mkdir']

function realTool(name: string): string {
  const found = ['/usr/bin', '/bin', '/usr/local/bin'].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file))
  if (!found) throw new Error(`${name} is not on this machine`)
  return found
}

let root: string
let home: string
let bin: string
let installRoot: string

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-boot-probe-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  installRoot = path.join(home, '.local', 'share', 'open-walnut', 'daemon')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(bin)
  for (const [name, body] of Object.entries(FAKES)) await fsp.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  for (const name of REAL_TOOLS) await fsp.symlink(realTool(name), path.join(bin, name))
})
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }) })

function sh(script: string, env: Record<string, string> = {}): string {
  const ran = spawnSync('/bin/sh', ['-s'], { input: script, env: { HOME: home, PATH: bin, ...env }, encoding: 'utf8', timeout: 10_000 })
  if (ran.error) throw ran.error
  return ran.stdout
}

function probe(env: Record<string, string> = {}): BootStartFacts {
  const facts = parseBootStartProbe(sh(buildBootStartProbeScript(), env))
  if (!facts) throw new Error('the probe gave no sentinel')
  return facts
}

async function put(file: string, text: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text)
}

const bootScriptPath = () => path.join(installRoot, 'daemon-boot.sh')
const userUnitPath = () => path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
const USER_LINES = '# my jobs\n*/5 * * * * /usr/bin/backup\n'

describe('boot start probe, run by sh', () => {
  it('reads a plain host with nothing installed and cron enabled as none, not blocked', () => {
    const facts = probe({ FAKE_CRON: '1' })
    expect(facts).toMatchObject({
      platform: 'linux', user: 'walnut', linger: 'unknown', userManager: false, userUnit: false, systemUnit: false,
      bootScript: false, cronLine: false, crontab: 'none', plist: false, attempt: null,
    })
    expect(facts.cron.ok).toBe(true)
    expect(classifyBootStart(facts)).toEqual({ mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', installed: false })
    expect(bootSetupBlocker(facts)).toBeNull()
  })

  it('reads BusyBox\'s missing crontab as none, not denied', () => {
    expect(probe({ FAKE_CRON: '1', FAKE_BUSYBOX: '1' })).toMatchObject({ crontab: 'none' })
  })

  it('reads an enabled user unit with linger on as a systemd user boot start', async () => {
    await put(userUnitPath(), '[Unit]\n')
    const facts = probe({ FAKE_USER_MANAGER: '1', FAKE_USER_UNIT_ENABLED: 'enabled', FAKE_LINGER: 'yes' })
    expect(facts).toMatchObject({ userManager: true, userUnit: true, userUnitEnabled: 'enabled', linger: 'yes' })
    expect(classifyBootStart(facts)).toEqual({ mode: 'boot', backend: 'systemd-user', reason: null, installed: true })
  })

  it('reads an enabled user unit with linger off as a login start', async () => {
    await put(userUnitPath(), '[Unit]\n')
    const start = classifyBootStart(probe({ FAKE_USER_MANAGER: '1', FAKE_USER_UNIT_ENABLED: 'enabled', FAKE_LINGER: 'no' }))
    expect(start).toMatchObject({ mode: 'login', backend: 'systemd-user', installed: true })
    expect(start.reason).toContain('linger is off')
  })

  it('reads a disabled user unit as none', async () => {
    await put(userUnitPath(), '[Unit]\n')
    const start = classifyBootStart(probe({ FAKE_USER_MANAGER: '1', FAKE_LINGER: 'yes' }))
    expect(start).toMatchObject({ mode: 'none', reason: 'its systemd user service is not enabled', installed: true })
  })

  it('reads the boot script with its @reboot line and cron enabled as a cron boot start', async () => {
    await put(bootScriptPath(), '#!/bin/sh\n')
    await put(path.join(home, '.fake-crontab'), `${USER_LINES}${daemonCronLine(bootScriptPath())}\n`)
    const facts = probe({ FAKE_CRON: '1' })
    expect(facts).toMatchObject({ bootScript: true, cronLine: true, crontab: 'ok' })
    expect(classifyBootStart(facts)).toEqual({ mode: 'boot', backend: 'cron', reason: null, installed: true })
  })

  // Bug: the probe greps for "$HOME/.local/...", so a HOME ending in a slash never matches the normalized path in the line.
  it('finds the @reboot line when HOME ends in a slash', async () => {
    await put(bootScriptPath(), '#!/bin/sh\n')
    await put(path.join(home, '.fake-crontab'), `${daemonCronLine(bootScriptPath())}\n`)
    const facts = parseBootStartProbe(sh(buildBootStartProbeScript(), { HOME: `${home}/`, FAKE_CRON: '1' }))!
    expect(facts.bootScript).toBe(true)
    expect(facts.cronLine).toBe(true)
  })

  it('reads the boot script without its line as none', async () => {
    await put(bootScriptPath(), '#!/bin/sh\n')
    await put(path.join(home, '.fake-crontab'), USER_LINES)
    const facts = probe({ FAKE_CRON: '1' })
    expect(facts).toMatchObject({ bootScript: true, cronLine: false, crontab: 'ok' })
    expect(classifyBootStart(facts)).toEqual({ mode: 'none', backend: null, reason: 'the @reboot line is missing from its crontab', installed: true })
  })

  it('does not count a line for the script that is not an @reboot line', async () => {
    await put(bootScriptPath(), '#!/bin/sh\n')
    await put(path.join(home, '.fake-crontab'), `0 3 * * * /bin/sh '${bootScriptPath()}'\n`)
    expect(probe({ FAKE_CRON: '1' }).cronLine).toBe(false)
  })

  it('reads the boot script and line with no cron daemon as none, with the reason', async () => {
    await put(bootScriptPath(), '#!/bin/sh\n')
    await put(path.join(home, '.fake-crontab'), `${daemonCronLine(bootScriptPath())}\n`)
    const facts = probe()
    expect(facts.cron).toEqual({ ok: false, reason: 'no cron daemon is enabled at boot or running here' })
    expect(classifyBootStart(facts)).toEqual({
      mode: 'none', backend: null, reason: 'the @reboot line is in place, but no cron daemon is enabled at boot or running here', installed: true,
    })
  })

  it('blocks a host with no crontab binary and no user manager, naming the admin step', async () => {
    await fsp.rm(path.join(bin, 'crontab'))
    const facts = probe()
    expect(facts.crontab).toBe('missing')
    expect(facts.userManager).toBe(false)
    const blocker = bootSetupBlocker(facts)
    expect(blocker).toContain('crontab is not installed')
    expect(blocker).toContain('"loginctl enable-linger walnut"')
  })

  it('reads a denied crontab as denied', () => {
    const facts = probe({ FAKE_CRON: '1', FAKE_CRONTAB_DENIED: '1' })
    expect(facts.crontab).toBe('denied')
    expect(bootSetupBlocker(facts)).toContain('this account may not use crontab')
  })

  it('does not block a host whose user manager answers even with crontab missing', async () => {
    await fsp.rm(path.join(bin, 'crontab'))
    expect(bootSetupBlocker(probe({ FAKE_USER_MANAGER: '1', FAKE_LINGER: 'no' }))).toBeNull()
  })

  it('reads the setup marker as the last attempt', async () => {
    await put(path.join(installRoot, 'boot-setup'), 'v=walnut-daemon-abc123 at=1700000000000 result=failed\n')
    expect(probe({ FAKE_CRON: '1' }).attempt).toEqual({ version: 'walnut-daemon-abc123', at: 1_700_000_000_000, ok: false })
  })

  it('reads back the marker its own command writes, privately', async () => {
    sh(bootSetupMarkerCommand('walnut-daemon-abc123', 1_700_000_000_123.7, true))
    const marker = path.join(installRoot, 'boot-setup')
    expect(await fsp.readFile(marker, 'utf8')).toBe('v=walnut-daemon-abc123 at=1700000000123 result=ok\n')
    expect((await fsp.stat(marker)).mode & 0o077).toBe(0)
    expect(probe({ FAKE_CRON: '1' }).attempt).toEqual({ version: 'walnut-daemon-abc123', at: 1_700_000_000_123, ok: true })
  })

  it('reads a Mac with a login agent as a login start', async () => {
    await put(path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist'), '<plist/>\n')
    const facts = probe({ FAKE_UNAME: 'Darwin' })
    expect(facts.platform).toBe('darwin')
    expect(classifyBootStart(facts)).toMatchObject({ mode: 'login', backend: 'launchd', installed: true })
    expect(bootSetupBlocker(facts)).toContain('Linux hosts only')
  })
})

describe('boot start probe parsing', () => {
  it('returns null without the sentinel', () => {
    expect(parseBootStartProbe('platform=Linux\nuser=walnut\ncrontab=ok\n')).toBeNull()
    expect(parseBootStartProbe('')).toBeNull()
  })

  it('ignores a malformed attempt and an unknown crontab word', () => {
    const facts = parseBootStartProbe('platform=Linux\ncrontab=weird\nattempt=v=x at=soon result=ok\nwalnut-boot-probe-done\n')!
    expect(facts.crontab).toBe('missing')
    expect(facts.attempt).toBeNull()
  })

  it('names another platform it cannot set up', () => {
    const facts = parseBootStartProbe('platform=FreeBSD\nwalnut-boot-probe-done\n')!
    expect(bootSetupBlocker(facts)).toBe('Walnut cannot set up a boot start on freebsd')
  })
})

describe('when a boot setup is due', () => {
  const expected = 'walnut-daemon-new'
  const now = 1_000 * 3_600_000
  const hour = 3_600_000
  const base = parseBootStartProbe('platform=Linux\nwalnut-boot-probe-done\n')!
  const withAttempt = (attempt: BootStartFacts['attempt']): BootStartFacts => ({ ...base, attempt })

  it.each([
    ['no attempt', null, true],
    ['an attempt that worked', { version: expected, at: now - hour, ok: true }, true],
    ['the same build failed 1h ago', { version: expected, at: now - hour, ok: false }, false],
    ['the same build failed 23h ago', { version: expected, at: now - 23 * hour, ok: false }, false],
    ['the same build failed 25h ago', { version: expected, at: now - 25 * hour, ok: false }, true],
    ['another build failed 1h ago', { version: 'walnut-daemon-old', at: now - hour, ok: false }, false],
    ['another build failed 7h ago', { version: 'walnut-daemon-old', at: now - 7 * hour, ok: false }, true],
    ['an attempt dated in the future', { version: expected, at: now + hour, ok: false }, true],
  ] as const)('%s: due %s', (_name, attempt, due) => {
    expect(bootSetupDue(withAttempt(attempt), expected, now)).toBe(due)
  })

  it('keeps its retry windows a day for the same build and six hours for any', () => {
    expect(BOOT_SETUP_RETRY_SAME_BUILD_MS).toBe(24 * hour)
    expect(BOOT_SETUP_RETRY_ANY_BUILD_MS).toBe(6 * hour)
  })
})

describe('boot setup marker command', () => {
  it.each(['walnut-daemon-1;rm -rf ~', 'other-1234', 'walnut-daemon-', "walnut-daemon-a'b"])('rejects the version %j', (version) => {
    expect(() => bootSetupMarkerCommand(version, 1, true)).toThrow('Invalid daemon build version')
  })
})

describe('boot start words', () => {
  it.each([
    [{ mode: 'boot', backend: 'cron', reason: null }, undefined, 'starts by itself after a reboot (from its crontab)'],
    [{ mode: 'boot', backend: 'systemd-user', reason: null }, undefined, 'starts by itself after a reboot (as a systemd user service)'],
    [{ mode: 'boot', backend: 'systemd-system', reason: null }, undefined, 'starts by itself after a reboot (as a systemd service)'],
    [{ mode: 'boot', backend: null, reason: null }, undefined, 'starts by itself after a reboot'],
    [{ mode: 'login', backend: 'systemd-user', reason: 'linger is off' }, undefined, 'starts after a reboot only once you log in there (linger is off)'],
    [{ mode: 'login', backend: 'launchd', reason: null }, undefined, 'starts after a reboot only once you log in there (login only)'],
    [{ mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot' }, undefined, 'does not start by itself after a reboot: nothing on it starts the daemon at boot'],
    [{ mode: 'none', backend: null, reason: 'nothing' }, { error: 'Walnut could not set it up: busy' }, 'does not start by itself after a reboot: Walnut could not set it up: busy'],
    [{ mode: 'none', backend: null, reason: null }, null, 'does not start by itself after a reboot'],
    [{ mode: 'none', backend: null, reason: 'nothing' }, { running: true }, 'Walnut is setting it up to start after a reboot'],
    [{ mode: 'boot', backend: 'cron', reason: null }, { running: true }, 'Walnut is setting it up to start after a reboot'],
  ] as const)('%j with setup %j', (start, setup, words) => {
    expect(bootStartWords(start, setup)).toBe(words)
  })
})

describe('an uninstall on the host', () => {
  it('is read from the marker and never undone from the server', async () => {
    const { parseBootStartProbe, bootSetupDue } = await import('../../src/providers/remote-boot-start.js')
    const facts = parseBootStartProbe('platform=Linux\nattempt=v=uninstall at=1000 result=removed\nwalnut-boot-probe-done\n')!
    expect(facts.attempt).toEqual({ version: 'uninstall', at: 1000, ok: false, removed: true })
    expect(bootSetupDue(facts, 'walnut-daemon-abc', 10 * 24 * 3_600_000)).toBe(false)
  })
})
