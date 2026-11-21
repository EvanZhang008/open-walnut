/**
 * `walnut daemon install|update` with the launcher (DaemonServiceDeps.launcher, the experiment
 * service_launcher): the systemd/launchd manager and the cron manager write the launcher script and a
 * config that runs it, ask the launcher for the switch and wait for its answer; a plain config becomes
 * the launcher's with the old daemon as its first version; with the experiment off a launcher's config
 * becomes the plain one again; and an older Walnut can still read and rewrite what this one wrote.
 */
import { describe, expect, it } from 'vitest'
import {
  createDaemonServiceManager, daemonServiceConfigPath, type DaemonServiceCommandResult, type DaemonServiceDeps,
} from '../../src/providers/daemon-service-manager.js'
import { createCronDaemonServiceManager, type CronServiceDeps } from '../../src/providers/daemon-service-cron.js'
import {
  hasLauncherShape, readDaemonServiceExecutable, renderDaemonLaunchAgent, renderDaemonSystemdUnit, replaceDaemonServiceExecutable, type DaemonServiceConfig,
} from '../../src/providers/daemon-service-config.js'
import {
  cronLineState, crontabWithDaemonLine, daemonCronLine, daemonCronMinuteLine, readDaemonBootExecutable, renderDaemonBootScript,
} from '../../src/providers/daemon-service-boot-script.js'
import { launcherSeed, type LauncherControl, type LauncherResult } from '../../src/providers/service-launcher-control.js'
import { isLauncherScript, renderLauncherScript } from '../../src/providers/service-launcher-script.js'

const HOME = '/home/walnut'
const ROOT = `${HOME}/.local/share/open-walnut/daemon`
const OLD = `${ROOT}/versions/${'a'.repeat(64)}/daemon`
const NEW = `${ROOT}/versions/${'b'.repeat(64)}/daemon`
const UNIT = daemonServiceConfigPath('linux', HOME, 'user')
const SCRIPT = `${ROOT}/walnut-launcher.sh`
const BOOT = `${ROOT}/daemon-boot.sh`

const config = (executable: string, platform: 'linux' | 'darwin' = 'linux'): DaemonServiceConfig => ({
  platform, home: HOME, executable, args: ['--service'], runtimeDir: '/tmp/open-walnut', stateDir: ROOT, path: '/usr/bin:/bin',
})

/** A launcher double: records what it was asked, and answers a switch with `answer`. */
function fakeLauncher(script: string, backend: 'systemd' | 'cron', o: { answer?: LauncherResult['outcome']; refuses?: string; current?: string } = {}) {
  const asked: string[] = []
  const files = new Map<string, string>()
  const control: LauncherControl = {
    script,
    render: (c, seed) => renderLauncherScript({ ...c, executable: seed }, { backend, self: script }),
    seed: async () => launcherSeed(files.get(script) ?? ''),
    facts: async () => (o.current ? { current: o.current, good: o.current, phase: 'committed', since: 1 } : null),
    request: async (exe, prepared) => { asked.push(`request ${exe} prepared=${prepared}`); return 'id1' },
    prepared: async (id) => { asked.push(`prepared ${id}`) },
    withdraw: async (id) => { asked.push(`withdraw ${id}`) },
    wait: async (id) => { asked.push(`wait ${id}`); return { id, outcome: o.answer ?? 'committed', exe: NEW, reason: o.answer === 'rolledback' ? 'the new version was not ready within 90 s' : '' } },
    chmod: async () => { asked.push('chmod') },
    refuses: async () => o.refuses ?? null,
    rollback: async (exe) => { asked.push(`rollback ${exe}`); return { id: 'b1', outcome: 'rolledback', exe, reason: '' } },
    reset: async () => { asked.push('reset') },
  }
  return { control, asked, files }
}

