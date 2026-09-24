import { describe, it, expect } from 'vitest'
import {
  createDaemonServiceManager,
  daemonServiceConfigPath,
  DaemonServiceHandoverPendingError,
  DaemonServiceUpdateRefusedError,
  type DaemonServiceDeps,
  type DaemonServiceFailure,
  type DaemonServiceResult,
  type DaemonServiceStatus,
} from '../../src/providers/daemon-service-manager.js'

type Platform = 'linux' | 'darwin'
type Reply = { code?: number; stdout?: string; stderr?: string }

const UNIT = 'open-walnut-daemon.service'
const LABEL = 'dev.openwalnut.session-daemon'
const UNIT_USER = '/home/walnut/.config/systemd/user/open-walnut-daemon.service'
const UNIT_SYSTEM = '/etc/systemd/system/open-walnut-daemon.service'
const PLIST = '/Users/example/Library/LaunchAgents/dev.openwalnut.session-daemon.plist'
const TARGET = 'gui/501/dev.openwalnut.session-daemon'
const LINUX_EXE = '/home/walnut/.local/share/open-walnut/daemon/open-walnut-daemon'
const DARWIN_EXE = '/Users/example/Library/Application Support/Open Walnut/Daemon/open-walnut-daemon'
const RUNTIME_DIR = '/tmp/open-walnut'

const SHOW_ENV = 'systemctl --user show-environment'
const LINGER = 'loginctl show-user walnut -p Linger --value'
const IS_ACTIVE = `systemctl --user is-active ${UNIT}`
const IS_ENABLED = `systemctl --user is-enabled ${UNIT}`
const IS_ACTIVE_SYS = `systemctl is-active ${UNIT}`
const IS_ENABLED_SYS = `systemctl is-enabled ${UNIT}`
const ENABLE = `systemctl --user enable --now ${UNIT}`
const ENABLE_SYS = `systemctl enable --now ${UNIT}`
const DISABLE = `systemctl --user disable --now ${UNIT}`
const DISABLE_ONLY = `systemctl --user disable ${UNIT}`
const STOP = `systemctl --user stop ${UNIT}`
const RESTART = `systemctl --user restart ${UNIT}`
const RESTART_SYS = `systemctl restart ${UNIT}`
const RELOAD = 'systemctl --user daemon-reload'
const RELOAD_SYS = 'systemctl daemon-reload'
const SHOW = `systemctl --user show ${UNIT} -p FragmentPath -p DropInPaths`
const SHOW_SYS = `systemctl show ${UNIT} -p FragmentPath -p DropInPaths`
const PRINT = `launchctl print ${TARGET}`
const PRINT_DISABLED = 'launchctl print-disabled gui/501'
const BOOTOUT = `launchctl bootout ${TARGET}`
const BOOTSTRAP = `launchctl bootstrap gui/501 ${PLIST}`

// launchd reports the path of the plist it loaded; systemd reports FragmentPath + DropInPaths.
const RUNNING = `state = running\n\tpid = 4242\n\tpath = ${PLIST}\n`
const unitShown = (fragment: string, dropIns = ''): Reply =>
  ({ stdout: `FragmentPath=${fragment}\nDropInPaths=${dropIns}\n` })
const PREVIOUS = '[Unit]\nDescription=Open Walnut session daemon (the version already installed)\n'
const overrideList = (entries: string[]): string =>
  ['disabled services = {', ...entries.map((entry) => `\t${entry}`), '}', ''].join('\n')
const OVERRIDE_ALLOWED = overrideList([
  '"com.apple.mediaanalysisd" => enabled',
  `"${LABEL}" => enabled`,
])
const OVERRIDE_DISABLED = overrideList([
  '"com.apple.mediaanalysisd" => enabled',
  `"${LABEL}" => disabled`,
])
const OVERRIDE_ABSENT = overrideList(['"com.apple.mediaanalysisd" => enabled'])
const GONE: Reply = { code: 113, stderr: 'Could not find service' }
const STOPS: Reply[] = [{ stdout: 'active\n' }, { code: 3, stdout: 'inactive\n' }]
const DISABLES: Reply[] = [{ stdout: 'enabled\n' }, { code: 1, stdout: 'disabled\n' }]
const UNLOADS: Reply[] = [{ stdout: RUNNING }, GONE]

interface HarnessOptions {
  platform?: Platform
  user?: string
  uid?: number
  present?: boolean
  owned?: boolean
  /** Does the init system already have a job for us? Defaults to `present`. */
  started?: boolean
  active?: boolean
  enabled?: boolean
  stickyConfig?: boolean
  replies?: Record<string, Reply | Reply[]>
  prepared?: { executable: string; args: string[] }
  ready?: boolean | boolean[]
  previousText?: string | null
  initialText?: string
  readThrows?: string
  readyThrows?: string
  writeThrowsAfter?: number
  writeLandsThenThrows?: boolean
  removeThrows?: string
  handover?: () => Promise<boolean>
  prepareUpdate?: () => Promise<void>
  startLimitOnRestart?: boolean
}

