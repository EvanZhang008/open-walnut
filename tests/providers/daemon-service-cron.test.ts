import { describe, it, expect } from 'vitest'
import { createCronDaemonServiceManager, type CronServiceDeps } from '../../src/providers/daemon-service-cron.js'
import {
  CRON_BOOT_PROBE_SCRIPT,
  daemonCronLine,
  isNoCrontab,
  readDaemonBootExecutable,
  renderDaemonBootScript,
} from '../../src/providers/daemon-service-boot-script.js'
import {
  DaemonServiceUpdateRefusedError,
  type DaemonServiceFailure,
  type DaemonServiceResult,
  type DaemonServiceStatus,
} from '../../src/providers/daemon-service-manager.js'

const HOME = '/home/walnut'
const STATE = '/home/walnut/.local/share/open-walnut/daemon'
const SCRIPT = `${STATE}/daemon-boot.sh`
const RUNTIME_DIR = '/tmp/open-walnut'
const UNIT_USER = '/home/walnut/.config/systemd/user/open-walnut-daemon.service'
const UNIT_SYSTEM = '/etc/systemd/system/open-walnut-daemon.service'
const OLD_EXE = `${STATE}/versions/walnut-daemon-old/open-walnut-daemon`
const NEW_EXE = `${STATE}/versions/walnut-daemon-new/open-walnut-daemon`
const DEPS_PATH = '/usr/local/bin:/usr/bin:/bin'
const USER_TAB = '# backups\n\nMAILTO=""\n*/5 * * * * /usr/bin/backup --quiet\n@reboot /home/walnut/bin/tunnel.sh\n'
const LINE = daemonCronLine(SCRIPT)
const ENABLED_CRON = 'enabled cron.service'

const bootScript = (executable: string, pathValue = DEPS_PATH): string => renderDaemonBootScript({
  platform: 'linux', home: HOME, executable, args: ['--service'], runtimeDir: RUNTIME_DIR, stateDir: STATE, path: pathValue,
})

interface HarnessOptions {
  platform?: 'linux' | 'darwin'
  uid?: number
  user?: string
  /** The boot script is on disk (owned) and the crontab carries our line. */
  installed?: { executable: string; path?: string }
  /** A supervisor and a daemon run from the installed script. */
  running?: boolean
  /** The crontab text; null: the account has none yet. Defaults to USER_TAB (+ LINE when installed). */
  crontab?: string | null
  crontabDenied?: boolean
  cron?: string
  files?: Record<string, { text: string; owned: boolean }>
  ready?: boolean[]
  daemonStuck?: boolean
  /** The supervisor gives up (its 5 failures in 60 s) at this daemon exit instead of restarting it. */
  supervisorGivesUpAt?: number
  prepareUpdate?: () => Promise<void | 'prepared' | 'unprepared'>
  handover?: () => Promise<boolean>
}

