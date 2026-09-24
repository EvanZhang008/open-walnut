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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LocalDaemon,
  classifyServiceConfigError,
  classifyServiceTakeover,
  daemonServiceConfigPaths,
  localServiceTakeoverMessage,
  type ServiceTakeover,
} from '../../src/providers/local-daemon.js'

// Stub spawn — the guard's whole job is that this never runs. Everything else in
// node:child_process stays real (constants/logging use it at import time).
const { updateCommand } = vi.hoisted(() => ({ updateCommand: vi.fn() }))
vi.mock('../../src/providers/daemon-service-cli.js', () => ({ runDaemonServiceCommand: updateCommand }))

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

/** Only the listed paths exist; every other stat falls through to the real fs. */
function stubServiceFiles(present: string[], unknown: string[] = []): void {
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
  it('linux config paths cover the user unit AND the system unit', () => {
    expect(daemonServiceConfigPaths('linux', '/home/u')).toEqual([
      '/home/u/.config/systemd/user/open-walnut-daemon.service',
      '/etc/systemd/system/open-walnut-daemon.service',
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
  afterEach(() => { vi.restoreAllMocks(); updateCommand.mockReset() })

  it.each([false, true])('updates through the CLI transaction without direct lifecycle calls (failure=%s)', async (fails) => {
    const daemon = new LocalDaemon({ daemonDir: PROD_DAEMON_DIR, binaryPath: '/fixture/daemon' })
    const internals = daemon as unknown as {
      ensureRunningInner(): Promise<number>
      ping(port: number): Promise<unknown>
      readPortFile(): number
      readBinaryVersion(): string
      updateManagedDaemon(path: string, version: string): Promise<number | null>
      auditOwnerOnAdopt(): void
    }
    vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(internals, 'readPortFile').mockReturnValueOnce(32100).mockReturnValue(32200)
    vi.spyOn(internals, 'ping').mockResolvedValueOnce({ alive: true, version: 'old-version', capabilities: ['cron-supervision-v1'] })
      .mockResolvedValue({ alive: true, version: 'new-version', capabilities: ['cron-supervision-v1'], instanceId: 'new-instance' })
    vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(priv(daemon), 'detectServiceTakeover').mockReturnValue({ managed: true, present: [daemonServiceConfigPaths()[0]], unknown: [] })
    const stop = vi.spyOn(priv(daemon), 'stopDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(daemon), 'spawnDaemon').mockResolvedValue(1234)
    updateCommand.mockResolvedValue(fails ? { code: 1, stderr: 'busy', stdout: '' } : { code: 0, stderr: '', stdout: '{"ok":true}' })
    if (fails) await expect(internals.ensureRunningInner()).rejects.toThrow('Managed daemon update failed')
    else await expect(internals.ensureRunningInner()).resolves.toBe(32200)
    expect(updateCommand).toHaveBeenCalledWith('/fixture/daemon', ['walnut', 'daemon', 'update', '--yes', '--scope', 'user', '--executable', '/fixture/daemon'])
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(await internals.updateManagedDaemon('/fixture/daemon', 'new-version')).toBeNull()
    expect(updateCommand).toHaveBeenCalledTimes(1)
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