function harness(options: HarnessOptions = {}) {
  const platform: Platform = options.platform ?? 'linux'
  const timeline: string[] = []
  const writes: { path: string; text: string }[] = []
  const removed: string[] = []
  const onDisk = new Set<string>()
  const contents = new Map<string, string>()
  const readyCalls: { status: DaemonServiceStatus; expected?: string }[] = []
  const readyQueue = Array.isArray(options.ready) ? [...options.ready] : [options.ready ?? true]
  let prepareCalls = 0
  let writeCalls = 0
  let restarted = false
  let startLimited = false

  if (options.present) {
    for (const p of [UNIT_USER, UNIT_SYSTEM, PLIST]) {
      onDisk.add(p)
      contents.set(p, options.initialText ?? PREVIOUS)
    }
  }

  const table: Record<string, Reply[]> = {}
  const defaults: Record<string, Reply | Reply[]> = {
    [LINGER]: { stdout: 'yes\n' },
    [PRINT_DISABLED]: { stdout: OVERRIDE_ALLOWED },
  }
  for (const [line, reply] of Object.entries({ ...defaults, ...options.replies })) {
    table[line] = Array.isArray(reply) ? [...reply] : [reply]
  }

  // Without an explicit reply, the init system's answer follows the on-disk config and registration state, not a blanket "already running";
  // otherwise a first install would start from "already installed" and a broken install would go unnoticed.
  let started = options.started ?? !!options.present
  let active = options.active ?? started
  let enabled = options.enabled ?? started
  const ACTIVE: Reply = { stdout: 'active\n' }
  const INACTIVE: Reply = { code: 3, stdout: 'inactive\n' }
  const ENABLED: Reply = { stdout: 'enabled\n' }
  const DISABLED: Reply = { code: 1, stdout: 'disabled\n' }
  const derived: Record<string, () => Reply> = {
    [IS_ACTIVE]: () => (active ? ACTIVE : INACTIVE),
    [IS_ACTIVE_SYS]: () => (active ? ACTIVE : INACTIVE),
    [IS_ENABLED]: () => (enabled ? ENABLED : DISABLED),
    [IS_ENABLED_SYS]: () => (enabled ? ENABLED : DISABLED),
    [SHOW]: () => unitShown(onDisk.has(UNIT_USER) ? UNIT_USER : ''),
    [SHOW_SYS]: () => unitShown(onDisk.has(UNIT_SYSTEM) ? UNIT_SYSTEM : ''),
    [PRINT]: () => (started ? { stdout: active ? RUNNING : `state = not running\npath = ${PLIST}\n` } : GONE),
  }

  const deps: DaemonServiceDeps = {
    platform,
    home: platform === 'darwin' ? '/Users/example' : '/home/walnut',
    uid: options.uid ?? 501,
    user: options.user ?? 'walnut',
    path: '/usr/local/bin:/usr/bin:/bin',
    stateDir: platform === 'darwin'
      ? '/Users/example/Library/Application Support/Open Walnut/Daemon'
      : '/home/walnut/.local/share/open-walnut/daemon',
    runtimeDir: RUNTIME_DIR,
    prepareUpdate: async () => {
      timeline.push('prepareUpdate')
      await options.prepareUpdate?.()
    },
    async run(program, args) {
      const line = [program, ...args].join(' ')
      timeline.push(`run:${line}`)
      const action = args[0] === '--user' ? args[1] : args[0]
      if (options.startLimitOnRestart && program === 'systemctl') {
        if (action === 'reset-failed' && args.at(-1) === UNIT) startLimited = false
        if (action === 'restart') {
          if (!restarted) { restarted = true; startLimited = true; active = false }
          if (startLimited) return { code: 1, stdout: '', stderr: 'Start request repeated too quickly' }
        }
      }
      const queue = table[line]
      const reply: Reply = queue
        ? (queue.length > 1 ? queue.shift()! : queue[0])
        : (derived[line]?.() ?? {})
      const code = reply.code ?? 0
      if (code === 0) {
        if (program === 'launchctl') {
          if (args[0] === 'bootstrap' || args[0] === 'kickstart') { started = true; active = true }
          if (args[0] === 'bootout') { started = false; active = false }
        } else if (program === 'systemctl') {
          const action = args[0] === '--user' ? args[1] : args[0]
          if (action === 'enable') enabled = true
          if (action === 'disable') enabled = false
          if (action === 'restart' || (action === 'enable' && args.includes('--now'))) active = true
          if (action === 'stop' || (action === 'disable' && args.includes('--now'))) active = false
        }
      }
      return { code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
    },
    async writeConfig(configPath, text) {
      timeline.push(`write:${configPath}`)
      writeCalls += 1
      if (options.writeThrowsAfter !== undefined && writeCalls > options.writeThrowsAfter) {
        throw new Error('No space left on device')
      }
      writes.push({ path: configPath, text })
      contents.set(configPath, text)
      onDisk.add(configPath)
      if (options.writeLandsThenThrows && writeCalls === 1) throw new Error('Ownership sync failed after config rename')
    },
    async removeConfig(configPath) {
      timeline.push(`remove:${configPath}`)
      if (options.removeThrows) throw new Error(options.removeThrows)
      removed.push(configPath)
      if (!options.stickyConfig) {
        onDisk.delete(configPath)
        contents.delete(configPath)
      }
    },
    async readConfig(configPath) {
      timeline.push(`read:${configPath}`)
      if (options.readThrows) throw new Error(options.readThrows)
      if (options.previousText !== undefined) return options.previousText
      return contents.get(configPath) ?? null
    },
    async ready(status, expectedExecutable) {
      timeline.push('ready')
      readyCalls.push({ status, ...(expectedExecutable ? { expected: expectedExecutable } : {}) })
      if (options.readyThrows) throw new Error(options.readyThrows)
      return readyQueue.length > 1 ? readyQueue.shift()! : readyQueue[0]
    },
    async prepareExecutable() {
      timeline.push('prepare')
      prepareCalls += 1
      return options.prepared ?? {
        executable: platform === 'darwin' ? DARWIN_EXE : LINUX_EXE,
        args: ['--service'],
      }
    },
    async inspectConfig(configPath) {
      timeline.push(`inspect:${configPath}`)
      return {
        present: options.present === false ? false : onDisk.has(configPath),
        owned: options.owned ?? true,
      }
    },
  }

  if (options.handover) deps.handover = async () => {
    timeline.push('handover')
    return options.handover!()
  }

  return {
    manager: createDaemonServiceManager(deps),
    timeline,
    writes,
    removed,
    readyCalls,
    prepareCalls: () => prepareCalls,
  }
}

function expectOk(result: DaemonServiceResult): DaemonServiceStatus {
  if (!result.ok) throw new Error(`expected ok, got ${result.failure.code}: ${result.failure.message}`)
  return result.status
}

function expectFailure(result: DaemonServiceResult): DaemonServiceFailure {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.status)}`)
  return result.failure
}

const FORBIDDEN = /enable-linger|sudo|nohup|pkill|\bkill\b|\brm\b|systemd-run|setsid/
const MUTATING = /(^| )(enable|disable|restart|bootstrap|bootout|kickstart)( |$)|--now|^write:|^remove:/

describe('daemonServiceConfigPath', () => {
  it('writes the unit and the agent where the init system looks for them', () => {
    expect(daemonServiceConfigPath('linux', '/home/walnut', 'user')).toBe(UNIT_USER)
    expect(daemonServiceConfigPath('linux', '/home/walnut', 'system')).toBe(UNIT_SYSTEM)
    expect(daemonServiceConfigPath('darwin', '/Users/example', 'user')).toBe(PLIST)
    expect(daemonServiceConfigPath('darwin', '/Users/example', 'system')).toBe(PLIST)
  })

  it('is what the manager reports, defaulting to user scope', () => {
    const h = harness()
    expect(h.manager.configPath()).toBe(UNIT_USER)
    expect(h.manager.configPath('system')).toBe(UNIT_SYSTEM)
  })
})

describe.each(['linux', 'darwin'] as const)('service handover transaction on %s', (platform) => {
  it('writes the startup guard before handover and starts the service only after handover finishes', async () => {
    let finish!: (value: boolean) => void
    const h = harness({ platform, handover: () => new Promise((resolve) => { finish = resolve }) })
    const pending = h.manager.install()
    while (!finish) await Promise.resolve()
    const config = platform === 'linux' ? UNIT_USER : PLIST
    const start = platform === 'linux' ? ENABLE : BOOTSTRAP
    expect(h.timeline.indexOf(`write:${config}`)).toBeLessThan(h.timeline.indexOf('handover'))
    expect(h.timeline).not.toContain(`run:${start}`)
    finish(true)
    expectOk(await pending)
    expect(h.timeline.indexOf('handover')).toBeLessThan(h.timeline.indexOf(`run:${start}`))
  })

  it.each(['pending', 'start', 'ready'] as const)('keeps the config and permits retry after a %s failure', async (fault) => {
    let attempts = 0
    const start = platform === 'linux' ? ENABLE : BOOTSTRAP
    const config = platform === 'linux' ? UNIT_USER : PLIST
    const h = harness({
      platform,
      handover: async () => {
        if (++attempts === 1 && fault === 'pending') throw new DaemonServiceHandoverPendingError('reply lost')
        return true
      },
      replies: fault === 'start' ? { [start]: [{ code: 1, stderr: 'start failed' }, { code: 0 }] } : {},
      ready: fault === 'ready' ? [false, true] : true,
    })
    const failed = expectFailure(await h.manager.install())
    expect(failed.rollback).toContain('Kept the service config')
    expect(h.removed).toEqual([])
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].path).toBe(config)
    expectOk(await h.manager.install())
    expect(h.removed).toEqual([])
  })

  it('rolls back an explicit refusal before ownership was transferred', async () => {
    const h = harness({ platform, handover: async () => { throw new Error('active operations') } })
    const failure = expectFailure(await h.manager.install())
    expect(failure.code).toBe('hostError')
    expect(h.removed).toEqual([platform === 'linux' ? UNIT_USER : PLIST])
    expect(h.timeline).not.toContain(`run:${platform === 'linux' ? ENABLE : BOOTSTRAP}`)
  })
})

describe.each(['linux', 'darwin'] as const)('managed executable update on %s', (platform) => {
  const previous = platform === 'linux'
    ? '[Service]\nExecStart="/opt/previous/daemon" "--service"\nEnvironment="PATH=/opt/custom/bin:/bin"\n'
    : '<plist><dict><key>ProgramArguments</key><array><string>/opt/previous/daemon</string><string>--service</string></array><key>CustomValue</key><string>unchanged</string></dict></plist>\n'

  it('preserves configuration and never enables a service or calls unmanaged handover', async () => {
    const h = harness({ platform, present: true, initialText: previous, handover: async () => { throw new Error('unexpected handover') } })
    expectOk(await h.manager.update())
    expect(h.timeline).not.toContain('handover')
    expect(h.timeline).not.toContain(`run:${ENABLE}`)
    expect(h.writes).toHaveLength(1)
    const executable = platform === 'linux' ? LINUX_EXE : DARWIN_EXE
    expect(h.writes[0].text).toBe(previous.replace('/opt/previous/daemon', executable))
    expect(h.readyCalls[0].expected).toBe(executable)
  })

  it.each([
    { present: false }, { present: true, owned: false },
    { present: true, active: false }, { present: true, enabled: false },
  ])('does not install, enable, or start a non-updatable service: %j', async (options) => {
    const h = harness({ platform, ...options,
      ...(platform === 'darwin' && options.enabled === false ? { replies: { [PRINT_DISABLED]: { stdout: OVERRIDE_DISABLED } } } : {}),
    })
    expectFailure(await h.manager.update())
    expect(h.writes).toEqual([])
    expect(h.prepareCalls()).toBe(0)
    expect(h.timeline.filter((event) => MUTATING.test(event))).toEqual([])
  })

  it('refuses a service stopped while staging the artifact', async () => {
    const replies = platform === 'linux'
      ? { [IS_ACTIVE]: [{ stdout: 'active' }, { code: 3, stdout: 'inactive' }] }
      : { [PRINT]: [{ stdout: RUNNING }, { stdout: `state = stopped\npath = ${PLIST}\n` }] }
    const h = harness({ platform, present: true, initialText: previous, replies })
    expect(expectFailure(await h.manager.update()).code).toBe('serviceInactive')
    expect(h.writes).toEqual([])
    expect(h.timeline.filter((event) => MUTATING.test(event))).toEqual([])
  })

  it('restores config without restarting when the running daemon refuses preparation', async () => {
    const h = harness({ platform, present: true, initialText: previous,
      prepareUpdate: async () => { throw new DaemonServiceUpdateRefusedError('active ACP workers') } })
    expect(expectFailure(await h.manager.update()).code).toBe('updateRefused')
    expect(h.writes[1].text).toBe(previous)
    expect(h.timeline.filter((event) => event.startsWith('run:') && MUTATING.test(event))).toEqual([])
  })

  it('keeps the staged config after an ambiguous update result instead of interrupting draining', async () => {
    const h = harness({ platform, present: true, initialText: previous,
      prepareUpdate: async () => { throw new DaemonServiceHandoverPendingError('RPC response lost') } })
    expect(expectFailure(await h.manager.update()).code).toBe('handoverPending')
    expect(h.writes).toHaveLength(1)
    expect(h.timeline.filter((event) => event.startsWith('run:') && MUTATING.test(event))).toEqual([])
  })

  it('restores the previous configuration when the new daemon does not become ready', async () => {
    const h = harness({ platform, present: true, initialText: previous, ready: [false, true] })
    expect(expectFailure(await h.manager.update()).code).toBe('notReady')
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1].text).toBe(previous)
    expect(h.removed).toEqual([])
    expect(h.timeline).not.toContain(`run:${ENABLE}`)
  })
})

describe('Linux rollback after repeated startup failures', () => {
  it.each(['user', 'system'] as const)('clears only the target service limit before restoring the previous executable (%s)', async (scope) => {
    const previous = '[Service]\nExecStart="/opt/previous/daemon" "--service"\n'
    const h = harness({ present: true, initialText: previous, startLimitOnRestart: true })
    const failure = expectFailure(await h.manager.update({ scope }))
    expect(failure.code).toBe('commandFailed')
    expect(failure.rollback).toContain('previous executable is responding')
    expect(h.writes.at(-1)?.text).toBe(previous)
    expect(h.readyCalls.at(-1)?.expected).toBe('/opt/previous/daemon')
    const prefix = scope === 'user' ? 'systemctl --user' : 'systemctl'
    const reset = h.timeline.indexOf(`run:${prefix} reset-failed ${UNIT}`)
    expect(reset).toBeGreaterThan(h.timeline.lastIndexOf(`run:${prefix} daemon-reload`))
    expect(reset).toBeLessThan(h.timeline.lastIndexOf(`run:${prefix} restart ${UNIT}`))
  })
})

describe('install on linux, user scope', () => {
  it('probes read-only, writes once, enables, then verifies in that order', async () => {
    const h = harness()
    const status = expectOk(await h.manager.install())

    expect(h.timeline).toEqual([
      `run:${SHOW_ENV}`,
      `run:${LINGER}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      'prepare',
      `write:${UNIT_USER}`,
      `run:${RELOAD}`,
      `run:${ENABLE}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      'ready',
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
    ])
    expect(h.writes.map((write) => write.path)).toEqual([UNIT_USER])
    expect(h.prepareCalls()).toBe(1)
    expect(status).toMatchObject({
      platform: 'linux',
      scope: 'user',
      configPath: UNIT_USER,
      installed: true,
      foreign: false,
      active: true,
      enabled: true,
      startup: 'boot',
    })
  })

  it('does not restart anything on a first install', async () => {
    const h = harness()
    expectOk(await h.manager.install())
    expect(h.timeline.filter((entry) => entry === `run:${RESTART}`)).toEqual([])
  })

  it('restarts its own already-running unit so the new ExecStart takes over', async () => {
    const h = harness({ present: true })
    const status = expectOk(await h.manager.install())

    expect(h.timeline).toEqual([
      `run:${SHOW_ENV}`,
      `run:${LINGER}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      'prepare',
      `read:${UNIT_USER}`,
      `write:${UNIT_USER}`,
      `run:${RELOAD}`,
      `run:${ENABLE}`,
      `run:${RESTART}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      'ready',
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
    ])
    expect(h.timeline.indexOf(`run:${RESTART}`)).toBeGreaterThan(h.timeline.indexOf(`write:${UNIT_USER}`))
    // Verify only after ExecStart changed; the read-only probe before the install does not count.
    expect(h.timeline.indexOf(`run:${RESTART}`)).toBeLessThan(h.timeline.lastIndexOf(`run:${IS_ACTIVE}`))
    expect(status).toMatchObject({ installed: true, active: true, enabled: true })
  })

  it('does not report success when the restart of its own unit fails', async () => {
    const h = harness({ present: true, replies: { [RESTART]: { code: 1, stderr: 'Job failed' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('commandFailed')
    expect(failure.command).toBe(RESTART)
    expect(failure.stderr).toBe('Job failed')
    // The restart during rollback also failed, so the old version did not come up, and the report must say so.
    expect(failure.rollback).toBe(`put the previous config back, but ${RESTART} exited with 1`)
    expect(h.writes.map((write) => write.text)).toEqual([h.writes[0].text, PREVIOUS])
    // After the read-only probe before the install, there must be no further "verify succeeded" probe.
    const afterWrite = h.timeline.slice(h.timeline.indexOf(`write:${UNIT_USER}`))
    expect(afterWrite.some((entry) => entry.includes('is-active'))).toBe(false)
  })

  it('renders the unit from the prepared argv and the separate runtime dir', async () => {
    const h = harness()
    expectOk(await h.manager.install())
    const unit = h.writes[0].text

    expect(unit).toContain(`ExecStart="${LINUX_EXE}" "--service"`)
    expect(unit).toContain('WorkingDirectory=/home/walnut')
    expect(unit).toContain(`Environment="WALNUT_DAEMON_DIR=${RUNTIME_DIR}"`)
    expect(unit).toContain('Environment="WALNUT_DAEMON_STATE_DIR=/home/walnut/.local/share/open-walnut/daemon"')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toContain('User=')
  })

  it('keeps every systemctl call in the user manager', async () => {
    const h = harness()
    expectOk(await h.manager.install())
    const systemctl = h.timeline.filter((entry) => entry.startsWith('run:systemctl'))
    expect(systemctl.length).toBeGreaterThan(0)
    expect(systemctl.every((entry) => entry.includes('--user'))).toBe(true)
  })

  it('refuses with requiresLinger and writes nothing when linger is off', async () => {
    const h = harness({ replies: { [LINGER]: { stdout: 'no\n' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('requiresLinger')
    expect(failure.message).toContain('loginctl enable-linger walnut')
    expect(h.timeline).toEqual([`run:${SHOW_ENV}`, `run:${LINGER}`])
    expect(h.writes).toEqual([])
    expect(h.removed).toEqual([])
    expect(h.prepareCalls()).toBe(0)
  })

  it('never enables linger itself and never reaches for sudo', async () => {
    const h = harness({ replies: { [LINGER]: { stdout: 'no\n' } } })
    await h.manager.install()
    expect(h.timeline.some((entry) => FORBIDDEN.test(entry))).toBe(false)
  })

  it('stops at the first probe when no user manager answers', async () => {
    const h = harness({ replies: { [SHOW_ENV]: { code: 1, stderr: 'Failed to connect to bus' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('userManagerUnavailable')
    expect(failure.stderr).toBe('Failed to connect to bus')
    expect(h.timeline).toEqual([`run:${SHOW_ENV}`])
    expect(h.writes).toEqual([])
  })

  it('will not overwrite a config it does not own', async () => {
    const h = harness({ present: true, owned: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('foreignConfig')
    expect(failure.message).toContain(UNIT_USER)
    expect(h.timeline).toEqual([`run:${SHOW_ENV}`, `run:${LINGER}`, `inspect:${UNIT_USER}`])
    expect(h.writes).toEqual([])
    expect(h.prepareCalls()).toBe(0)
  })

  it('refuses an argv that would not run the daemon in the foreground', async () => {
    const h = harness({ prepared: { executable: LINUX_EXE, args: [] } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('invalidArgv')
    expect(failure.message).toContain('--service')
    expect(h.writes).toEqual([])
    expect(h.timeline[h.timeline.length - 1]).toBe('prepare')
  })

  it('turns a rejected config into a failure instead of writing it', async () => {
    const h = harness({ prepared: { executable: 'daemon/open-walnut-daemon', args: ['--service'] } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('invalidConfig')
    expect(failure.message).toMatch(/absolute path/)
    expect(h.writes).toEqual([])
  })

  it('reports commandFailed and stops when enable fails', async () => {
    const h = harness({ replies: { [ENABLE]: { code: 1, stderr: 'Unit not found.' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('commandFailed')
    expect(failure.command).toBe(ENABLE)
    expect(failure.stderr).toBe('Unit not found.')
    expect(failure.rollback).toBe('removed the config this install wrote, so no service is registered')
    expect(h.writes).toHaveLength(1)
    expect(h.removed).toEqual([UNIT_USER])
    // There is no "installed" verification; every probe after enable belongs to the stop check during the undo.
    expect(h.timeline.some((entry) => entry === 'ready')).toBe(false)
    const firstProbeAfterWrite = h.timeline.indexOf(`run:${IS_ACTIVE}`, h.timeline.indexOf(`write:${UNIT_USER}`))
    expect(firstProbeAfterWrite).toBeGreaterThan(h.timeline.indexOf(`run:${DISABLE}`))
  })

  it('does not claim installed when the service is not active', async () => {
    const h = harness({ replies: { [IS_ACTIVE]: { code: 3, stdout: 'inactive\n' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/not active/)
    expect(failure.rollback).toMatch(/removed the config this install wrote/)
    expect(h.removed).toEqual([UNIT_USER])
  })

  it('does not claim installed when the service is not enabled', async () => {
    const h = harness({ replies: { [IS_ENABLED]: { code: 1, stdout: 'disabled\n' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/did not come up enabled/)
  })

  it('does not accept static or enabled-runtime as proof of a boot start', async () => {
    for (const stdout of ['static\n', 'enabled-runtime\n', 'indirect\n', 'alias\n']) {
      const h = harness({ replies: { [IS_ENABLED]: { code: 0, stdout } } })
      const failure = expectFailure(await h.manager.install())

      expect(failure.code, stdout).toBe('verifyFailed')
      expect(failure.message, stdout).toMatch(/did not come up enabled/)
    }
  })

  it('does not claim installed when the config is not in place afterwards', async () => {
    const h = harness({ present: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toContain(UNIT_USER)
  })

  it('asks the daemon to answer as the executable it just staged', async () => {
    const h = harness()
    expectOk(await h.manager.install())

    expect(h.readyCalls).toHaveLength(1)
    expect(h.readyCalls[0].expected).toBe(LINUX_EXE)
    expect(h.readyCalls[0].status).toMatchObject({ installed: true, active: true, enabled: true })
  })

  it('does not call an update installed when only the old instance is still answering', async () => {
    const h = harness({ present: true, ready: [false, true] })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.message).toContain(LINUX_EXE)
    expect(failure.rollback).toBe('put the previous config back and a managed daemon is responding; the previous executable identity was not verified')
    expect(h.timeline.slice(h.timeline.indexOf('ready'))).toEqual([
      'ready',
      `write:${UNIT_USER}`,
      `run:${RELOAD}`,
      `run:systemctl --user reset-failed ${UNIT}`,
      `run:${RESTART}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      'ready',
    ])
    expect(h.writes.map((write) => write.text)).toEqual([h.writes[0].text, PREVIOUS])
    expect(h.removed).toEqual([])
    // Rollback starts the old version from the config and there is no new artifact to require, so no expected path is passed.
    expect(h.readyCalls.map((call) => call.expected)).toEqual([LINUX_EXE, undefined])
  })

  it('leaves the host without a service when a first install never answers', async () => {
    const h = harness({ ready: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('removed the config this install wrote, so no service is registered')
    // After stopping, probe once to confirm it is neither running nor registered before deleting the config; probe again after the delete.
    expect(h.timeline.slice(h.timeline.indexOf('ready'))).toEqual([
      'ready',
      `run:${DISABLE}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      `remove:${UNIT_USER}`,
      `run:${RELOAD}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
    ])
    expect(h.writes).toHaveLength(1)
    expect(h.removed).toEqual([UNIT_USER])
  })

  it('says the disable did not take when systemd refuses it during the undo', async () => {
    const h = harness({ ready: false, replies: { [DISABLE]: { code: 1, stderr: 'Unit not loaded' } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe(`kept the service config because the stop was not confirmed: ${DISABLE} exited with 1`)
    expect(h.removed).toEqual([])
  })

  it('refuses to replace an existing config without a rollback baseline', async () => {
    const h = harness({ present: true, previousText: null, ready: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('hostError')
    expect(failure.rollback).toBeUndefined()
    expect(h.writes).toHaveLength(0)
    expect(h.removed).toEqual([])
  })

  it.each([false, true])('rolls back a config that landed before writeConfig threw (update=%s)', async (present) => {
    const h = harness({ ...(present ? { present: true } : {}), writeLandsThenThrows: true })
    const failure = expectFailure(await h.manager.install())
    expect(failure.code).toBe('hostError')
    expect(failure.message).toContain('after config rename')
    if (present) expect(h.writes.at(-1)?.text).toBe(PREVIOUS)
    else expect(h.removed).toEqual([UNIT_USER])
  })

  it('keeps the original failure when putting the previous config back fails too', async () => {
    const h = harness({ present: true, ready: false, writeThrowsAfter: 1 })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.message).toContain(LINUX_EXE)
    expect(failure.rollback).toBe(
      `could not put the previous config back at ${UNIT_USER}: No space left on device`,
    )
    expect(h.writes).toHaveLength(1)
  })

  it('does not claim the previous version is back when it never answers either', async () => {
    const h = harness({ present: true, ready: [false, false] })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toMatch(/^put the previous config back, but the previous version did not come back:/)
    expect(failure.rollback).toMatch(/never answered as ready/)
    expect(h.writes.map((write) => write.text)).toEqual([h.writes[0].text, PREVIOUS])
  })

  it('does not claim the previous version is back when its unit files never reloaded', async () => {
    const h = harness({ present: true, ready: false, replies: { [RELOAD]: [{}, { code: 1 }] } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.rollback).toBe(`put the previous config back, but ${RELOAD} exited with 1`)
    // If even the reload failed, it must not go on to restart, much less report a successful verification.
    expect(h.timeline.slice(h.timeline.indexOf('ready') + 1)).toEqual([`write:${UNIT_USER}`, `run:${RELOAD}`])
  })

  it('turns a thrown baseline read into a structured failure and writes nothing', async () => {
    const h = harness({ present: true, readThrows: 'EACCES: permission denied' })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('hostError')
    expect(failure.message).toBe('EACCES: permission denied')
    expect(failure.rollback).toBeUndefined()
    expect(h.writes).toEqual([])
    expect(h.removed).toEqual([])
  })

  it('turns a thrown readiness check into a structured failure and still rolls back', async () => {
    const h = harness({ readyThrows: 'daemon socket closed' })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('hostError')
    expect(failure.message).toBe('daemon socket closed')
    expect(failure.rollback).toBe('removed the config this install wrote, so no service is registered')
    expect(h.removed).toEqual([UNIT_USER])
  })

  it('keeps the original failure when the rollback itself throws', async () => {
    const h = harness({ present: true, readyThrows: 'daemon socket closed' })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('hostError')
    expect(failure.message).toBe('daemon socket closed')
    expect(failure.rollback).toBe('the rollback did not finish: daemon socket closed')
    expect(h.writes.map((write) => write.text)).toEqual([h.writes[0].text, PREVIOUS])
  })

  it('admits the config it wrote is still on disk when the removal fails', async () => {
    const h = harness({ ready: false, removeThrows: 'EROFS: read-only file system' })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe(
      `could not remove the config this install wrote at ${UNIT_USER}: EROFS: read-only file system`,
    )
    expect(h.removed).toEqual([])
  })

  it('never rolls back a refusal it made before writing anything', async () => {
    const cases: [string, ReturnType<typeof harness>][] = [
      ['requiresLinger', harness({ replies: { [LINGER]: { stdout: 'no\n' } } })],
      ['foreignConfig', harness({ present: true, owned: false })],
      ['invalidArgv', harness({ prepared: { executable: LINUX_EXE, args: [] } })],
      ['missingUser', harness({ user: '' })],
    ]
    for (const [code, h] of cases) {
      const failure = expectFailure(await h.manager.install(code === 'missingUser' ? { scope: 'system' } : {}))

      expect(failure.code, code).toBe(code)
      expect(failure.rollback, code).toBeUndefined()
      expect(h.writes, code).toEqual([])
      expect(h.removed, code).toEqual([])
      expect(h.timeline.some((entry) => entry.includes('disable')), code).toBe(false)
    }
  })
})

describe('install on linux, system scope', () => {
  it.each([{ uid: 0, user: 'root' }, { uid: 0, user: 'walnut' }, { uid: 501, user: 'root' }])('does not install or restart as root: %j', async (identity) => {
    const h = harness({ ...identity, present: true })
    expect(expectFailure(await h.manager.install({ scope: 'system' })).code).toBe('missingUser')
    expect(expectFailure(await h.manager.restart({ scope: 'system' })).code).toBe('missingUser')
    expect(h.timeline).toEqual([])
  })

  it('must be asked for explicitly and then runs in the system manager', async () => {
    const h = harness()
    const status = expectOk(await h.manager.install({ scope: 'system' }))

    expect(h.timeline).toEqual([
      `inspect:${UNIT_SYSTEM}`,
      `run:${IS_ACTIVE_SYS}`,
      `run:${IS_ENABLED_SYS}`,
      `run:${SHOW_SYS}`,
      'prepare',
      `write:${UNIT_SYSTEM}`,
      'run:systemctl daemon-reload',
      `run:systemctl enable --now ${UNIT}`,
      `inspect:${UNIT_SYSTEM}`,
      `run:${IS_ACTIVE_SYS}`,
      `run:${IS_ENABLED_SYS}`,
      `run:${SHOW_SYS}`,
      'ready',
      `inspect:${UNIT_SYSTEM}`,
      `run:${IS_ACTIVE_SYS}`,
      `run:${IS_ENABLED_SYS}`,
      `run:${SHOW_SYS}`,
    ])
    expect(status).toMatchObject({ scope: 'system', configPath: UNIT_SYSTEM, startup: 'boot' })
    expect(h.timeline.some((entry) => entry.includes('--user'))).toBe(false)
    expect(h.timeline.some((entry) => entry.includes('loginctl'))).toBe(false)
  })

  it('restarts its own unit in the system manager, never in the user one', async () => {
    const h = harness({ present: true })
    expectOk(await h.manager.install({ scope: 'system' }))

    expect(h.timeline).toEqual([
      `inspect:${UNIT_SYSTEM}`,
      `run:${IS_ACTIVE_SYS}`,
      `run:${IS_ENABLED_SYS}`,
      `run:${SHOW_SYS}`,
      'prepare',
      `read:${UNIT_SYSTEM}`,
      `write:${UNIT_SYSTEM}`,
      `run:${RELOAD_SYS}`,
      `run:${ENABLE_SYS}`,
      `run:${RESTART_SYS}`,
      `inspect:${UNIT_SYSTEM}`,
      `run:${IS_ACTIVE_SYS}`,
      `run:${IS_ENABLED_SYS}`,
      `run:${SHOW_SYS}`,
      'ready',
      `inspect:${UNIT_SYSTEM}`,
      `run:${IS_ACTIVE_SYS}`,
      `run:${IS_ENABLED_SYS}`,
      `run:${SHOW_SYS}`,
    ])
    expect(h.timeline.some((entry) => entry.includes('--user'))).toBe(false)
  })

  it('keeps the daemon running as the original account', async () => {
    const h = harness()
    expectOk(await h.manager.install({ scope: 'system' }))
    expect(h.writes[0].text).toContain('User=walnut')
    expect(h.writes[0].text).toContain('WantedBy=multi-user.target')
  })

  it('refuses without an account name, before touching anything', async () => {
    const h = harness({ user: '' })
    const failure = expectFailure(await h.manager.install({ scope: 'system' }))

    expect(failure.code).toBe('missingUser')
    expect(h.timeline).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('is never the default', async () => {
    const h = harness()
    expectOk(await h.manager.install())
    expect(h.writes.map((write) => write.path)).toEqual([UNIT_USER])
  })
})

describe('install on darwin', () => {
  it('bootstraps into the login domain and verifies with print', async () => {
    const h = harness({ platform: 'darwin', replies: { [PRINT]: [GONE, { stdout: RUNNING }] } })
    const status = expectOk(await h.manager.install())

    expect(h.timeline).toEqual([
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'prepare',
      `write:${PLIST}`,
      `run:${BOOTSTRAP}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'ready',
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
    expect(status).toMatchObject({
      platform: 'darwin',
      configPath: PLIST,
      installed: true,
      active: true,
      enabled: true,
      startup: 'login',
    })
    expect(status.startup).not.toBe('boot')
  })

  it('writes an agent that survives a daemon restart and runs in the foreground', async () => {
    const h = harness({ platform: 'darwin', replies: { [PRINT]: [GONE, { stdout: RUNNING }] } })
    expectOk(await h.manager.install())
    const plist = h.writes[0].text

    expect(plist).toContain('<key>AbandonProcessGroup</key>')
    expect(plist).toContain('<string>--service</string>')
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain(`<string>${RUNTIME_DIR}</string>`)
  })

  it('writes the new plist before booting out its own loaded agent', async () => {
    const h = harness({ platform: 'darwin', present: true, owned: true })
    expectOk(await h.manager.install())

    expect(h.timeline).toEqual([
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'prepare',
      `read:${PLIST}`,
      `write:${PLIST}`,
      `run:${BOOTOUT}`,
      `run:${BOOTSTRAP}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'ready',
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
    expect(h.timeline.indexOf(`write:${PLIST}`)).toBeLessThan(h.timeline.indexOf(`run:${BOOTOUT}`))
  })

  it('refuses a disabled label before preparing, writing, or booting anything out', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT_DISABLED]: { stdout: OVERRIDE_DISABLED } },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('disabledOverride')
    expect(failure.command).toBe(PRINT_DISABLED)
    expect(failure.message).toContain(`launchctl enable ${TARGET}`)
    expect(h.timeline).toEqual([`inspect:${PLIST}`, `run:${PRINT}`, `run:${PRINT_DISABLED}`])
    expect(h.writes).toEqual([])
    expect(h.removed).toEqual([])
    expect(h.prepareCalls()).toBe(0)
  })

  it('never enables a disabled label itself', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT_DISABLED]: { stdout: OVERRIDE_DISABLED } },
    })
    await h.manager.install()
    expect(h.timeline.some((entry) => /launchctl enable|launchctl bootstrap/.test(entry))).toBe(false)
  })

  it('refuses when the disabled state cannot be read at all', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT_DISABLED]: { code: 113, stderr: 'Could not find domain' } },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('overrideUnreadable')
    expect(failure.command).toBe(PRINT_DISABLED)
    expect(failure.stderr).toBe('Could not find domain')
    expect(h.timeline).toEqual([`inspect:${PLIST}`, `run:${PRINT}`, `run:${PRINT_DISABLED}`])
    expect(h.writes).toEqual([])
  })

  it('refuses when the disabled listing is not in a shape it understands', async () => {
    for (const stdout of ['', 'nothing to report\n', 'disabled services = {', `"${LABEL}" => disabled\n`]) {
      const h = harness({
        platform: 'darwin',
        present: true,
        replies: { [PRINT_DISABLED]: { stdout } },
      })
      const failure = expectFailure(await h.manager.install())

      expect(failure.code, JSON.stringify(stdout)).toBe('overrideUnreadable')
      expect(h.writes, JSON.stringify(stdout)).toEqual([])
    }
  })

  it('installs when the listing parses and says nothing about our label', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT_DISABLED]: { stdout: OVERRIDE_ABSENT } },
    })
    const status = expectOk(await h.manager.install())

    expect(status).toMatchObject({ installed: true, enabled: true, startup: 'login' })
    expect(h.writes.map((write) => write.path)).toEqual([PLIST])
  })

  it('refuses a loaded job under the same label when no config of ours is on disk', async () => {
    const h = harness({ platform: 'darwin', present: false, replies: { [PRINT]: { stdout: RUNNING } } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('foreignConfig')
    expect(failure.message).toContain('already loaded')
    expect(h.timeline).toEqual([`inspect:${PLIST}`, `run:${PRINT}`, `run:${PRINT_DISABLED}`])
    expect(h.writes).toEqual([])
    expect(h.prepareCalls()).toBe(0)
  })

  it('refuses a loaded job when the plist on disk is not ours', async () => {
    const h = harness({ platform: 'darwin', present: true, owned: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('foreignConfig')
    expect(h.timeline).toEqual([`inspect:${PLIST}`])
    expect(h.writes).toEqual([])
  })

  it('reports commandFailed when bootstrap fails, then takes its own plist back off disk', async () => {
    const h = harness({
      platform: 'darwin',
      replies: { [PRINT]: GONE, [BOOTSTRAP]: { code: 5, stderr: 'Bootstrap failed: 5' } },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('commandFailed')
    expect(failure.command).toBe(BOOTSTRAP)
    expect(failure.rollback).toBe('removed the config this install wrote, so no service is registered')
    expect(h.timeline).toEqual([
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'prepare',
      `write:${PLIST}`,
      `run:${BOOTSTRAP}`,
      `run:${PRINT}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `remove:${PLIST}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
    // It was never loaded, so it must not bootout and must not run a successful verification.
    expect(h.timeline.some((entry) => entry === `run:${BOOTOUT}`)).toBe(false)
    expect(h.timeline.some((entry) => entry === 'ready')).toBe(false)
  })

  it('does not claim installed when print cannot find the job afterwards', async () => {
    const h = harness({ platform: 'darwin', replies: { [PRINT]: GONE } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/did not come up enabled/)
    expect(h.removed).toEqual([PLIST])
  })

  it('has no system scope', async () => {
    const h = harness({ platform: 'darwin' })
    const failure = expectFailure(await h.manager.install({ scope: 'system' }))

    expect(failure.code).toBe('unsupportedScope')
    expect(h.timeline).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('puts the previous plist back and boots the previous version when bootstrap fails', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [BOOTSTRAP]: [{ code: 5, stderr: 'Bootstrap failed: 5' }, {}] },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('commandFailed')
    expect(failure.command).toBe(BOOTSTRAP)
    expect(failure.rollback).toBe('put the previous config back and a managed daemon is responding; the previous executable identity was not verified')
    // The install already booted out the old job, so rollback only needs to bootstrap the old plist again.
    expect(h.timeline.slice(h.timeline.indexOf(`run:${BOOTSTRAP}`))).toEqual([
      `run:${BOOTSTRAP}`,
      `write:${PLIST}`,
      `run:${PRINT}`,
      `run:${BOOTSTRAP}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'ready',
    ])
    expect(h.writes.map((write) => write.text)).toEqual([h.writes[0].text, PREVIOUS])
    expect(h.removed).toEqual([])
  })

  it('boots out the job it just loaded when a first install never answers', async () => {
    // Before loading, during verify, and during the undo it sees the same job; it is really gone only after bootout.
    const h = harness({
      platform: 'darwin',
      ready: false,
      replies: { [PRINT]: [GONE, { stdout: RUNNING }, { stdout: RUNNING }, GONE] },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.message).toContain(DARWIN_EXE)
    expect(failure.rollback).toBe('removed the config this install wrote, so no service is registered')
    expect(h.timeline.slice(h.timeline.indexOf('ready'))).toEqual([
      'ready',
      `run:${PRINT}`,
      `run:${BOOTOUT}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `remove:${PLIST}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
    expect(h.removed).toEqual([PLIST])
  })

  it('reports a job it could not unload instead of calling the undo clean', async () => {
    const h = harness({
      platform: 'darwin',
      ready: false,
      replies: { [PRINT]: [GONE, { stdout: RUNNING }], [BOOTOUT]: { code: 1, stderr: 'Operation not permitted' } },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.rollback).toBe(`kept the service config because the stop was not confirmed: ${LABEL} stayed loaded`)
    expect(h.removed).toEqual([])
  })

  it('never rolls back the disabled-label refusal, since it wrote nothing', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT_DISABLED]: { stdout: OVERRIDE_DISABLED } },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('disabledOverride')
    expect(failure.rollback).toBeUndefined()
    expect(h.writes).toEqual([])
    expect(h.removed).toEqual([])
    expect(h.timeline.some((entry) => entry === `run:${BOOTOUT}`)).toBe(false)
  })
})

describe('identity of the registered job', () => {
  const OTHER_UNIT = '/etc/systemd/user/open-walnut-daemon.service'
  const DROP_IN = '/etc/systemd/user/open-walnut-daemon.service.d/override.conf'
  const FOREIGN_PLIST = `/Library/LaunchAgents/${LABEL}.plist`
  const foreignJob = { stdout: `state = running\n\tpid = 77\n\tpath = ${FOREIGN_PLIST}\n` }

  it('will not act on a unit that systemd loaded from another directory', async () => {
    for (const act of ['install', 'restart', 'uninstall'] as const) {
      const h = harness({ present: true, replies: { [SHOW]: unitShown(OTHER_UNIT) } })
      const failure = expectFailure(await h.manager[act]())

      expect(failure.code, act).toBe('foreignConfig')
      expect(failure.message, act).toContain(OTHER_UNIT)
      expect(failure.command, act).toBe(SHOW)
      expect(h.writes, act).toEqual([])
      expect(h.removed, act).toEqual([])
      expect(h.timeline.filter((entry) => MUTATING.test(entry)), act).toEqual([])
      expect(h.prepareCalls(), act).toBe(0)
    }
  })

  it('will not change a unit a drop-in has already edited', async () => {
    const h = harness({ present: true, replies: { [SHOW]: unitShown(UNIT_USER, DROP_IN) } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('foreignConfig')
    expect(failure.message).toContain(DROP_IN)
    expect(h.writes).toEqual([])
    expect(h.timeline.filter((entry) => MUTATING.test(entry))).toEqual([])
  })

  it('refuses instead of guessing when systemd will not say where the unit came from', async () => {
    const unreadable: Reply[] = [
      { code: 1, stderr: 'Failed to connect to bus' },
      { stdout: `FragmentPath=${UNIT_USER}\n` },
      { stdout: 'Names=open-walnut-daemon.service\n' },
    ]
    for (const reply of unreadable) {
      const h = harness({ present: true, replies: { [SHOW]: reply } })
      const failure = expectFailure(await h.manager.install())

      expect(failure.code, JSON.stringify(reply)).toBe('unverifiedJob')
      expect(h.writes, JSON.stringify(reply)).toEqual([])
      expect(h.timeline.filter((entry) => MUTATING.test(entry)), JSON.stringify(reply)).toEqual([])
    }
  })

  it.each([112, 125])('treats launchctl exit %s as unknown, not absent', async (code) => {
    for (const act of ['install', 'restart', 'uninstall'] as const) {
      const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: { code, stderr: 'Cannot inspect domain' } } })
      expect(expectFailure(await h.manager[act]()).code).toBe('unverifiedJob')
      expect(h.timeline.filter((entry) => MUTATING.test(entry))).toEqual([])
      expect(h.writes).toEqual([])
      expect(h.removed).toEqual([])
    }
  })

  it('never boots out or kickstarts a job launchd loaded from another plist', async () => {
    for (const act of ['install', 'restart', 'uninstall'] as const) {
      const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: foreignJob } })
      const failure = expectFailure(await h.manager[act]())

      expect(failure.code, act).toBe('foreignConfig')
      expect(failure.message, act).toContain(FOREIGN_PLIST)
      expect(h.writes, act).toEqual([])
      expect(h.removed, act).toEqual([])
      expect(h.timeline.filter((entry) => MUTATING.test(entry)), act).toEqual([])
    }

    const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: foreignJob } })
    const status = await h.manager.status()
    // The on-disk copy is ours, but the running job was not started from it; it must not count as our own running job.
    expect(status).toMatchObject({ installed: true, active: false, enabled: false, startup: 'on-demand' })
    expect(status.detail).toContain(FOREIGN_PLIST)
  })

  it('rolls a failed update back to stopped and not enabled, without a readiness claim', async () => {
    const h = harness({ present: true, started: false, ready: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('put the previous config back and left the service stopped and not enabled, as it was before')
    expect(h.writes.map((write) => write.text)).toEqual([h.writes[0].text, PREVIOUS])
    const rollback = h.timeline.slice(h.timeline.lastIndexOf(`write:${UNIT_USER}`))
    expect(rollback).toContain(`run:${DISABLE_ONLY}`)
    expect(rollback).toContain(`run:${STOP}`)
    expect(rollback.some((entry) => entry === `run:${ENABLE}`)).toBe(false)
    // It was stopped before, so there is no "daemon answers" to require; only the one ready during the install.
    expect(h.readyCalls).toHaveLength(1)
  })

  it.each([
    { active: true, enabled: false },
    { active: false, enabled: true },
  ])('restores active=$active and enabled=$enabled independently', async (was) => {
    const h = harness({ present: true, ...was, ready: [false, true] })
    const failure = expectFailure(await h.manager.install())
    expect(failure.code).toBe('notReady')
    const status = await h.manager.status()
    expect(status).toMatchObject(was)
    expect(h.readyCalls).toHaveLength(was.active ? 2 : 1)
  })

  it('keeps the config when the stop exits 0 but the unit is still running', async () => {
    // Absent before the install, running after enable, and still running although disable --now reported success.
    const h = harness({
      ready: false,
      replies: { [IS_ACTIVE]: [{ code: 3, stdout: 'inactive\n' }, { stdout: 'active\n' }] },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe(
      'kept the service config because the stop was not confirmed: the service is still registered with the init system',
    )
    expect(h.removed).toEqual([])
    expect(h.timeline.some((entry) => entry.startsWith('remove:'))).toBe(false)
  })

  it('keeps the config when launchd will not say what is still loaded after the bootout', async () => {
    const h = harness({
      platform: 'darwin',
      ready: false,
      replies: {
        [PRINT]: [GONE, { stdout: RUNNING }, { stdout: RUNNING }, { code: 125, stderr: 'Operation not permitted' }],
      },
    })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe(
      'kept the service config because the stop was not confirmed: the init system would not say what is still registered',
    )
    expect(h.removed).toEqual([])
    expect(h.timeline.some((entry) => entry.startsWith('remove:'))).toBe(false)
  })

  it('does not call an uninstall clean when the init system will not answer afterwards', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT]: [{ stdout: RUNNING }, GONE, { code: 125, stderr: 'Operation not permitted' }] },
    })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('unverifiedJob')
    expect(failure.message).toMatch(/would not say whether anything is still registered/)
    expect(failure.command).toBe(PRINT)
    expect(h.removed).toEqual([PLIST])
  })

  it('keeps the plist when launchd stops answering right after the uninstall bootout', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT]: [{ stdout: RUNNING }, { code: 125, stderr: 'Operation not permitted' }] },
    })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('unverifiedJob')
    expect(h.removed).toEqual([])
    expect(h.timeline.some((entry) => entry.startsWith('remove:'))).toBe(false)
  })

  it('waits for the daemon instead of failing while launchd is still starting the job', async () => {
    // bootstrap exits 0, but the job shows up in launchctl print only a little later.
    const h = harness({ platform: 'darwin', replies: { [PRINT]: [GONE, GONE, { stdout: RUNNING }] } })
    const status = expectOk(await h.manager.install())

    expect(status).toMatchObject({ installed: true, active: true, enabled: true, startup: 'login' })
    expect(h.readyCalls).toHaveLength(1)
    expect(h.removed).toEqual([])
    expect(h.timeline.indexOf('ready')).toBeLessThan(h.timeline.lastIndexOf(`run:${PRINT}`))
  })

  it('refuses when another job takes the label while the daemon is answering', async () => {
    const other = { stdout: `state = running\n\tpid = 88\n\tpath = ${FOREIGN_PLIST}\n` }
    const h = harness({ platform: 'darwin', replies: { [PRINT]: [GONE, { stdout: RUNNING }, other] } })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('foreignConfig')
    expect(failure.message).toContain(FOREIGN_PLIST)
    expect(h.readyCalls).toHaveLength(1)
    // The swapped-in job is not ours, so it neither boots it out nor deletes its own plist.
    expect(failure.rollback).toMatch(/did not come from/)
    expect(h.removed).toEqual([])
  })

  it('does not bootstrap a launch agent the user had kept unloaded', async () => {
    const h = harness({ platform: 'darwin', present: true, started: false, ready: false })
    const failure = expectFailure(await h.manager.install())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('put the previous config back and left the service stopped and not enabled, as it was before')
    const rollback = h.timeline.slice(h.timeline.lastIndexOf(`write:${PLIST}`))
    expect(rollback).toContain(`run:${BOOTOUT}`)
    expect(rollback.some((entry) => entry === `run:${BOOTSTRAP}`)).toBe(false)
    expect(h.removed).toEqual([])
    expect(h.readyCalls).toHaveLength(1)
  })
})

describe('status', () => {
  it('reads only, and calls boot what linger makes reachable before login', async () => {
    const h = harness({ present: true })
    const status = await h.manager.status()

    expect(h.timeline).toEqual([
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
    ])
    expect(status).toMatchObject({ installed: true, active: true, enabled: true, startup: 'boot' })
    expect(h.timeline.some((entry) => MUTATING.test(entry))).toBe(false)
  })

  it('calls it login when linger is off', async () => {
    const h = harness({ present: true, replies: { [LINGER]: { stdout: 'no\n' } } })
    expect((await h.manager.status()).startup).toBe('login')
  })

  it('calls a present but disabled service on-demand, and still reports it active', async () => {
    const h = harness({ present: true, replies: { [IS_ENABLED]: { code: 1, stdout: 'disabled\n' } } })
    const status = await h.manager.status()

    expect(status).toMatchObject({ installed: true, active: true, enabled: false, startup: 'on-demand' })
  })

  it('treats a static unit as on-demand, not as a boot start', async () => {
    const h = harness({ present: true, replies: { [IS_ENABLED]: { code: 0, stdout: 'static\n' } } })
    const status = await h.manager.status()

    expect(status).toMatchObject({ enabled: false, startup: 'on-demand' })
  })

  it('calls a missing service unavailable', async () => {
    const h = harness({ present: false })
    const status = await h.manager.status()

    expect(status).toMatchObject({ installed: false, foreign: false, startup: 'unavailable' })
  })

  it('flags a foreign config instead of claiming it', async () => {
    const h = harness({ present: true, owned: false })
    const status = await h.manager.status()

    expect(status).toMatchObject({ installed: false, foreign: true, startup: 'unavailable' })
  })

  it('reports a loaded launch agent as login, never boot', async () => {
    const h = harness({ platform: 'darwin', present: true })
    const status = await h.manager.status()

    expect(h.timeline).toEqual([`inspect:${PLIST}`, `run:${PRINT}`, `run:${PRINT_DISABLED}`])
    expect(status).toMatchObject({ installed: true, active: true, enabled: true, startup: 'login' })
    expect(status.detail).toBeUndefined()
    expect(h.timeline.some((entry) => MUTATING.test(entry))).toBe(false)
  })

  it('reports an unloaded launch agent as on-demand', async () => {
    const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: GONE } })
    const status = await h.manager.status()

    expect(status).toMatchObject({ installed: true, active: false, enabled: false, startup: 'on-demand' })
  })

  it('does not call a disabled label a login start just because it is loaded now', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT_DISABLED]: { stdout: OVERRIDE_DISABLED } },
    })
    const status = await h.manager.status()

    expect(status).toMatchObject({ installed: true, active: true, enabled: false, startup: 'on-demand' })
    expect(status.detail).toMatch(/disabled/)
  })

  it('reads the older true and false spelling of the override the same way', async () => {
    const cases: [string, boolean][] = [
      [`"${LABEL}" => true`, false],
      [`"${LABEL}" => false`, true],
      [`"${LABEL}" => disabled`, false],
      [`"${LABEL}" => enabled`, true],
    ]
    for (const [entry, enabled] of cases) {
      const h = harness({
        platform: 'darwin',
        present: true,
        replies: { [PRINT_DISABLED]: { stdout: overrideList([entry]) } },
      })
      expect((await h.manager.status()).enabled, entry).toBe(enabled)
    }
  })

  it('will not claim a login start when the override query fails or makes no sense', async () => {
    const replies: Reply[] = [
      { code: 113, stderr: 'Could not find domain' },
      { stdout: '' },
      { stdout: 'disabled services = {' },
      { stdout: overrideList([`"${LABEL}" => maybe`]) },
      { stdout: overrideList([`"${LABEL}" => 1`]) },
      { stdout: overrideList([`"${LABEL}" => trueSuffix`]) },
    ]
    for (const reply of replies) {
      const h = harness({ platform: 'darwin', present: true, replies: { [PRINT_DISABLED]: reply } })
      const status = await h.manager.status()

      expect(status.enabled, JSON.stringify(reply)).toBe(false)
      expect(status.active, JSON.stringify(reply)).toBe(true)
      expect(status.detail, JSON.stringify(reply)).toMatch(/cannot be confirmed/)
    }
  })

  it('answers the system-scope question on darwin without running anything', async () => {
    const h = harness({ platform: 'darwin' })
    const status = await h.manager.status({ scope: 'system' })

    expect(status).toMatchObject({ scope: 'system', startup: 'unavailable', installed: false })
    expect(status.detail).toMatch(/login agent/)
    expect(h.timeline).toEqual([])
  })
})

describe('uninstall', () => {
  it('stops the service, removes its own config, then re-probes before reporting', async () => {
    const h = harness({ present: true, replies: { [IS_ACTIVE]: STOPS, [IS_ENABLED]: DISABLES } })
    const status = expectOk(await h.manager.uninstall())

    expect(h.timeline).toEqual([
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      `run:${DISABLE}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      `remove:${UNIT_USER}`,
      `run:${RELOAD}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
    ])
    expect(h.removed).toEqual([UNIT_USER])
    expect(status).toMatchObject({ installed: false, active: false, enabled: false, startup: 'unavailable' })
    expect(status.detail).toMatch(/left alone/)
  })

  it('never touches the runtime dir, the state dir, or any process', async () => {
    const h = harness({ present: true, replies: { [IS_ACTIVE]: STOPS, [IS_ENABLED]: DISABLES } })
    await h.manager.uninstall()

    expect(h.timeline.some((entry) => entry.includes(RUNTIME_DIR))).toBe(false)
    expect(h.timeline.some((entry) => entry.includes('open-walnut/daemon'))).toBe(false)
    expect(h.timeline.some((entry) => FORBIDDEN.test(entry))).toBe(false)
  })

  it('skips the stop when the service is already down', async () => {
    const h = harness({
      present: true,
      replies: { [IS_ACTIVE]: { code: 3, stdout: 'inactive\n' }, [IS_ENABLED]: { code: 1, stdout: 'disabled\n' } },
    })
    expectOk(await h.manager.uninstall())

    expect(h.timeline.some((entry) => entry.includes('disable'))).toBe(false)
    expect(h.removed).toEqual([UNIT_USER])
  })

  it('is a no-op when nothing is installed', async () => {
    const h = harness({ present: false })
    const status = expectOk(await h.manager.uninstall())

    expect(h.removed).toEqual([])
    expect(status.detail).toMatch(/no service config/)
    expect(h.timeline.some((entry) => entry.includes('disable'))).toBe(false)
  })

  it('leaves a foreign config in place', async () => {
    const h = harness({ present: true, owned: false })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('foreignConfig')
    expect(h.removed).toEqual([])
    expect(h.timeline.some((entry) => entry.includes('disable'))).toBe(false)
  })

  it('reports commandFailed and keeps the config when the stop fails', async () => {
    const h = harness({ present: true, replies: { [DISABLE]: { code: 1 } } })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('commandFailed')
    expect(h.removed).toEqual([])
  })

  it('does not report success while the config is still on disk', async () => {
    const h = harness({
      present: true,
      stickyConfig: true,
      replies: { [IS_ACTIVE]: STOPS, [IS_ENABLED]: DISABLES },
    })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toContain('still in place')
    expect(h.removed).toEqual([UNIT_USER])
  })

  it('does not report success while the service is still active', async () => {
    // Explicit reply: on this machine the unit is still running after disable, and a derived default must not paper over that.
    const h = harness({ present: true, replies: { [IS_ACTIVE]: { stdout: 'active\n' }, [IS_ENABLED]: DISABLES } })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/still registered/)
    // If it cannot be stopped, the config must not be deleted: otherwise nothing is left to disable it with.
    expect(failure.message).toContain('was left in place')
    expect(h.removed).toEqual([])
  })

  it('boots out the launch agent before deleting the plist, then re-probes', async () => {
    const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: UNLOADS } })
    const status = expectOk(await h.manager.uninstall())

    expect(h.timeline).toEqual([
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `run:${BOOTOUT}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `remove:${PLIST}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
    expect(status).toMatchObject({ installed: false, startup: 'unavailable' })
  })

  it('skips bootout when the agent is not loaded', async () => {
    const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: GONE } })
    expectOk(await h.manager.uninstall())

    expect(h.timeline).toEqual([
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `remove:${PLIST}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
  })

  it('boots out a loaded job even while its label is disabled', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT]: UNLOADS, [PRINT_DISABLED]: { stdout: OVERRIDE_DISABLED } },
    })
    expectOk(await h.manager.uninstall())

    expect(h.timeline.some((entry) => entry === `run:${BOOTOUT}`)).toBe(true)
    expect(h.removed).toEqual([PLIST])
  })

  it('does not report success while the job is still loaded', async () => {
    const h = harness({ platform: 'darwin', present: true, replies: { [PRINT]: { stdout: RUNNING } } })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/still registered/)
    expect(failure.message).toContain('was left in place')
    expect(h.removed).toEqual([])
  })

  it('turns a thrown removal into a structured failure instead of a bare throw', async () => {
    const h = harness({
      present: true,
      removeThrows: 'EPERM: operation not permitted',
      replies: { [IS_ACTIVE]: STOPS, [IS_ENABLED]: DISABLES },
    })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('hostError')
    expect(failure.message).toBe('EPERM: operation not permitted')
    expect(h.removed).toEqual([])
  })

  it('does not report success for a loaded job whose disabled state cannot be read', async () => {
    const h = harness({
      platform: 'darwin',
      present: true,
      replies: { [PRINT]: { stdout: `state = waiting\n\tpath = ${PLIST}\n` }, [PRINT_DISABLED]: { code: 113 } },
    })
    const failure = expectFailure(await h.manager.uninstall())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/still registered/)
    expect(h.removed).toEqual([])
  })
})

describe('restart', () => {
  it('asks the init system to restart the unit, then confirms it is active', async () => {
    const h = harness({ present: true })
    const status = expectOk(await h.manager.restart())

    expect(h.timeline).toEqual([
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      `run:${RESTART}`,
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
      'ready',
      `inspect:${UNIT_USER}`,
      `run:${IS_ACTIVE}`,
      `run:${IS_ENABLED}`,
      `run:${SHOW}`,
      `run:${LINGER}`,
    ])
    expect(status.active).toBe(true)
    expect(h.writes).toEqual([])
  })

  it('never respawns the daemon itself', async () => {
    const h = harness({ present: true })
    await h.manager.restart()
    expect(h.timeline.some((entry) => FORBIDDEN.test(entry))).toBe(false)
  })

  it('unloads and reloads only the daemon job on darwin without a forceful kickstart', async () => {
    const h = harness({ platform: 'darwin', present: true })
    expectOk(await h.manager.restart())

    expect(h.timeline).toEqual([
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      `run:${BOOTOUT}`,
      `run:${BOOTSTRAP}`,
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
      'ready',
      `inspect:${PLIST}`,
      `run:${PRINT}`,
      `run:${PRINT_DISABLED}`,
    ])
  })

  it('does not bootstrap a replacement after launchd refuses to unload the old job', async () => {
    const h = harness({ platform: 'darwin', present: true, replies: { [BOOTOUT]: { code: 1, stderr: 'still stopping' } } })
    expect(expectFailure(await h.manager.restart()).code).toBe('commandFailed')
    expect(h.timeline).not.toContain(`run:${BOOTSTRAP}`)
    expect(h.timeline).not.toContain('ready')
  })

  it('refuses when no service is installed', async () => {
    const h = harness({ present: false })
    const failure = expectFailure(await h.manager.restart())

    expect(failure.code).toBe('notInstalled')
    expect(h.timeline.some((entry) => entry.includes('restart'))).toBe(false)
  })

  it('refuses to restart a foreign service', async () => {
    const h = harness({ present: true, owned: false })
    const failure = expectFailure(await h.manager.restart())

    expect(failure.code).toBe('foreignConfig')
    expect(h.timeline.some((entry) => entry.includes('restart'))).toBe(false)
  })

  it('does not report success when the service stays down', async () => {
    const h = harness({ present: true, replies: { [IS_ACTIVE]: STOPS } })
    const failure = expectFailure(await h.manager.restart())

    expect(failure.code).toBe('verifyFailed')
    expect(failure.message).toMatch(/not active after the restart/)
  })

  it('reports commandFailed when the restart command fails', async () => {
    const h = harness({ present: true, replies: { [RESTART]: { code: 1, stderr: 'no' } } })
    const failure = expectFailure(await h.manager.restart())

    expect(failure.code).toBe('commandFailed')
    expect(failure.command).toBe(RESTART)
    expect(h.timeline.some((entry) => entry === 'ready')).toBe(false)
  })

  // is-active reports active as soon as the process starts, before it has connected its socket.
  it('does not report success when the daemon never answers after the restart', async () => {
    const h = harness({ present: true, ready: false })
    const failure = expectFailure(await h.manager.restart())

    expect(failure.code).toBe('notReady')
    expect(failure.message).toMatch(/never answered as ready/)
    expect(failure.rollback).toBeUndefined()
    expect(h.writes).toEqual([])
    expect(h.removed).toEqual([])
  })

  it('asks for no particular executable, since a restart stages nothing', async () => {
    const h = harness({ present: true })
    expectOk(await h.manager.restart())

    expect(h.readyCalls.map((call) => call.expected)).toEqual([undefined])
    expect(h.readyCalls[0].status).toMatchObject({ configPath: UNIT_USER, active: true })
  })

  it('turns a thrown readiness check into a structured failure', async () => {
    const h = harness({ present: true, readyThrows: 'daemon socket closed' })
    const failure = expectFailure(await h.manager.restart())

    expect(failure.code).toBe('hostError')
    expect(failure.message).toBe('daemon socket closed')
  })
})

describe('safety across every entry point', () => {
  it('runs no privileged, killing, or backgrounding command on any path', async () => {
    for (const platform of ['linux', 'darwin'] as Platform[]) {
      const h = harness({ platform, present: true })
      await h.manager.status()
      await h.manager.install()
      await h.manager.restart()
      await h.manager.uninstall()

      const offenders = h.timeline.filter((entry) => FORBIDDEN.test(entry))
      expect(offenders, `on ${platform}`).toEqual([])
    }
  })

  it('only ever writes or removes its own config path', async () => {
    for (const platform of ['linux', 'darwin'] as Platform[]) {
      const h = harness({ platform, present: true })
      await h.manager.install()
      await h.manager.uninstall()

      const expected = platform === 'darwin' ? PLIST : UNIT_USER
      expect(h.writes.map((write) => write.path)).toEqual([expected])
      expect(h.removed).toEqual([expected])
    }
  })

  it('asks the daemon whether it is ready only where a claim depends on it', async () => {
    for (const platform of ['linux', 'darwin'] as Platform[]) {
      const h = harness({ platform, present: true })
      await h.manager.status()
      await h.manager.uninstall()

      expect(h.timeline.some((entry) => entry === 'ready'), platform).toBe(false)
      expect(h.timeline.some((entry) => entry.startsWith('read:')), platform).toBe(false)
    }
  })

  it('rolls back through the same scope it installed into', async () => {
    const h = harness({ present: true, ready: false })
    expectFailure(await h.manager.install({ scope: 'system' }))

    const systemctl = h.timeline.filter((entry) => entry.startsWith('run:systemctl'))
    expect(systemctl.length).toBeGreaterThan(0)
    expect(systemctl.some((entry) => entry.includes('--user'))).toBe(false)
    expect(h.writes.map((write) => write.path)).toEqual([UNIT_SYSTEM, UNIT_SYSTEM])
  })
})
