/**
 * LocalDaemon must never fight an OS service manager.
 *
 * Once the daemon runs under launchd/systemd, the manager owns start, restart
 * and (through `walnut daemon install`) which artifact runs. Two ways walnut
 * used to break that, both wired shut here:
 *
 *   1. The managed daemon is momentarily absent (login not done yet, launchd
 *      between KeepAlive retries) → ensureRunningInner() spawned an UNMANAGED
 *      daemon into the same runtime dir. The daemon's instance lock then makes
 *      every future managed start fail with "service handover is required", so
 *      launchd retries that failure forever and cron supervision is simply gone.
 *   2. stopDaemon() SIGTERM/SIGKILLed a process the manager immediately brings
 *      back, racing whatever walnut starts next.
 *
 * Two rules the guard encodes, pinned below: a SURVIVING CONFIG counts (a
 * disabled unit still belongs to the manager, and walnut may not enable it), and
 * "could not tell" is never "not installed".
 *
 * Everything is stubbed: fs.lstatSync decides which service files exist,
 * child_process.spawn is a spy that must stay untouched, and process.kill is a
 * spy so no real signal can escape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setDaemonFileFence } from '../../src/providers/daemon-file-fence.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOCAL_UPGRADE_RECHECK_MS,
  LocalDaemon,
  classifyServiceConfigError,
  classifyServiceTakeover,
  daemonServiceConfigPaths,
  localServiceTakeoverMessage,
  type ServiceTakeover,
} from '../../src/providers/local-daemon.js'
import { ourDaemonCapabilities } from '../../src/providers/daemon-shared.js'
import { log } from '../../src/logging/index.js'
import { buildBackoffSettled } from '../../src/providers/daemon-build-backoff.js'
import { guardedPath } from '../setup/exec-guard.js'

// Stub spawn — the guard's whole job is that this never runs. Everything else in
// node:child_process stays real (constants/logging use it at import time).
const { updateCommand, localUpdate, localRevive } = vi.hoisted(() => ({ updateCommand: vi.fn(), localUpdate: vi.fn(), localRevive: vi.fn() }))
vi.mock('../../src/providers/daemon-service-cli.js', () => ({ runDaemonServiceCommand: updateCommand }))
// This machine's service update (detached) and revive: pinned for real in local-daemon-service.test.ts.
vi.mock('../../src/providers/local-daemon-service.js', () => ({ updateLocalService: localUpdate, reviveLocalService: localRevive }))
// The trial run and the kept previous daemon of an unmanaged replacement (local-daemon-replace.test.ts).
const { trial, previousOf, keepSpy } = vi.hoisted(() => ({ trial: vi.fn(async (): Promise<string | null> => null), previousOf: vi.fn(async (): Promise<string | null> => null), keepSpy: vi.fn(async (): Promise<boolean> => false) }))
vi.mock('../../src/providers/local-daemon-replace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/local-daemon-replace.js')>()
  // Wrapped: restoreAllMocks may clear a vi.fn's implementation, and the daemon awaits a promise of these.
  return {
    ...actual,
    trialDaemon: async (...a: unknown[]) => (await (trial as (...x: unknown[]) => unknown)(...a)) ?? null,
    previousDaemon: async (...a: unknown[]) => (await (previousOf as (...x: unknown[]) => unknown)(...a)) ?? null,
    keepRunningBinary: async (...a: unknown[]) => (await (keepSpy as (...x: unknown[]) => unknown)(...a)) ?? false,
  }
})
// No stream needs a fold prewarm here (pinned in local-daemon-fold-prewarm.test.ts),
// and its real registry read is file I/O that fake timers cannot flush.
vi.mock('../../src/providers/fold-prewarm.js', () => ({
  registryNeedsFoldPrewarm: async () => false,
  runFoldPrewarm: async () => ({ outcome: 'ran', ms: 0 }),
}))

// The update clock (daemon-update-behind.ts) answers what a test sets; its store is pinned in daemon-update-behind.test.ts.
const { overdue } = vi.hoisted(() => ({ overdue: { now: false } }))
vi.mock('../../src/providers/daemon-update-behind.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/daemon-update-behind.js')>()
  return { ...actual, daemonUpdateOverdue: () => ({ overdue: overdue.now, behindMs: overdue.now ? 4 * 3600_000 : 0 }) }
})

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn((..._args: unknown[]): never => {
  throw new Error('spawn() must not run while a service manages the daemon')
}) }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnSpy as unknown as typeof actual.spawn }
})

const PROD_DAEMON_DIR = '/tmp/open-walnut'

const priv = (d: LocalDaemon) => d as unknown as {
  detectServiceTakeover(): ServiceTakeover
  assertNoServiceTakeover(action: 'spawn' | 'stop'): void
  spawnDaemon(binaryPath: string): Promise<number>
  stopDaemon(): Promise<void>
  updateManagedDaemon(binaryPath: string, version: string): Promise<number | null | 'busy'>
  isPidAlive(pid: number): boolean
}

const realStatSync = fs.lstatSync

/** Every pid reads as dead, so no signal can escape this test file. */
function spyDeadProcessKill() {
  return vi.spyOn(process, 'kill').mockImplementation(((): boolean => {
    const err = new Error('ESRCH') as NodeJS.ErrnoException
    err.code = 'ESRCH'
    throw err
  }) as typeof process.kill)
}

const realReadFileSync = fs.readFileSync

/**
 * Only the listed paths exist; every other stat falls through to the real fs.
 * A present config reads as `texts[path]` (empty: one Walnut did not write).
 */
function stubServiceFiles(present: string[], unknown: string[] = [], texts: Record<string, string> = {}): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const file = String(target)
    if (present.includes(file)) return texts[file] ?? ''
    return (realReadFileSync as unknown as (...a: unknown[]) => unknown)(target, ...rest)
  }) as typeof fs.readFileSync)
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    const file = String(target)
    if (present.includes(file)) return { isFile: () => true } as fs.Stats
    if (unknown.includes(file)) {
      const err = new Error(`EACCES: permission denied, stat '${file}'`) as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    if (file.endsWith('daemon.service') || file.endsWith('.plist')) {
      const err = new Error(`ENOENT: no such file, stat '${file}'`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return (realStatSync as unknown as (...a: unknown[]) => fs.Stats)(target, ...rest)
  }) as typeof fs.lstatSync)
}