function harness(options: HarnessOptions = {}) {
  const timeline: string[] = []
  const commands: string[] = []
  const writes: { path: string; text: string }[] = []
  const tabWrites: string[] = []
  const readyCalls: { status: DaemonServiceStatus; expected?: string }[] = []
  const readyQueue = [...(options.ready ?? [])]
  const files = new Map<string, { text: string; owned: boolean }>(Object.entries(options.files ?? {}))
  let prepareCalls = 0
  let nextPid = 100
  let tab: string | null = options.crontab !== undefined ? options.crontab : USER_TAB + (options.installed ? `${LINE}\n` : '')
  const procs = {
    supervisor: null as number | null,
    daemon: null as { pid: number; executable: string } | null,
    stop: false,
  }

  if (options.installed) files.set(SCRIPT, { text: bootScript(options.installed.executable, options.installed.path), owned: true })

  const startDaemon = () => { procs.daemon = { pid: nextPid++, executable: readDaemonBootExecutable(files.get(SCRIPT)!.text) } }
  let exits = 0
  // The supervisor restarts an exiting daemon from the script as it is on disk, unless the stop file is set.
  const daemonExited = () => {
    procs.daemon = null
    exits += 1
    if (procs.supervisor === null) return
    if (options.supervisorGivesUpAt === exits) { procs.supervisor = null; return }
    if (procs.stop || !files.has(SCRIPT)) { procs.supervisor = null; return }
    startDaemon()
  }
  if (options.running) {
    procs.supervisor = nextPid++
    startDaemon()
  }

  const deps: CronServiceDeps = {
    platform: options.platform ?? 'linux',
    home: HOME,
    uid: options.uid ?? 1000,
    user: options.user ?? 'walnut',
    path: DEPS_PATH,
    stateDir: STATE,
    runtimeDir: RUNTIME_DIR,
    async run(program, args, input) {
      if (program === '/bin/sh' && args.length === 2 && args[0] === '-c' && args[1] === CRON_BOOT_PROBE_SCRIPT) {
        timeline.push('run:cron-probe')
        return { code: 0, stdout: `${options.cron ?? ENABLED_CRON}\n`, stderr: '' }
      }
      const line = [program, ...args].join(' ')
      timeline.push(`run:${line}`)
      commands.push(line)
      if (line === 'crontab -l') {
        if (options.crontabDenied) return { code: 1, stdout: '', stderr: 'You (walnut) are not allowed to use this program (crontab)\n' }
        if (tab === null) return { code: 1, stdout: '', stderr: 'no crontab for walnut\n' }
        return { code: 0, stdout: tab, stderr: '' }
      }
      if (line === 'crontab -') {
        tab = input ?? ''
        tabWrites.push(tab)
        return { code: 0, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${line}`)
    },
    async writeConfig(file, text) {
      timeline.push(`write:${file}`)
      writes.push({ path: file, text })
      files.set(file, { text, owned: true })
    },
    async removeConfig(file) {
      timeline.push(`remove:${file}`)
      files.delete(file)
    },
    async prepareExecutable() {
      timeline.push('prepare')
      prepareCalls++
      return { executable: NEW_EXE, args: ['--service'] }
    },
    async inspectConfig(file) {
      return { present: files.has(file), owned: files.get(file)?.owned ?? false }
    },
    async readConfig(file) {
      return files.get(file)?.text ?? null
    },
    async ready(status, expected) {
      timeline.push('ready')
      readyCalls.push({ status, expected })
      const forced = readyQueue.shift()
      if (forced !== undefined) return forced
      return procs.daemon !== null && (!expected || procs.daemon.executable === expected)
    },
    ...(options.handover ? { handover: async () => { timeline.push('handover'); return options.handover!() } } : {}),
    prepareUpdate: async () => {
      timeline.push('prepareUpdate')
      if (options.prepareUpdate) return options.prepareUpdate()
      daemonExited()
    },
    async spawnDetached(program, args) {
      timeline.push(`spawn:${program} ${args.join(' ')}`)
      expect([program, ...args]).toEqual(['/bin/sh', SCRIPT])
      if (procs.stop || !files.has(SCRIPT) || procs.supervisor !== null) return
      procs.supervisor = nextPid++
      startDaemon()
    },
    async serviceDaemon() {
      return procs.daemon ? { ...procs.daemon } : null
    },
    async supervisor() {
      return procs.supervisor
    },
    async signal(pid, signal) {
      timeline.push(`signal:${pid}:${signal}`)
      if (procs.daemon?.pid === pid) {
        if (options.daemonStuck && signal === 'SIGTERM') return
        daemonExited()
      } else if (procs.supervisor === pid) {
        procs.supervisor = null
      }
    },
    async waitGone(pid) {
      return procs.daemon?.pid !== pid && procs.supervisor !== pid
    },
    async setStop(on) {
      timeline.push(`stop:${on ? 'on' : 'off'}`)
      procs.stop = on
    },
  }

  return {
    manager: createCronDaemonServiceManager(deps),
    deps,
    timeline,
    commands,
    writes,
    tabWrites,
    readyCalls,
    files,
    procs,
    crontab: () => tab,
    prepareCalls: () => prepareCalls,
  }
}

type Harness = ReturnType<typeof harness>

function expectOk(result: DaemonServiceResult): DaemonServiceStatus {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.failure)}`)
  return result.status
}

function expectFailure(result: DaemonServiceResult): DaemonServiceFailure {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.status)}`)
  return result.failure
}

const PRIVILEGED = /sudo|enable-linger|systemctl|loginctl/

function expectUnprivileged(h: Harness) {
  expect(CRON_BOOT_PROBE_SCRIPT).not.toMatch(/sudo|enable-linger/)
  for (const command of h.commands) {
    expect(command).toMatch(/^crontab -l?$/)
    expect(command).not.toMatch(PRIVILEGED)
  }
}

function expectUntouched(h: Harness) {
  expect(h.writes).toEqual([])
  expect(h.tabWrites).toEqual([])
  expect(h.timeline.filter((event) => /^(spawn|signal|remove|stop):/.test(event))).toEqual([])
}

describe('cron boot install', () => {
  it('writes the script and exactly one crontab line, keeps the user lines, and starts the supervisor', async () => {
    const h = harness({ handover: async () => true })
    const status = expectOk(await h.manager.install())

    expect(status).toMatchObject({ scope: 'cron', installed: true, enabled: true, active: true, startup: 'boot' })
    expect(h.writes).toEqual([{ path: SCRIPT, text: bootScript(NEW_EXE) }])
    expect(h.tabWrites).toEqual([`${USER_TAB}${LINE}\n`])
    expect(h.crontab()!.split('\n').filter((line) => line === LINE)).toHaveLength(1)
    expect(h.crontab()!.startsWith(USER_TAB)).toBe(true)
    expect(h.procs.supervisor).not.toBeNull()
    expect(h.procs.daemon?.executable).toBe(NEW_EXE)
    expect(h.readyCalls[0].expected).toBe(NEW_EXE)
    const order = [`write:${SCRIPT}`, 'handover', 'run:crontab -', `spawn:/bin/sh ${SCRIPT}`, 'ready'].map((event) => h.timeline.indexOf(event))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expectUnprivileged(h)
  })

  it('treats an account with no crontab yet as an empty one', async () => {
    const h = harness({ crontab: null })
    expectOk(await h.manager.install())
    expect(h.crontab()).toBe(`${LINE}\n`)
  })

  it.each([
    ['a systemd user unit is installed', { files: { [UNIT_USER]: { text: '[Unit]\n', owned: true } } }, 'foreignConfig'],
    ['a systemd system unit is installed', { files: { [UNIT_SYSTEM]: { text: '[Unit]\n', owned: false } } }, 'foreignConfig'],
    ['crontab -l is denied', { crontabDenied: true }, 'cronUnavailable'],
    ['no cron daemon starts at boot', { cron: 'missing' }, 'cronUnavailable'],
    ['the cron probe cannot tell', { cron: 'garbage' }, 'cronUnavailable'],
    ['the script exists but is not owned', { files: { [SCRIPT]: { text: '#!/bin/sh\necho hi\n', owned: false } } }, 'foreignConfig'],
    ['a tagged crontab line points at another script', { crontab: `${USER_TAB}${daemonCronLine('/opt/other/daemon-boot.sh')}\n` }, 'foreignConfig'],
  ] as const)('refuses when %s', async (_name, options, code) => {
    const h = harness(options as HarnessOptions)
    expect(expectFailure(await h.manager.install()).code).toBe(code)
    expectUntouched(h)
    expect(h.prepareCalls()).toBe(0)
    expectUnprivileged(h)
  })

  it('names crontab -l and its stderr when the crontab is denied', async () => {
    const h = harness({ crontabDenied: true })
    const failure = expectFailure(await h.manager.install())
    expect(failure.command).toBe('crontab -l')
    expect(failure.stderr).toContain('not allowed')
  })

  it('restarts a running service onto the new executable without a second supervisor or crontab line', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    const supervisor = h.procs.supervisor
    const oldPid = h.procs.daemon!.pid
    const status = expectOk(await h.manager.install())

    expect(status.startup).toBe('boot')
    expect(h.procs.supervisor).toBe(supervisor)
    expect(h.procs.daemon?.executable).toBe(NEW_EXE)
    expect(h.timeline).toContain(`signal:${oldPid}:SIGTERM`)
    expect(h.timeline.some((event) => event.startsWith('spawn:'))).toBe(false)
    expect(h.tabWrites).toEqual([])
    expect(h.files.get(SCRIPT)!.text).toBe(bootScript(NEW_EXE))
    expectUnprivileged(h)
  })

  it('stops a leftover daemon and starts a supervisor when the old one gave up', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    h.procs.supervisor = null
    const leftover = h.procs.daemon!.pid
    expectOk(await h.manager.install())
    expect(h.timeline.indexOf(`signal:${leftover}:SIGTERM`)).toBeLessThan(h.timeline.indexOf(`spawn:/bin/sh ${SCRIPT}`))
    expect(h.procs.supervisor).not.toBeNull()
    expect(h.procs.daemon?.executable).toBe(NEW_EXE)
  })

  it('keeps the script and its line when the install fails after the previous daemon handed over, and asks for a retry', async () => {
    const h = harness({ ready: [false], handover: async () => true })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toMatch(/retry install/i)
    expect(h.files.has(SCRIPT)).toBe(true)
    expect(h.crontab()).toContain(LINE)
    expect(h.timeline.some((event) => event.startsWith('remove:'))).toBe(false)
  })

  it('rolls a failed first install all the way back', async () => {
    const h = harness({ ready: [false] })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('removed the boot script and the @reboot line this install wrote, so no service is registered')
    expect(h.crontab()).toBe(USER_TAB)
    expect(h.files.has(SCRIPT)).toBe(false)
    expect(h.procs.daemon).toBeNull()
    expect(h.procs.supervisor).toBeNull()
    expect(h.procs.stop).toBe(false)
    expect(h.timeline.indexOf('stop:on')).toBeLessThan(h.timeline.indexOf(`remove:${SCRIPT}`))
    expectUnprivileged(h)
  })

  it('puts the previous script back and restarts the previous daemon when a re-install does not become ready', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true, ready: [false] })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('put the previous boot script back and the previous daemon is responding')
    expect(h.files.get(SCRIPT)!.text).toBe(bootScript(OLD_EXE))
    expect(h.procs.daemon?.executable).toBe(OLD_EXE)
    expect(h.readyCalls.at(-1)?.expected).toBe(OLD_EXE)
    expect(h.crontab()).toBe(`${USER_TAB}${LINE}\n`)
  })
})

describe('cron boot update', () => {
  const custom = '/opt/custom/bin:/bin'

  it('rewrites only the EXEC line, prepares the running daemon, and confirms the new executable', async () => {
    const h = harness({ installed: { executable: OLD_EXE, path: custom }, running: true })
    const previous = h.files.get(SCRIPT)!.text
    const supervisor = h.procs.supervisor
    const status = expectOk(await h.manager.update())

    expect(status.startup).toBe('boot')
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].text).toBe(previous.replace(`EXEC='${OLD_EXE}'`, `EXEC='${NEW_EXE}'`))
    expect(h.writes[0].text).toContain(`export PATH='${custom}'`)
    expect(h.timeline).toContain('prepareUpdate')
    expect(h.timeline.indexOf(`write:${SCRIPT}`)).toBeLessThan(h.timeline.indexOf('prepareUpdate'))
    expect(h.readyCalls.at(-1)?.expected).toBe(NEW_EXE)
    expect(h.procs.daemon?.executable).toBe(NEW_EXE)
    expect(h.procs.supervisor).toBe(supervisor)
    expect(h.timeline.some((event) => event.startsWith('spawn:'))).toBe(false)
    expect(h.tabWrites).toEqual([])
    expectUnprivileged(h)
  })

  it('an overdue update the busy daemon would not prepare for restarts it through its supervisor onto the new executable', async () => {
    // daemon-over-busy.ts step 3: the daemon's own shutdown (SIGTERM) does the preparing.
    const h = harness({ installed: { executable: OLD_EXE }, running: true, prepareUpdate: async () => 'unprepared' })
    const old = h.procs.daemon!.pid
    const supervisor = h.procs.supervisor
    const status = expectOk(await h.manager.update())

    expect(status.active).toBe(true)
    expect(h.timeline).toContain(`signal:${old}:SIGTERM`)
    expect(h.procs.daemon!.pid).not.toBe(old)
    expect(h.procs.daemon!.executable).toBe(NEW_EXE)
    expect(h.procs.supervisor).toBe(supervisor)
    expect(h.readyCalls.at(-1)?.expected).toBe(NEW_EXE)
    expect(h.timeline).not.toContain(`signal:${old}:SIGKILL`)
    expectUnprivileged(h)
  })

  it('an overdue update whose old daemon never finishes its shutdown kills that pid alone, and the supervisor starts the new one', async () => {
    // An older daemon whose session command never settles: SIGTERM leaves it half shut.
    const h = harness({ installed: { executable: OLD_EXE }, running: true, daemonStuck: true, prepareUpdate: async () => 'unprepared' })
    const old = h.procs.daemon!.pid
    const supervisor = h.procs.supervisor!
    const status = expectOk(await h.manager.update())

    expect(status.active).toBe(true)
    expect(h.timeline.indexOf(`signal:${old}:SIGTERM`)).toBeLessThan(h.timeline.indexOf(`signal:${old}:SIGKILL`))
    expect(h.timeline).not.toContain(`signal:${supervisor}:SIGKILL`)
    expect(h.procs.daemon!.executable).toBe(NEW_EXE)
    expect(h.procs.supervisor).toBe(supervisor)
    expectUnprivileged(h)
  })

  it('refuses when nothing is installed', async () => {
    const h = harness()
    expect(expectFailure(await h.manager.update()).code).toBe('notInstalled')
    expectUntouched(h)
    expect(h.prepareCalls()).toBe(0)
  })

  it.each([
    ['the daemon is stopped', { installed: { executable: OLD_EXE }, running: false }],
    ['the @reboot line is gone', { installed: { executable: OLD_EXE }, running: true, crontab: USER_TAB }],
  ] as const)('refuses as inactive when %s', async (_name, options) => {
    const h = harness(options as HarnessOptions)
    expect(expectFailure(await h.manager.update()).code).toBe('serviceInactive')
    expectUntouched(h)
    expect(h.prepareCalls()).toBe(0)
  })

  it('starts a new supervisor when the one it relied on gave up during the rollback, and the previous daemon answers', async () => {
    // The new daemon never answers; the supervisor uses up its restarts on the rollback's stop.
    const h = harness({ installed: { executable: OLD_EXE }, running: true, ready: [false], supervisorGivesUpAt: 2 })
    const failure = expectFailure(await h.manager.update())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('put the previous boot script back and started its supervisor again; the previous daemon is responding')
    expect(h.files.get(SCRIPT)!.text).toBe(bootScript(OLD_EXE))
    expect(h.procs.supervisor).not.toBeNull()
    expect(h.procs.daemon?.executable).toBe(OLD_EXE)
    expect(h.timeline.filter((event) => event.startsWith('spawn:'))).toEqual([`spawn:/bin/sh ${SCRIPT}`])
  })

  // 2026-11-04 review: one hello counted, and a cron failure after the old daemon exited for the
  // new build did not say so (stopped), so the callers tried the same build again within the hour.
  it('a new daemon that answers and does not stay is rolled back as a build that did not start (stopped)', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    const manager = createCronDaemonServiceManager({ ...h.deps, stay: async () => 'the new daemon answered and then did not stay serving for 30 s (its process exited)' })
    const failure = expectFailure(await manager.update())
    expect(failure).toMatchObject({ code: 'verifyFailed', stopped: true, message: expect.stringContaining('did not stay serving') })
    expect(h.files.get(SCRIPT)!.text).toBe(bootScript(OLD_EXE))
    // Before the old daemon prepared and exited, a failure stops nothing.
    const refused = harness({ installed: { executable: OLD_EXE }, running: true, prepareUpdate: async () => { throw new DaemonServiceUpdateRefusedError('active ACP workers') } })
    expect(expectFailure(await refused.manager.update()).stopped).toBeUndefined()
  })

  it('refuses before anything changes when the new daemon fails its trial run', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    const proved: string[] = []
    const manager = createCronDaemonServiceManager({ ...h.deps, proveBoot: async (prepared) => { proved.push(prepared.executable); return 'it exited with 3 before it listened: boom' } })
    const failure = expectFailure(await manager.update())

    expect(failure.code).toBe('bootProof')
    expect(failure.message).toBe('the new daemon did not start in a trial run, so nothing was changed: it exited with 3 before it listened: boom')
    expect(proved).toEqual([NEW_EXE])
    expectUntouched(h)
    expect(h.timeline).not.toContain('prepareUpdate')
    expect(h.procs.daemon?.executable).toBe(OLD_EXE)
  })

  it('restores the previous script without restarting when the daemon refuses to prepare', async () => {
    const h = harness({
      installed: { executable: OLD_EXE, path: custom },
      running: true,
      prepareUpdate: async () => { throw new DaemonServiceUpdateRefusedError('active ACP workers') },
    })
    const previous = h.files.get(SCRIPT)!.text
    const daemon = { ...h.procs.daemon! }
    const failure = expectFailure(await h.manager.update())

    expect(failure.code).toBe('updateRefused')
    expect(failure.rollback).toBe('Restored the previous boot script without restarting the running daemon')
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1].text).toBe(previous)
    expect(h.files.get(SCRIPT)!.text).toBe(previous)
    expect(h.procs.daemon).toEqual(daemon)
    expect(h.timeline.filter((event) => /^(spawn|signal):/.test(event))).toEqual([])
  })
})

describe('cron boot uninstall', () => {
  it('removes the line and the script, stops daemon and supervisor, and keeps every other crontab line', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    const status = expectOk(await h.manager.uninstall())

    expect(status).toMatchObject({ installed: false, active: false, enabled: false, startup: 'unavailable' })
    expect(status.detail).toBe('the daemon data and any running CLI sessions were left alone')
    expect(h.crontab()).toBe(USER_TAB)
    expect(h.files.has(SCRIPT)).toBe(false)
    expect(h.procs.daemon).toBeNull()
    expect(h.procs.supervisor).toBeNull()
    expect(h.procs.stop).toBe(false)
    expect(h.timeline.indexOf('stop:on')).toBeLessThan(h.timeline.findIndex((event) => event.startsWith('signal:')))
    expectUnprivileged(h)
  })

  it('keeps the script when the daemon does not stop', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true, daemonStuck: true })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toContain('did not exit')
    expect(failure.message).toContain(`${SCRIPT} was left in place`)
    expect(h.files.has(SCRIPT)).toBe(true)
    expect(h.timeline).not.toContain(`remove:${SCRIPT}`)
  })

  // Bug: with another install root's tagged line beside ours, cronLineState says 'foreign' and uninstall skips the crontab write.
  it('takes our line out even when another install root has a tagged line too', async () => {
    const other = daemonCronLine('/opt/other/daemon-boot.sh')
    const h = harness({ installed: { executable: OLD_EXE }, running: true, crontab: `${USER_TAB}${other}\n${LINE}\n` })
    expectOk(await h.manager.uninstall())
    expect(h.files.has(SCRIPT)).toBe(false)
    expect(h.crontab()).toBe(`${USER_TAB}${other}\n`)
  })

  it('answers ok with nothing to remove', async () => {
    const h = harness()
    const status = expectOk(await h.manager.uninstall())
    expect(status.detail).toBe('no service config to remove')
    expectUntouched(h)
  })

  it('leaves a script it did not write in place', async () => {
    const h = harness({ files: { [SCRIPT]: { text: '#!/bin/sh\n', owned: false } } })
    expect(expectFailure(await h.manager.uninstall()).code).toBe('foreignConfig')
    expect(h.files.has(SCRIPT)).toBe(true)
    expectUntouched(h)
  })
})

describe('cron boot restart and status', () => {
  it('restarts the daemon through its supervisor on the same executable', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    const before = h.procs.daemon!.pid
    const status = expectOk(await h.manager.restart())

    expect(status.active).toBe(true)
    expect(h.procs.daemon!.pid).not.toBe(before)
    expect(h.procs.daemon!.executable).toBe(OLD_EXE)
    expect(h.readyCalls[0].expected).toBeUndefined()
    expect(h.writes).toEqual([])
    expectUnprivileged(h)
  })

  it('refuses a restart with nothing installed', async () => {
    const h = harness()
    expect(expectFailure(await h.manager.restart()).code).toBe('notInstalled')
    expectUntouched(h)
  })

  it('reports a healthy install as starting at boot', async () => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true })
    const status = await h.manager.status()
    expect(status).toMatchObject({ scope: 'cron', configPath: SCRIPT, installed: true, enabled: true, active: true, startup: 'boot' })
    expect(status.detail).toContain('cron.service is enabled at boot')
  })

  it.each([
    ['a stale line', { crontab: `${USER_TAB}@reboot sh ${SCRIPT} # open-walnut-daemon\n` }, /not the one this build writes/],
    ['a missing line', { crontab: USER_TAB }, /@reboot line is not in this account's crontab/],
    ['no cron daemon', { cron: 'missing' }, /in place, but no cron daemon is enabled at boot or running here/],
    ['an unreadable crontab', { crontabDenied: true }, /could not read this account's crontab/],
  ] as const)('reports %s as on-demand with a detail', async (_name, options, detail) => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true, ...(options as HarnessOptions) })
    const status = await h.manager.status()
    expect(status.installed).toBe(true)
    expect(status.startup).toBe('on-demand')
    expect(status.detail).toMatch(detail)
    expectUntouched(h)
  })

  it('reports nothing installed as unavailable', async () => {
    const status = await harness().manager.status()
    expect(status).toMatchObject({ installed: false, active: false, startup: 'unavailable' })
  })
})