function systemdHarness(o: { unit: string | null; launcher?: ReturnType<typeof fakeLauncher>; prepared?: string }) {
  const files = o.launcher?.files ?? new Map<string, string>()
  if (o.unit !== null) files.set(UNIT, o.unit)
  const commands: string[] = []
  const run = async (program: string, args: string[]): Promise<DaemonServiceCommandResult> => {
    const line = [program, ...args].join(' ')
    commands.push(line)
    if (line.includes('is-active')) return { code: files.has(UNIT) ? 0 : 3, stdout: files.has(UNIT) ? 'active\n' : 'inactive\n', stderr: '' }
    if (line.includes('is-enabled')) return { code: files.has(UNIT) ? 0 : 1, stdout: files.has(UNIT) ? 'enabled\n' : 'disabled\n', stderr: '' }
    if (line.includes(' show ')) return { code: 0, stdout: `FragmentPath=${files.has(UNIT) ? UNIT : ''}\nDropInPaths=\n`, stderr: '' }
    if (line.startsWith('loginctl')) return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const events: string[] = []
  const deps: DaemonServiceDeps = {
    platform: 'linux', home: HOME, uid: 1000, user: 'walnut', path: '/usr/bin:/bin', stateDir: ROOT, runtimeDir: '/tmp/open-walnut', run,
    writeConfig: async (file, text) => { events.push(`write ${file}`); files.set(file, text) },
    removeConfig: async (file) => { files.delete(file) },
    readConfig: async (file) => files.get(file) ?? null,
    inspectConfig: async (file) => ({ present: files.has(file), owned: files.has(file) }),
    prepareExecutable: async () => ({ executable: o.prepared ?? NEW, args: ['--service'] }),
    ready: async (_s, exe) => { events.push(`ready ${exe}`); return true },
    stay: async () => null,
    prepareUpdate: async () => { events.push('prepareUpdate') },
    proveBoot: async () => null,
    ...(o.launcher ? { launcher: o.launcher.control } : {}),
    sleep: async () => {},
  }
  return { manager: createDaemonServiceManager(deps), files, commands, events }
}

describe('the systemd manager with the launcher', () => {
  it('turns a plain unit into the launcher\'s, with the running daemon as its first version, and asks for the switch', async () => {
    const L = fakeLauncher(SCRIPT, 'systemd')
    const h = systemdHarness({ unit: renderDaemonSystemdUnit(config(OLD), 'user'), launcher: L })
    const result = await h.manager.update({ scope: 'user' })
    expect(result.ok).toBe(true)
    const unit = h.files.get(UNIT)!
    expect(unit).toContain(`ExecStart="${SCRIPT}" "--service"`)
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('StartLimitIntervalSec=0')
    expect(launcherSeed(h.files.get(SCRIPT)!)).toBe(OLD)
    // The request waits for the old daemon's prepare, the unit restarts into the launcher, then its answer.
    expect(L.asked).toEqual(['reset', `request ${NEW} prepared=false`, 'chmod', 'prepared id1', 'wait id1'])
    expect(h.events.indexOf('prepareUpdate')).toBeLessThan(h.events.indexOf(`ready ${NEW}`))
    expect(h.commands).toContain('systemctl --user daemon-reload')
    expect(h.commands).toContain('systemctl --user restart open-walnut-daemon.service')
  })

  it('a launcher already running takes the switch itself: the unit is neither rewritten nor restarted', async () => {
    const L = fakeLauncher(SCRIPT, 'systemd', { current: OLD })
    const unit = renderDaemonSystemdUnit(config(OLD), 'user', { launcher: SCRIPT })
    L.files.set(SCRIPT, renderLauncherScript(config(OLD), { backend: 'systemd', self: SCRIPT }))
    const h = systemdHarness({ unit, launcher: L })
    const result = await h.manager.update({ scope: 'user' })
    expect(result.ok).toBe(true)
    expect(h.files.get(UNIT)).toBe(unit)
    expect(h.commands.some((c) => c.includes('restart') || c.includes('daemon-reload'))).toBe(false)
    // The seed stays the launcher's: only the launcher writes which version runs.
    expect(launcherSeed(h.files.get(SCRIPT)!)).toBe(OLD)
    expect(L.asked).toContain(`request ${NEW} prepared=false`)
    expect(L.asked).not.toContain('reset')
  })

  it('a switch the launcher put back is the build\'s failure (the server holds it a day)', async () => {
    const L = fakeLauncher(SCRIPT, 'systemd', { current: OLD, answer: 'rolledback' })
    L.files.set(SCRIPT, renderLauncherScript(config(OLD), { backend: 'systemd', self: SCRIPT }))
    const h = systemdHarness({ unit: renderDaemonSystemdUnit(config(OLD), 'user', { launcher: SCRIPT }), launcher: L })
    const result = await h.manager.update({ scope: 'user' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('launcherRolledBack')
    expect(result.failure.stopped).toBe(true)
    expect(result.failure.message).toMatch(/not ready within 90 s/)
  })

  it('a version the launcher refuses today changes nothing and stops no daemon', async () => {
    const L = fakeLauncher(SCRIPT, 'systemd', { current: OLD, refuses: 'this version failed here 3 minutes ago' })
    const h = systemdHarness({ unit: renderDaemonSystemdUnit(config(OLD), 'user', { launcher: SCRIPT }), launcher: L })
    const result = await h.manager.update({ scope: 'user' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('launcherRefused')
    expect(h.events).not.toContain('prepareUpdate')
    expect(h.events.some((e) => e.startsWith('write'))).toBe(false)
  })

  it('with the experiment off, a launcher\'s unit becomes the plain unit again', async () => {
    const h = systemdHarness({ unit: renderDaemonSystemdUnit(config(OLD), 'user', { launcher: SCRIPT }) })
    const result = await h.manager.update({ scope: 'user' })
    expect(result.ok).toBe(true)
    expect(h.files.get(UNIT)).toBe(renderDaemonSystemdUnit(config(NEW), 'user'))
  })

  it('a launcher unit an older Walnut put its daemon in (its restart policy kept) becomes the plain unit, whole', async () => {
    const oldWalnuts = replaceDaemonServiceExecutable('linux', renderDaemonSystemdUnit(config(OLD), 'user', { launcher: SCRIPT }), OLD)
    expect(hasLauncherShape('linux', oldWalnuts)).toBe(true)
    expect(hasLauncherShape('linux', renderDaemonSystemdUnit(config(OLD), 'user'))).toBe(false)
    const h = systemdHarness({ unit: oldWalnuts })
    expect((await h.manager.update({ scope: 'user' })).ok).toBe(true)
    expect(h.files.get(UNIT)).toBe(renderDaemonSystemdUnit(config(NEW), 'user'))
  })
})

describe('what an older Walnut reads in the launcher\'s configs', () => {
  it('reads the launcher unit and plist like its own, and its update puts its daemon in the launcher\'s place', () => {
    const unit = renderDaemonSystemdUnit(config(OLD), 'user', { launcher: SCRIPT })
    expect(readDaemonServiceExecutable('linux', unit)).toBe(SCRIPT)
    const rewritten = replaceDaemonServiceExecutable('linux', unit, OLD)
    expect(readDaemonServiceExecutable('linux', rewritten)).toBe(OLD)
    const plist = renderDaemonLaunchAgent(config(OLD, 'darwin'), { launcher: SCRIPT })
    expect(plist).toContain('<key>KeepAlive</key>\n\t<true/>')
    expect(readDaemonServiceExecutable('darwin', plist)).toBe(SCRIPT)
    expect(hasLauncherShape('darwin', replaceDaemonServiceExecutable('darwin', plist, OLD))).toBe(true)
    expect(hasLauncherShape('darwin', renderDaemonLaunchAgent(config(OLD, 'darwin')))).toBe(false)
  })

  it('reads the cron launcher as a boot script: its EXEC, its single @reboot line put back', () => {
    const text = renderLauncherScript(config(OLD), { backend: 'cron', self: BOOT })
    expect(isLauncherScript(text)).toBe(true)
    expect(readDaemonBootExecutable(text)).toBe(OLD)
    const both = crontabWithDaemonLine('MAILTO=x\n', BOOT, { everyMinute: true })
    expect(both).toBe(`MAILTO=x\n${daemonCronLine(BOOT)}\n${daemonCronMinuteLine(BOOT)}\n`)
    expect(cronLineState(both, BOOT, { everyMinute: true })).toBe('ours')
    expect(cronLineState(both, BOOT)).toBe('stale')
    expect(crontabWithDaemonLine(both, BOOT)).toBe(`MAILTO=x\n${daemonCronLine(BOOT)}\n`)
  })
})

describe('the cron manager with the launcher', () => {
  function cronHarness(o: { script: string; launcher?: ReturnType<typeof fakeLauncher>; crontab: string }) {
    const files = o.launcher?.files ?? new Map<string, string>()
    files.set(BOOT, o.script)
    let crontab = o.crontab
    const events: string[] = []
    let daemonExe = OLD
    const deps: CronServiceDeps = {
      platform: 'linux', home: HOME, uid: 1000, user: 'walnut', path: '/usr/bin:/bin', stateDir: ROOT, runtimeDir: '/tmp/open-walnut',
      run: async (program, args, input) => {
        if (program === 'crontab' && args[0] === '-l') return { code: 0, stdout: crontab, stderr: '' }
        if (program === 'crontab' && args[0] === '-') { crontab = input ?? ''; events.push('crontab'); return { code: 0, stdout: '', stderr: '' } }
        return { code: 0, stdout: 'enabled cron.service\n', stderr: '' }
      },
      writeConfig: async (file, text) => { events.push(`write ${file}`); files.set(file, text) },
      removeConfig: async (file) => { files.delete(file) },
      readConfig: async (file) => files.get(file) ?? null,
      inspectConfig: async (file) => ({ present: files.has(file), owned: files.has(file) }),
      prepareExecutable: async () => ({ executable: NEW, args: ['--service'] }),
      ready: async () => { daemonExe = NEW; return true },
      stay: async () => null,
      prepareUpdate: async () => { events.push('prepareUpdate') },
      proveBoot: async () => null,
      spawnDetached: async () => { events.push('spawn') },
      serviceDaemon: async () => ({ pid: 4242, executable: daemonExe }),
      supervisor: async () => 4241,
      signal: async (pid, sig) => { events.push(`signal ${pid} ${sig}`) },
      waitGone: async () => true,
      setStop: async () => {},
      ...(o.launcher ? { launcher: o.launcher.control } : {}),
    }
    return { manager: createCronDaemonServiceManager(deps), files, events, crontab: () => crontab }
  }

  it('turns the plain boot script into the launcher, adds the minute line, and asks for the switch', async () => {
    const L = fakeLauncher(BOOT, 'cron')
    const h = cronHarness({ script: renderDaemonBootScript(config(OLD)), launcher: L, crontab: `${daemonCronLine(BOOT)}\n` })
    const result = await h.manager.update()
    expect(result.ok).toBe(true)
    expect(isLauncherScript(h.files.get(BOOT)!)).toBe(true)
    expect(launcherSeed(h.files.get(BOOT)!)).toBe(OLD)
    expect(cronLineState(h.crontab(), BOOT, { everyMinute: true })).toBe('ours')
    expect(L.asked).toEqual(['reset', `request ${NEW} prepared=false`, 'chmod', 'prepared id1', 'wait id1'])
  })

  it('with the experiment off, the launcher becomes the plain boot script and its single line', async () => {
    const h = cronHarness({
      script: renderLauncherScript(config(OLD), { backend: 'cron', self: BOOT }),
      crontab: `${daemonCronLine(BOOT)}\n${daemonCronMinuteLine(BOOT)}\n`,
    })
    const result = await h.manager.update()
    expect(result.ok).toBe(true)
    expect(h.files.get(BOOT)).toBe(renderDaemonBootScript(config(NEW)))
    expect(h.crontab()).toBe(`${daemonCronLine(BOOT)}\n`)
  })
})

describe('the launcher state an older Walnut left behind', () => {
  it('reset() forgets the versions and the pending switch, and keeps the day-long refusals and the last put-back', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { createLauncherControl } = await import('../../src/providers/service-launcher-control.js')
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-launcher-reset-'))
    try {
      const dir = path.join(stateDir, 'launcher')
      await fs.mkdir(dir)
      for (const name of ['state', 'request', 'result', 'ready', 'bad', 'rollback']) await fs.writeFile(path.join(dir, name), `${name}\n`)
      await createLauncherControl({ stateDir, backend: 'systemd' }).reset()
      expect((await fs.readdir(dir)).sort()).toEqual(['bad', 'rollback'])
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })
})