describe('service-takeover classification (pure)', () => {
  it('linux config paths cover the user unit, the system unit AND the cron boot script', () => {
    expect(daemonServiceConfigPaths('linux', '/home/u')).toEqual([
      '/home/u/.config/systemd/user/open-walnut-daemon.service',
      '/etc/systemd/system/open-walnut-daemon.service',
      '/home/u/.local/share/open-walnut/daemon/daemon-boot.sh',
    ])
  })

  it('darwin config path is the LaunchAgent plist', () => {
    expect(daemonServiceConfigPaths('darwin', '/Users/u')).toEqual([
      '/Users/u/Library/LaunchAgents/dev.openwalnut.session-daemon.plist',
    ])
  })

  it('an unsupported platform has no service configs', () => {
    expect(daemonServiceConfigPaths('win32', 'C:/Users/u')).toEqual([])
  })

  it('all-absent → not managed (the ordinary on-demand host)', () => {
    const t = classifyServiceTakeover([
      { path: '/a', state: 'absent' },
      { path: '/b', state: 'absent' },
    ])
    expect(t.managed).toBe(false)
    expect(t.present).toEqual([])
    expect(t.unknown).toEqual([])
  })

  it('one surviving config → managed, even though nothing says "enabled"', () => {
    const t = classifyServiceTakeover([
      { path: '/etc/systemd/system/open-walnut-daemon.service', state: 'present' },
      { path: '/tmp/open-walnut/daemon.service', state: 'absent' },
    ])
    expect(t.managed).toBe(true)
    expect(t.present).toEqual(['/etc/systemd/system/open-walnut-daemon.service'])
  })

  it('unverifiable → managed, and reported as unknown (never as absent)', () => {
    const t = classifyServiceTakeover([{ path: '/etc/x.service', state: 'unknown' }])
    expect(t.managed).toBe(true)
    expect(t.unknown).toEqual(['/etc/x.service'])
    expect(t.present).toEqual([])
  })

  it('only a real "missing" errno counts as absent', () => {
    const err = (code?: string) => Object.assign(new Error(code ?? 'boom'), { code })
    expect(classifyServiceConfigError(err('ENOENT'))).toBe('absent')
    expect(classifyServiceConfigError(err('ENOTDIR'))).toBe('absent')
    expect(classifyServiceConfigError(err('EACCES'))).toBe('unknown')
    expect(classifyServiceConfigError(err('EPERM'))).toBe('unknown')
    expect(classifyServiceConfigError(err('EIO'))).toBe('unknown')
    expect(classifyServiceConfigError(err(undefined))).toBe('unknown')
    expect(classifyServiceConfigError(null)).toBe('unknown')
  })

  it('the refusal names service commands and preserves service ownership', () => {
    const message = localServiceTakeoverMessage('spawn', {
      managed: true, present: ['/tmp/open-walnut/daemon.service'], unknown: [],
    })
    expect(message).toContain('walnut daemon restart --yes')
    expect(message).toContain('walnut daemon status')
    expect(message).toContain('walnut daemon update --yes --executable')
    expect(message).toContain('preserve enabled and stopped choices')
    expect(message).toContain('never start an unmanaged replacement')
    expect(message).toContain('/tmp/open-walnut/daemon.service')
  })
})

describe('LocalDaemon — OS-managed daemons are left alone', () => {
  let tmpDir: string
  let killSpy: ReturnType<typeof spyDeadProcessKill>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-service-'))
    spawnSpy.mockClear()
    killSpy = spyDeadProcessKill()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  function daemonIn(dir: string): LocalDaemon {
    return new LocalDaemon({ daemonDir: dir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
  }

  it('a runtime daemon.service marker is enough (conservative, any dir)', () => {
    stubServiceFiles([path.join(tmpDir, 'daemon.service')])
    expect(priv(daemonIn(tmpDir)).detectServiceTakeover().managed).toBe(true)
  })

  it('a persistent config governs the production runtime dir', () => {
    const config = daemonServiceConfigPaths()[0]
    if (!config) return // platform without service support
    stubServiceFiles([config])
    const takeover = priv(daemonIn(PROD_DAEMON_DIR)).detectServiceTakeover()
    expect(takeover.managed).toBe(true)
    expect(takeover.present).toContain(config)
  })

  it('a config that pins the other production dir governs nothing here (a second user on the machine)', () => {
    const config = daemonServiceConfigPaths()[0]
    if (!config) return
    const pins = (dir: string) => process.platform === 'darwin'
      ? `<key>WALNUT_DAEMON_DIR</key>\n<string>${dir}</string>`
      : `Environment="WALNUT_DAEMON_DIR=${dir}"`
    stubServiceFiles([config], [], { [config]: pins(path.join(os.homedir(), '.cache', 'open-walnut')) })
    const takeover = priv(daemonIn(PROD_DAEMON_DIR)).detectServiceTakeover()
    expect(takeover.managed).toBe(false)
    vi.restoreAllMocks()
    killSpy = spyDeadProcessKill()
    stubServiceFiles([config], [], { [config]: pins(PROD_DAEMON_DIR) })
    expect(priv(daemonIn(PROD_DAEMON_DIR)).detectServiceTakeover().present).toContain(config)
  })

  it('an unreadable config path is managed, not "not installed"', () => {
    const config = daemonServiceConfigPaths()[0]
    if (!config) return
    stubServiceFiles([], [config])
    const takeover = priv(daemonIn(PROD_DAEMON_DIR)).detectServiceTakeover()
    expect(takeover.managed).toBe(true)
    expect(takeover.unknown).toContain(config)
  })

  it('an installed service does NOT claim an isolated dir (tests/sandbox keep working)', () => {
    const config = daemonServiceConfigPaths()[0]
    if (!config) return
    stubServiceFiles([config])
    expect(priv(daemonIn(tmpDir)).detectServiceTakeover().managed).toBe(false)
  })

  it('ensureRunning() refuses instead of spawning a second daemon', async () => {
    stubServiceFiles([path.join(tmpDir, 'daemon.service')])
    const daemon = daemonIn(tmpDir)
    const spawnDaemon = vi.spyOn(priv(daemon), 'spawnDaemon')

    await expect(daemon.ensureRunning()).rejects.toThrow(/walnut daemon restart --yes/)
    expect(spawnDaemon).toHaveBeenCalledTimes(0)
    expect(spawnSpy).toHaveBeenCalledTimes(0)
  })

  it('spawnDaemon() refuses at its own entry too (defense in depth)', async () => {
    stubServiceFiles([path.join(tmpDir, 'daemon.service')])
    await expect(priv(daemonIn(tmpDir)).spawnDaemon('/bin/true'))
      .rejects.toThrow(/owned by an OS service manager/)
    expect(spawnSpy).toHaveBeenCalledTimes(0)
  })

  it('stopDaemon() refuses and never signals the managed process', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), '999999\n')
    stubServiceFiles([path.join(tmpDir, 'daemon.service')])

    await expect(priv(daemonIn(tmpDir)).stopDaemon())
      .rejects.toThrow(/refusing to stop the OS-managed local daemon/)
    expect(killSpy).toHaveBeenCalledTimes(0)
  })

  it('stopIfIsolated() on a service-claimed dir refuses as well', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), '999999\n')
    stubServiceFiles([path.join(tmpDir, 'daemon.service')])

    await expect(daemonIn(tmpDir).stopIfIsolated()).rejects.toThrow(/OS service manager/)
    expect(killSpy).toHaveBeenCalledTimes(0)
  })
})