describe('cron boot refusals by account and platform', () => {
  it.each([
    ['macOS', { platform: 'darwin' }, 'unsupportedScope'],
    ['uid 0', { uid: 0 }, 'missingUser'],
    ['the root user', { user: 'root' }, 'missingUser'],
  ] as const)('refuses every change on %s', async (_name, options, code) => {
    const h = harness({ installed: { executable: OLD_EXE }, running: true, ...(options as HarnessOptions) })
    for (const action of [h.manager.install, h.manager.update, h.manager.uninstall, h.manager.restart]) {
      expect(expectFailure(await action()).code).toBe(code)
    }
    expectUntouched(h)
    expect(h.commands).toEqual([])
  })
})

describe('reading the host\'s cron', () => {
  it('reads every crontab -l wording for an account with no crontab yet as empty, and a refusal as a refusal', () => {
    expect(isNoCrontab('no crontab for walnut\n')).toBe(true)
    expect(isNoCrontab("crontab: can't open 'walnut': No such file or directory\n")).toBe(true)
    expect(isNoCrontab('You (walnut) are not allowed to use this program (crontab)\n')).toBe(false)
    expect(isNoCrontab("crontab: can't open 'walnut': Permission denied\n")).toBe(false)
  })

  it('counts a cron unit as started at boot only when it is enabled, not static or indirect', () => {
    const enabledCase = /case "\$s" in ([^)]*)\)/.exec(CRON_BOOT_PROBE_SCRIPT)?.[1].split('|')
    expect(enabledCase).toEqual(['enabled', 'enabled-runtime', 'alias', 'generated'])
  })
})