describe('LocalDaemon managed service updates', () => {
  afterEach(() => { vi.restoreAllMocks(); updateCommand.mockReset(); localUpdate.mockReset(); localRevive.mockReset() })

  it.each([false, true])('updates through the detached CLI transaction without direct lifecycle calls (failure=%s)', async (fails) => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as {
      ensureRunningInner(): Promise<number>
      ping(port: number): Promise<unknown>
      readPortFile(): number
      readBinaryVersion(): string
      updateManagedDaemon(path: string, version: string): Promise<number | null | 'later'>
      auditOwnerOnAdopt(): void
    }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    const portFile = vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    const ping = vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: ['cron-supervision-v1'] })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const stop = vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(1234)
    if (fails) localUpdate.mockRejectedValue(new Error('the update gave no answer Walnut could read (rc=137 tries=1 tail=loaded)'))
    else {
      localUpdate.mockImplementation(async () => {
        // The service's new daemon: its own port and build.
        portFile.mockReturnValue(32200)
        ping.mockResolvedValue({ alive: true, version: 'new-version', capabilities: ['cron-supervision-v1'], instanceId: 'new-instance' })
        return 'applied'
      })
    }
    // The daemon that serves is adopted at once; the update's end adopts what serves then (a start
    // check of its own: ensureRunning, whose production-dir guard refuses a test process, so its inner check).
    vi.spyOn(daemon, 'ensureRunning').mockImplementation(() => internals.ensureRunningInner())
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    await daemon.managedUpdatePending
    expect(daemon.port).toBe(fails ? 32100 : 32200)
    if (fails) {
      // Asked again on the upgrade clock, never left until the next start.
      const recheck = (daemon as unknown as { _upgradeRecheck: ReturnType<typeof setTimeout> | null })._upgradeRecheck
      expect(recheck).not.toBeNull()
      clearTimeout(recheck!)
    }
    // Never the server's own child (2026-11-04 review): the detached runner, with the tail after it.
    expect(localUpdate).toHaveBeenCalledWith('/fixture/daemon', 'user', { record: { key: `local:${PROD_DAEMON_DIR}`, expected: 'new-version' }, overBusy: false })
    expect(updateCommand).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    // Tried within 10 minutes: asked again on the upgrade clock, not run twice.
    expect(await internals.updateManagedDaemon('/fixture/daemon', 'new-version')).toBe('later')
    expect(localUpdate).toHaveBeenCalledTimes(1)
  })

  // 2026-11-04 review: an update that answered ok and whose tail put the previous one back was
  // tried again every 10 minutes, each try a stop and a put-back of this machine's daemon.
  it('a build that answered ok and did not stay serving is not tried again for a day; any other failure is, after 10 minutes', async () => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { updateManagedDaemon(path: string, version: string): Promise<number | null | 'busy' | 'backoff'> }
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    const later = (ms: number) => { priv(daemon)._lastManagedUpdate.at -= ms; if (priv(daemon)._managedFail) priv(daemon)._managedFail.at -= ms }
    localUpdate.mockRejectedValue(Object.assign(new Error('the update answered ok, but afterwards on the host: the previous service config was put back'), { tailOutcome: 'restored', buildFailed: true }))
    await expect(internals.updateManagedDaemon('/fixture/daemon', 'new-version')).rejects.toThrow('Managed daemon update failed')
    later(11 * 60_000)
    expect(await internals.updateManagedDaemon('/fixture/daemon', 'new-version')).toBe('backoff')
    expect(localUpdate).toHaveBeenCalledTimes(1)
    later(24 * 60 * 60_000)
    await expect(internals.updateManagedDaemon('/fixture/daemon', 'new-version')).rejects.toThrow('Managed daemon update failed')
    expect(localUpdate).toHaveBeenCalledTimes(2)
    // Another build is tried at once; a failure that is not the build's own waits only the 10 minutes.
    localUpdate.mockRejectedValue(new Error('the update gave no answer Walnut could read'))
    await expect(internals.updateManagedDaemon('/fixture/daemon', 'newer-version')).rejects.toThrow('Managed daemon update failed')
    later(11 * 60_000)
    await expect(internals.updateManagedDaemon('/fixture/daemon', 'newer-version')).rejects.toThrow('Managed daemon update failed')
    expect(localUpdate).toHaveBeenCalledTimes(4)
  })

  // 2026-11-04 review: the day off lived in memory, so every deploy (a server restart) let the next start try the build again.
  it('the day off of a managed build that did not stay serving is kept across a server restart', async () => {
    const file = path.join(os.tmpdir(), `walnut-local-backoff-${process.pid}-${Date.now()}.json`)
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    try {
      const make = () => {
        const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
        vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
        return daemon as unknown as { updateManagedDaemon(path: string, version: string): Promise<number | null | 'busy' | 'backoff'> }
      }
      localUpdate.mockRejectedValue(Object.assign(new Error('Managed daemon update failed: the daemon never answered as ready'), { buildFailed: true }))
      await expect(make().updateManagedDaemon('/fixture/daemon', 'new-version')).rejects.toThrow('Managed daemon update failed')
      await buildBackoffSettled()
      expect(await make().updateManagedDaemon('/fixture/daemon', 'new-version')).toBe('backoff')
      expect(localUpdate).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      fs.rmSync(file, { force: true })
    }
  })

  // 2026-11-10 review: a build on its day off was never asked again while this server ran, and the
  // log told the user to install the daemon by hand.
  it('a build on its day off is asked again when the day ends, with no advice to install by hand', async () => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    const internals = daemon as unknown as { _managedFail: unknown; startManagedUpdate(path: string, expected: string, running: string | null): void; scheduleUpgradeRecheck(ms?: number): void }
    internals._managedFail = { expected: 'new-version', at: Date.now() - 60 * 60_000, reason: 'the daemon never answered as ready' }
    const recheck = vi.spyOn(internals, 'scheduleUpgradeRecheck').mockImplementation(() => {})
    const error = vi.spyOn(log.session, 'error').mockImplementation(() => {})
    internals.startManagedUpdate('/fixture/daemon', 'new-version', 'old-version')
    await daemon.managedUpdatePending
    expect(localUpdate).not.toHaveBeenCalled()
    expect(recheck).toHaveBeenCalledTimes(1)
    const ms = recheck.mock.calls[0][0]!
    expect(ms).toBeGreaterThan(22 * 60 * 60_000)
    expect(ms).toBeLessThanOrEqual(23 * 60 * 60_000 + 5_000)
    expect(error).not.toHaveBeenCalled()
  })

  // 2026-11-04 review 4: startServer awaits ensureRunning() before it listens, and that waited on
  // the whole managed update (the trial, two stays, a ready wait of up to 60 s; up to 15 min for
  // the runner). On a loaded Mac that passed the deploy's readiness window, which rolled it back.
  it('a start never waits on a managed update: the running daemon is adopted at once, and the update\'s end adopts the new one', async () => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; ping(port: number): Promise<unknown>; readPortFile(): number; readBinaryVersion(): string; auditOwnerOnAdopt(): void }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    const portFile = vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    const ping = vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: ['cron-supervision-v1'] })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    let finish!: () => void
    localUpdate.mockImplementation(() => new Promise<'applied'>((resolve) => { finish = () => resolve('applied') }))
    // The update's end runs a start check of its own (ensureRunning, whose production-dir guard refuses a test process).
    const recheck = vi.spyOn(daemon, 'ensureRunning').mockImplementation(() => internals.ensureRunningInner())
    const started = Date.now()
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(daemon.port).toBe(32100)
    // The update runs beside it (its module loads first).
    await vi.waitFor(() => expect(localUpdate).toHaveBeenCalledTimes(1))
    // Asked again while it runs: still the old daemon, no second update.
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    expect(localUpdate).toHaveBeenCalledTimes(1)
    expect(recheck).not.toHaveBeenCalled()
    // The update is through: the new daemon is adopted.
    portFile.mockReturnValue(32200)
    ping.mockResolvedValue({ alive: true, version: 'new-version', capabilities: ['cron-supervision-v1'], instanceId: 'new-instance' })
    finish()
    await daemon.managedUpdatePending
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(daemon.port).toBe(32200)
  })

  it('a busy refusal is asked again on the upgrade clock, the old daemon adopted', async () => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; ping(port: number): Promise<unknown>; readPortFile(): number; readBinaryVersion(): string; auditOwnerOnAdopt(): void; scheduleUpgradeRecheck(): void }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: ['cron-supervision-v1'] })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    const recheck = vi.spyOn(internals, 'scheduleUpgradeRecheck').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    localUpdate.mockResolvedValue('busy')
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    await daemon.managedUpdatePending
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('a service config on disk with no daemon running is started before the refusal, and its daemon adopted', async () => {
    // 2026-11-04 review: a deploy that stopped the server between bootout and bootstrap left no agent loaded,
    // and the next server refused to start a daemon beside the service, for good.
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; ping(port: number): Promise<unknown>; readPortFile(): number | null; readBinaryVersion(): string; auditOwnerOnAdopt(): void }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    const port = vi.spyOn(internals, 'readPortFile').mockReturnValue(null)
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'new-version', capabilities: ['cron-supervision-v1'], instanceId: 'revived' })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(1234)
    localRevive.mockImplementation(async () => { port.mockReturnValue(32300); return { outcome: 'loaded', words: 'the service was not running after the update, so it was started again, and a daemon answers' } })
    await expect(internals.ensureRunningInner()).resolves.toBe(32300)
    expect(localRevive).toHaveBeenCalledWith('user')
    expect(start).not.toHaveBeenCalled()
  })

  it('a revive that brings no daemon still refuses, and is not tried again within a minute', async () => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; readPortFile(): number | null; readBinaryVersion(): string }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValue(null)
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(1234)
    localRevive.mockResolvedValue({ outcome: 'down', words: 'no daemon answered within 30 s, and there was no earlier service config to go back to' })
    await expect(internals.ensureRunningInner()).rejects.toThrow(/walnut daemon restart --yes/)
    await expect(internals.ensureRunningInner()).rejects.toThrow(/walnut daemon restart --yes/)
    expect(localRevive).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('LocalDaemon keeps a daemon another Walnut shares (daemon-shared.ts)', () => {
  afterEach(() => { vi.restoreAllMocks(); updateCommand.mockReset() })
  const OTHER = { 'cccccccccccccccc': Date.now() }

  it.each([['managed', ['cron-supervision-v1']], ['unmanaged', []]])('%s: another build with every capability is adopted, nothing stopped or updated', async (_kind, extra) => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; ping(port: number): Promise<unknown>; readPortFile(): number; readBinaryVersion(): string; auditOwnerOnAdopt(): void }
    const caps = [...ourDaemonCapabilities('binary'), ...extra]
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'other-version', capabilities: caps, served: { version: 'other-version', twin: 'binary', capabilities: caps, walnuts: OTHER } })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    const update = vi.spyOn(priv(daemon), 'updateManagedDaemon')
    const stop = vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(1234)
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    expect(update).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(updateCommand).not.toHaveBeenCalled()
  })

  it('a shared daemon that lacks a capability is still updated', async () => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; ping(port: number): Promise<unknown>; readPortFile(): number; readBinaryVersion(): string; auditOwnerOnAdopt(): void }
    const caps = [...ourDaemonCapabilities('binary').slice(1), 'cron-supervision-v1']
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'other-version', capabilities: caps, served: { version: 'other-version', twin: 'binary', capabilities: caps, walnuts: OTHER } })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    const update = vi.spyOn(priv(daemon), 'updateManagedDaemon').mockResolvedValue(null)
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    await internals.ensureRunningInner()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('LocalDaemon — unmanaged hosts keep their on-demand behavior', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-nosvc-'))
    spawnSpy.mockClear()
    stubServiceFiles([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('an upgrade put off for open ACP turns is tried again on a clock and goes ahead once they close', async () => {
    vi.useFakeTimers()
    try {
      const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
      const internals = daemon as unknown as {
        readBinaryVersion(): string
        readPortFile(): number | null
        ping(port: number): Promise<unknown>
        readAcpBusySids(): string[]
        auditOwnerOnAdopt(): void
      }
      vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
      vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
      vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
      vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
      const busy = vi.spyOn(internals, 'readAcpBusySids').mockReturnValue(['acp-1'])
      const stop = vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
      const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(32200)

      await expect(daemon.ensureRunning()).resolves.toBe(32100)
      await vi.advanceTimersByTimeAsync(LOCAL_UPGRADE_RECHECK_MS)
      expect(busy).toHaveBeenCalledTimes(2)
      expect(stop).not.toHaveBeenCalled()

      busy.mockReturnValue([])
      await vi.advanceTimersByTimeAsync(LOCAL_UPGRADE_RECHECK_MS)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
      expect(daemon.port).toBe(32200)

      // Upgraded: no clock is left running.
      await vi.advanceTimersByTimeAsync(LOCAL_UPGRADE_RECHECK_MS * 3)
      expect(busy).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it('overdue, open ACP turns and host_exec runs on this Mac no longer hold the upgrade', async () => {
    overdue.now = true
    try {
      const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
      const internals = daemon as unknown as {
        readBinaryVersion(): string
        readPortFile(): number | null
        ping(port: number): Promise<unknown>
        readAcpBusySids(): string[]
        auditOwnerOnAdopt(): void
      }
      vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
      vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
      vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [], execRunning: 1 })
      vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
      vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      vi.spyOn(internals, 'readAcpBusySids').mockReturnValue(['acp-1'])
      const stop = vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
      const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(32200)
      await expect(daemon.ensureRunning()).resolves.toBe(32200)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
    } finally { overdue.now = false }
  })

  /** A persistent daemon (the cloud companion's tunnel daemon) of an older build, every lifecycle call a spy. */
  function persistentOnOldBuild() {
    const daemon = new LocalDaemon({ daemonDir: tmpDir, persistent: true, binaryPath: path.join(tmpDir, 'bin', 'daemon-new') })
    const internals = daemon as unknown as {
      ensureRunningInner(): Promise<number>; readBinaryVersion(): string; readPortFile(): number | null; ping(port: number): Promise<unknown>
      readAcpBusySids(): string[]; auditOwnerOnAdopt(): void; scheduleUpgradeRecheck(): void; buildSpawnEnv(): Promise<NodeJS.ProcessEnv>; writeOwnerStamp(): void
    }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
    vi.spyOn(internals, 'readAcpBusySids').mockReturnValue([])
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(internals, 'writeOwnerStamp').mockImplementation(() => {})
    vi.spyOn(internals, 'buildSpawnEnv').mockResolvedValue({ PATH: guardedPath([], '/usr/bin:/bin') })
    const recheck = vi.spyOn(internals, 'scheduleUpgradeRecheck').mockImplementation(() => {})
    const stop = vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(daemon), 'spawnDaemon')
    // The trial's end asks again through ensureRunning: a spy here, so each test drives the next check itself.
    const retried = vi.spyOn(daemon, 'ensureRunning').mockResolvedValue(32100)
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    const trialDone = async () => { await (daemon as unknown as { _gate: { pending: Promise<void> } })._gate.pending; await new Promise((r) => setTimeout(r, 0)) }
    return { daemon, internals, recheck, stop, start, retried, trialDone }
  }

  it('a new build that fails its trial run never stops the old daemon (the companion, a host with no service)', async () => {
    // 2026-11-04 review: the old daemon was stopped first, so a build that could not start left the box with none.
    const { internals, recheck, stop, start, retried, trialDone } = persistentOnOldBuild()
    trial.mockResolvedValue('it exited with 1 before it listened: SyntaxError')
    try {
      // The trial runs beside the old daemon, which serves meanwhile; its end asks again.
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      expect(retried).toHaveBeenCalledTimes(1)
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      expect(stop).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(recheck).toHaveBeenCalledTimes(2)
      // The same build is not tried again for a while.
      expect(trial).toHaveBeenCalledTimes(1)
    } finally { trial.mockReset().mockResolvedValue(null) }
  })

  it('a trial that hangs never holds a start: the old daemon serves at once (2026-11-04 review: ~75 s)', async () => {
    const { internals, stop, start, retried } = persistentOnOldBuild()
    let release!: (value: string | null) => void
    trial.mockImplementation(() => new Promise<string | null>((resolve) => { release = resolve }))
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      // Asked again while it runs: no second trial, still the old daemon.
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      expect(trial).toHaveBeenCalledTimes(1)
      expect(retried).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      release(null)
    } finally { trial.mockReset().mockResolvedValue(null) }
  })

  it('a trial that cannot run at all (it throws) keeps the old daemon and says why (2026-11-04 review)', async () => {
    const { internals, stop, start, trialDone, daemon } = persistentOnOldBuild()
    trial.mockRejectedValue(new Error('EMFILE: too many open files, mkdtemp'))
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      expect(stop).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      const gate = (daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate
      expect(gate.refusal('new-version')).toBe('the trial could not run (EMFILE: too many open files, mkdtemp)')
    } finally { trial.mockReset().mockResolvedValue(null) }
  })

  it('a new build that passes its trial and then does not start is followed by the old daemon again', async () => {
    const { internals, stop, start, trialDone, retried } = persistentOnOldBuild()
    previousOf.mockResolvedValue('/fixture/previous/daemon-linux-x64')
    start.mockImplementation(async (file: string) => {
      if (file.endsWith('daemon-new')) throw new Error('Local daemon started but no port file within 10000ms')
      return 32400
    })
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      expect(retried).toHaveBeenCalledTimes(1)
      await expect(internals.ensureRunningInner()).resolves.toBe(32400)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new'), '/fixture/previous/daemon-linux-x64'])
      // The old build answers again; the next check keeps it rather than stopping it once more.
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally { previousOf.mockReset().mockResolvedValue(null) }
  })

  it('a build that did not start on the real dir is left alone even with nothing kept to go back to, and for longer than the trial retry', async () => {
    // 2026-11-04 review: no backoff on that branch, so every recheck stopped the old daemon for it again.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { internals, stop, start, trialDone } = persistentOnOldBuild()
      start.mockImplementation(async (file: string) => {
        if (file.endsWith('daemon-new')) throw new Error('Local daemon started but no port file within 10000ms')
        return 32400
      })
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      // Nothing kept (previousOf answers null): the failed start is the error.
      await expect(internals.ensureRunningInner()).rejects.toThrow(/no port file/)
      expect(stop).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(trial).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  // 2026-11-04 review: the gate only held while an old daemon answered, so once it died the next
  // start launched the refused build without trying the kept previous one.
  // 2026-11-04 review: a failed keep (a full disk, a clone refused) read as nothing to keep, and
  // the old daemon was stopped with no way back.
  it('a keep of the running daemon\'s file that fails never stops it: it keeps serving and is asked again', async () => {
    const { internals, recheck, stop, start, trialDone } = persistentOnOldBuild()
    const { KeepFailedError } = await import('../../src/providers/local-daemon-replace.js')
    previousOf.mockRejectedValueOnce(new KeepFailedError('the running daemon\'s file could not be copied to go back to (ENOSPC)'))
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    await trialDone()
    // Its trial passed (the default); the keep failed: no stop, no start, asked again on the clock.
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(recheck).toHaveBeenCalled()
  })

  it('the old daemon died while the new build is refused: the kept build that ran before is started, not the refused one', async () => {
    const { internals, start, trialDone, daemon } = persistentOnOldBuild()
    trial.mockResolvedValue('it exited with 1 before it listened: SyntaxError')
    start.mockResolvedValue(32500)
    const keep = path.join(tmpDir, 'previous')
    fs.mkdirSync(keep, { recursive: true })
    fs.writeFileSync(path.join(keep, 'daemon-new'), 'old build', { mode: 0o755 })
    fs.writeFileSync(path.join(keep, 'daemon-new.version'), 'old-version\n')
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      // The old daemon is gone now: no port file.
      vi.spyOn(internals, 'readPortFile').mockReturnValue(null)
      await expect(internals.ensureRunningInner()).resolves.toBe(32500)
      expect(start.mock.calls.map(([file]) => file)).toEqual([path.join(keep, 'daemon-new')])
      // With nothing kept, there is only the new build to start.
      fs.rmSync(keep, { recursive: true })
      await expect(internals.ensureRunningInner()).resolves.toBe(32500)
      expect(start.mock.calls.at(-1)![0]).toBe(path.join(tmpDir, 'bin', 'daemon-new'))
    } finally {
      // That start is watched: its window's end is not this test's.
      (daemon as unknown as { _stay: { clear(): void } })._stay.clear()
      trial.mockReset().mockResolvedValue(null)
    }
  })

  // 2026-11-04 review 4: B replaced A, died at 10 s, A came back; the Mac rebooted that evening.
  // The hold survived (WALNUT_HOME/local) but the kept copy was in /tmp/open-walnut/previous, so
  // the next start found none and ran B, unwatched, which crash looped.
  it('after a reboot inside the day off, the start is the kept build from the dir that survives it; with none kept, the refused build is watched', async () => {
    const file = path.join(tmpDir, 'backoff.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    try {
      const { writeBuildBackoff } = await import('../../src/providers/daemon-build-backoff.js')
      const { previousKeepDir } = await import('../../src/providers/local-daemon-replace.js')
      void writeBuildBackoff(`local:${tmpDir}`, { expected: 'new-version', at: Date.now(), reason: 'it did not start on the real dir: no port file' })
      await buildBackoffSettled()
      const keep = previousKeepDir(tmpDir)
      fs.mkdirSync(keep, { recursive: true })
      fs.writeFileSync(path.join(keep, 'daemon-new'), 'old build', { mode: 0o755 })
      fs.writeFileSync(path.join(keep, 'daemon-new.version'), 'old-version\n')
      // The server after the reboot: no daemon runs, the daemon dir holds nothing of before.
      const { daemon, internals, start } = persistentOnOldBuild()
      vi.spyOn(internals, 'readPortFile').mockReturnValue(null)
      vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      start.mockResolvedValue(32500)
      await expect(internals.ensureRunningInner()).resolves.toBe(32500)
      expect(start.mock.calls.map(([f]) => f)).toEqual([path.join(keep, 'daemon-new')])
      // Nothing kept at all: the refused build starts (there is nothing else), and its stay is watched.
      fs.rmSync(keep, { recursive: true })
      vi.spyOn(daemon, 'pid', 'get').mockReturnValue(7002)
      const alive = vi.spyOn(priv(daemon), 'isPidAlive').mockReturnValue(true)
      await expect(internals.ensureRunningInner()).resolves.toBe(32500)
      expect(start.mock.calls.at(-1)![0]).toBe(path.join(tmpDir, 'bin', 'daemon-new'))
      const gate = (daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate
      alive.mockReturnValue(false)
      await expect((daemon as unknown as { settleStay(): Promise<boolean> }).settleStay()).resolves.toBe(true)
      expect(gate.refusal('new-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
    }
  })

  // 2026-11-04 review: the port file (one answer) counted, so a build that listened and then
  // exited was started again on the next connect, and the old daemon never came back.
  it('a new daemon that answers and is gone before it stayed serving is followed by the kept old one, and the build is refused', async () => {
    const { internals, stop, start, trialDone, daemon } = persistentOnOldBuild()
    const keep = path.join(tmpDir, 'previous')
    fs.mkdirSync(keep, { recursive: true })
    fs.writeFileSync(path.join(keep, 'daemon-new'), 'old build', { mode: 0o755 })
    fs.writeFileSync(path.join(keep, 'daemon-new.version'), 'old-version\n')
    previousOf.mockResolvedValue(path.join(keep, 'daemon-new'))
    start.mockResolvedValue(32400)
    vi.spyOn(daemon, 'pid', 'get').mockReturnValue(7001)
    const alive = vi.spyOn(priv(daemon), 'isPidAlive').mockReturnValue(true)
    const watch = (daemon as unknown as { _stay: { clear(): void } })._stay
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      await expect(internals.ensureRunningInner()).resolves.toBe(32400)
      expect(stop).toHaveBeenCalledTimes(1)
      // A few seconds later it exited: its pid is gone, and its port answers no more.
      alive.mockReturnValue(false)
      vi.spyOn(internals, 'ping').mockResolvedValue({ alive: false })
      await expect(internals.ensureRunningInner()).resolves.toBe(32400)
      expect(start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new'), path.join(keep, 'daemon-new')])
      const gate = (daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate
      expect(gate.refusal('new-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
    } finally {
      watch.clear()
      previousOf.mockReset().mockResolvedValue(null)
    }
  })

  // 2026-11-04 review 5: on a Mac the copy of the build that ran before is one slot, and the new
  // build kept itself there at its start, so its death within the window started it again.
  it('a replacement is kept as the build to go back to only once it stayed serving', async () => {
    const { StayWatch } = await import('../../src/providers/local-daemon-replace.js')
    const { internals, start, trialDone, daemon } = persistentOnOldBuild()
    // Its window on a clock of the test's own: nothing a loaded machine does moves it.
    let clock = 0
    Object.defineProperty(daemon, '_stay', { value: new StayWatch(100, () => clock) })
    previousOf.mockResolvedValue(path.join(tmpDir, 'previous', 'daemon-new'))
    start.mockResolvedValue(32400)
    vi.spyOn(daemon, 'pid', 'get').mockReturnValue(7001)
    vi.spyOn(priv(daemon), 'isPidAlive').mockReturnValue(true)
    keepSpy.mockClear()
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      await expect(internals.ensureRunningInner()).resolves.toBe(32400)
      // Asked again inside its window, it answers as the new build: still not kept.
      vi.spyOn(internals, 'readPortFile').mockReturnValue(32400)
      vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'new-version', capabilities: [] })
      await expect(internals.ensureRunningInner()).resolves.toBe(32400)
      await new Promise((r) => setTimeout(r, 20))
      expect(keepSpy).not.toHaveBeenCalled()
      // Its window is over and it serves: kept.
      clock = 1_000
      await vi.waitFor(() => expect(keepSpy).toHaveBeenCalledWith(expect.objectContaining({ version: 'new-version' })))
    } finally {
      (daemon as unknown as { _stay: { clear(): void } })._stay.clear()
      previousOf.mockReset().mockResolvedValue(null)
    }
  })

  // 2026-11-04 review 5: a watch that ended says nothing of how. A start that raced the watched
  // daemon's death serves the refused build unwatched, and an adopt kept it over the old one.
  it('a running daemon of a build refused here is not kept as the one to go back to; one not refused is', async () => {
    keepSpy.mockClear()
    const served = persistentOnOldBuild()
    vi.spyOn(served.internals, 'ping').mockResolvedValue({ alive: true, version: 'new-version', capabilities: [] })
    await expect(served.internals.ensureRunningInner()).resolves.toBe(32100)
    await vi.waitFor(() => expect(keepSpy).toHaveBeenCalledWith(expect.objectContaining({ version: 'new-version' })))
    keepSpy.mockClear()
    const { internals, daemon } = persistentOnOldBuild()
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'new-version', capabilities: [] })
    const gate = (daemon as unknown as { _gate: { refuse(e: string, r: string, u: boolean): void } })._gate
    gate.refuse('new-version', 'it stopped within 4 s after it started on the real dir', true)
    await expect(internals.ensureRunningInner()).resolves.toBe(32100)
    await new Promise((r) => setTimeout(r, 50))
    expect(keepSpy).not.toHaveBeenCalled()
  })

  // 2026-11-04 review 5: the refused build started because the kept one did not was watched, and
  // never kept once it stayed, so the next build had nothing to go back to.
  it('the refused build started because the kept one did not start is kept once it stayed', async () => {
    const { StayWatch } = await import('../../src/providers/local-daemon-replace.js')
    const { internals, start, trialDone, daemon } = persistentOnOldBuild()
    let clock = 0
    Object.defineProperty(daemon, '_stay', { value: new StayWatch(100, () => clock) })
    trial.mockResolvedValue('it exited with 1 before it listened: SyntaxError')
    const keep = path.join(tmpDir, 'previous')
    fs.mkdirSync(keep, { recursive: true })
    fs.writeFileSync(path.join(keep, 'daemon-new'), 'old build', { mode: 0o755 })
    fs.writeFileSync(path.join(keep, 'daemon-new.version'), 'old-version\n')
    start.mockRejectedValueOnce(new Error('no port file')).mockResolvedValue(32500)
    vi.spyOn(daemon, 'pid', 'get').mockReturnValue(7003)
    vi.spyOn(priv(daemon), 'isPidAlive').mockReturnValue(true)
    keepSpy.mockClear()
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await trialDone()
      vi.spyOn(internals, 'readPortFile').mockReturnValue(null)
      await expect(internals.ensureRunningInner()).resolves.toBe(32500)
      expect(start.mock.calls.map(([file]) => file)).toEqual([path.join(keep, 'daemon-new'), path.join(tmpDir, 'bin', 'daemon-new')])
      await new Promise((r) => setTimeout(r, 20))
      expect(keepSpy).not.toHaveBeenCalled()
      // It serves on its port as its build: a watch past its window passes only on that (review 8).
      vi.spyOn(internals, 'readPortFile').mockReturnValue(32500)
      vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'new-version', capabilities: [] })
      clock = 1_000
      await vi.waitFor(() => expect(keepSpy).toHaveBeenCalledWith(expect.objectContaining({ version: 'new-version' })))
    } finally {
      (daemon as unknown as { _stay: { clear(): void } })._stay.clear()
      trial.mockReset().mockResolvedValue(null)
    }
  })

  it('an isolated test dir is replaced as before: no trial run, nothing kept', async () => {
    const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-new') })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; readBinaryVersion(): string; readPortFile(): number | null; ping(port: number): Promise<unknown>; readAcpBusySids(): string[]; writeOwnerStamp(): void }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
    vi.spyOn(internals, 'readAcpBusySids').mockReturnValue([])
    vi.spyOn(internals, 'writeOwnerStamp').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
    vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(32200)
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    await expect(internals.ensureRunningInner()).resolves.toBe(32200)
    expect(trial).not.toHaveBeenCalled()
    expect(previousOf).not.toHaveBeenCalled()
  })

  it('stopIfIsolated() also ends a pending upgrade clock', async () => {
    vi.useFakeTimers()
    try {
      const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
      const internals = daemon as unknown as {
        readBinaryVersion(): string
        readPortFile(): number | null
        ping(port: number): Promise<unknown>
        readAcpBusySids(): string[]
        auditOwnerOnAdopt(): void
      }
      vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
      vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
      const ping = vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
      vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
      vi.spyOn(internals, 'readAcpBusySids').mockReturnValue(['acp-1'])
      vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)

      await daemon.ensureRunning()
      await daemon.stopIfIsolated()
      await vi.advanceTimersByTimeAsync(LOCAL_UPGRADE_RECHECK_MS * 2)
      expect(ping).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('ensureRunning() still reaches the spawn path', async () => {
    const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
    const spawnDaemon = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(4321)

    await expect(daemon.ensureRunning()).resolves.toBe(4321)
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  })

  it('does not treat a refused signal as a completed stop', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
    const pidFile = path.join(tmpDir, 'daemon.pid')
    fs.writeFileSync(pidFile, '999999\n')
    const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
    await expect(priv(daemon).stopDaemon()).rejects.toThrow('EPERM')
    expect(fs.existsSync(pidFile)).toBe(true)
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it.each([7000, null])('waits for draining and retains live markers on timeout (%s)', async (exitAfter) => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const kill = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal: unknown) => {
      if (signal === 0 && exitAfter !== null && Date.now() - startedAt >= exitAfter) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      return true
    }) as typeof process.kill)
    const pidFile = path.join(tmpDir, 'daemon.pid')
    fs.writeFileSync(pidFile, '999999\n')
    const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
    try {
      const stopping = priv(daemon).stopDaemon()
      const outcome = exitAfter === null
        ? expect(stopping).rejects.toThrow('shutdown is still pending')
        : expect(stopping).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(5000)
      expect(fs.existsSync(pidFile)).toBe(true)
      await vi.advanceTimersByTimeAsync(25000)
      await outcome
      expect(kill.mock.calls.filter((call) => call[1] !== 0)).toEqual([[999999, 'SIGTERM']])
      expect(fs.existsSync(pidFile)).toBe(exitAfter === null)
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('stopDaemon() still signals the pid it owns', async () => {
    const killSpy = spyDeadProcessKill()
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), '999999\n')

    const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-fake') })
    await expect(priv(daemon).stopDaemon()).resolves.toBeUndefined()
    expect(killSpy).toHaveBeenCalledWith(999999, 'SIGTERM')
  })
})

describe('LocalDaemon overdue managed update (daemon-over-busy.ts)', () => {
  afterEach(() => { vi.restoreAllMocks(); localUpdate.mockReset(); overdue.now = false })

  it.each([true, false])('overdue=%s: the update goes over the busy daemon only when overdue, and file changes wait for its swap then', async (late) => {
    overdue.now = late
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as { ensureRunningInner(): Promise<number>; ping(port: number): Promise<unknown>; readPortFile(): number; readBinaryVersion(): string; auditOwnerOnAdopt(): void }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    const portFile = vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
    const ping = vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: ['cron-supervision-v1'] })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    // Overdue, this server's file changes to the local daemon wait for the swap (daemon-file-fence.ts).
    const steps: string[] = []
    setDaemonFileFence('__local__', () => { steps.push('fence'); return () => steps.push('release') })
    localUpdate.mockImplementation(async () => {
      steps.push('update')
      portFile.mockReturnValue(32200)
      ping.mockResolvedValue({ alive: true, version: 'new-version', capabilities: ['cron-supervision-v1'], instanceId: 'new-instance' })
      return 'applied'
    })
    // The update's end runs a start check of its own (ensureRunning, whose production-dir guard refuses a test process).
    vi.spyOn(daemon, 'ensureRunning').mockImplementation(() => internals.ensureRunningInner())
    try {
      await expect(internals.ensureRunningInner()).resolves.toBe(32100)
      await daemon.managedUpdatePending
    } finally { setDaemonFileFence('__local__', null) }
    expect(daemon.port).toBe(32200)
    expect(localUpdate).toHaveBeenCalledWith('/fixture/daemon', 'user', { record: { key: `local:${PROD_DAEMON_DIR}`, expected: 'new-version' }, overBusy: late })
    expect(steps).toEqual(late ? ['fence', 'update', 'release'] : ['update'])
  })
})
