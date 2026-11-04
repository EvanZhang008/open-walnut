/**
 * A daemon this server started to replace another one stays on its probation across a server
 * restart, and keeps the build before it as the way back till it passed (local-daemon.ts with
 * local-daemon-replace.ts StayWatch). 2026-11-04 review 5: the watch lived in the LocalDaemon
 * object, so a server restarted inside it (a deploy) adopted the new build unwatched, and a newer
 * build replaced it inside its window and took the one slot of the build before it.
 *
 * Everything that would touch the machine is a spy: the spawn, the stop, the pid checks, the
 * trial and the keep; the store is a temp file of this case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { log } from '../../src/logging/index.js'
import { guardedPath } from '../setup/exec-guard.js'
import { provenBuilds, stayWatches, updateStoresSettled } from '../../src/providers/daemon-update-store.js'

vi.mock('../../src/providers/daemon-service-cli.js', () => ({ runDaemonServiceCommand: vi.fn() }))
vi.mock('../../src/providers/local-daemon-service.js', () => ({ updateLocalService: vi.fn(), reviveLocalService: vi.fn() }))
const { trial, previousOf, keepSpy, pendSpy, promoteSpy, discardSpy } = vi.hoisted(() => ({
  trial: vi.fn(async (): Promise<string | null> => null), previousOf: vi.fn(async (): Promise<string | null> => null), keepSpy: vi.fn(async (): Promise<boolean> => false),
  pendSpy: vi.fn(async (): Promise<boolean> => true), promoteSpy: vi.fn(async (): Promise<boolean> => true), discardSpy: vi.fn(async (): Promise<void> => {}),
}))
vi.mock('../../src/providers/local-daemon-replace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/local-daemon-replace.js')>()
  const call = (spy: unknown) => async (...a: unknown[]) => (spy as (...x: unknown[]) => unknown)(...a)
  return {
    ...actual,
    trialDaemon: async (...a: unknown[]) => (await (trial as (...x: unknown[]) => unknown)(...a)) ?? null,
    previousDaemon: async (...a: unknown[]) => (await (previousOf as (...x: unknown[]) => unknown)(...a)) ?? null,
    keepRunningBinary: async (...a: unknown[]) => (await (keepSpy as (...x: unknown[]) => unknown)(...a)) ?? false,
    keepPendingBinary: call(pendSpy), promotePending: call(promoteSpy), discardPending: call(discardSpy),
  }
})
vi.mock('../../src/providers/fold-prewarm.js', () => ({ registryNeedsFoldPrewarm: async () => false, runFoldPrewarm: async () => ({ outcome: 'ran', ms: 0 }) }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (() => { throw new Error('no spawn here') }) as unknown as typeof actual.spawn }
})

const realLstat = fs.lstatSync
let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-probation-'))
  process.env.WALNUT_UPDATE_STAY_FILE = path.join(tmpDir, 'stay.json')
  process.env.WALNUT_UPDATE_PROVEN_FILE = path.join(tmpDir, 'proven.json')
  // No service config of this machine's own is seen: this is a daemon the server starts itself.
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    const file = String(target)
    if (file.endsWith('daemon.service') || file.endsWith('.plist') || file.endsWith('daemon-boot.sh')) {
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
    }
    return (realLstat as unknown as (...a: unknown[]) => fs.Stats)(target, ...rest)
  }) as typeof fs.lstatSync)
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log.session, level).mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.WALNUT_UPDATE_STAY_FILE
  delete process.env.WALNUT_UPDATE_PROVEN_FILE
  previousOf.mockReset().mockResolvedValue(null)
  keepSpy.mockClear()
  for (const spy of [pendSpy, promoteSpy, discardSpy]) spy.mockClear()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type Internals = {
  ensureRunningInner(): Promise<number>; readBinaryVersion(): string; readPortFile(): number | null; ping(port: number): Promise<unknown>
  readAcpBusySids(): string[]; auditOwnerOnAdopt(): void; scheduleUpgradeRecheck(): void; buildSpawnEnv(): Promise<NodeJS.ProcessEnv>; writeOwnerStamp(): void
  stopDaemon(): Promise<void>; spawnDaemon(file: string): Promise<number>; isPidAlive(pid: number): boolean; readPidFile(): number | null
}

/** A daemon of this server's own dir (the companion's kind: persistent), every lifecycle call a spy. */
function daemonOn(running: string, expected: string) {
  const daemon = new LocalDaemon({ daemonDir: tmpDir, persistent: true, binaryPath: path.join(tmpDir, 'bin', 'daemon-new') })
  const i = daemon as unknown as Internals
  vi.spyOn(i, 'readBinaryVersion').mockReturnValue(expected)
  vi.spyOn(i, 'readPortFile').mockReturnValue(32100)
  const ping = vi.spyOn(i, 'ping').mockResolvedValue({ alive: true, version: running, capabilities: [] })
  vi.spyOn(i, 'readAcpBusySids').mockReturnValue([])
  vi.spyOn(i, 'auditOwnerOnAdopt').mockImplementation(() => {})
  vi.spyOn(i, 'writeOwnerStamp').mockImplementation(() => {})
  vi.spyOn(i, 'buildSpawnEnv').mockResolvedValue({ PATH: guardedPath([], '/usr/bin:/bin') })
  const recheck = vi.spyOn(i, 'scheduleUpgradeRecheck').mockImplementation(() => {})
  const stop = vi.spyOn(i, 'stopDaemon').mockResolvedValue(undefined)
  const start = vi.spyOn(i, 'spawnDaemon').mockResolvedValue(32400)
  vi.spyOn(daemon, 'ensureRunning').mockResolvedValue(32100)
  vi.spyOn(i, 'readPidFile').mockReturnValue(7001)
  const alive = vi.spyOn(i, 'isPidAlive').mockReturnValue(true)
  const trialDone = async () => { await (daemon as unknown as { _gate: { pending: Promise<void> } })._gate.pending; await new Promise((r) => setTimeout(r, 0)) }
  const stay = (daemon as unknown as { _stay: { clear(): void; watching(e: string): boolean; watched: { at: number } | null } })._stay
  return { daemon, i, ping, recheck, stop, start, alive, trialDone, stay }
}

/** The build before the update, kept to go back to. */
function keptPrevious(): string {
  const keep = path.join(tmpDir, 'previous')
  fs.mkdirSync(keep, { recursive: true })
  fs.writeFileSync(path.join(keep, 'daemon-new'), 'old build', { mode: 0o755 })
  fs.writeFileSync(path.join(keep, 'daemon-new.version'), 'old-version\n')
  return path.join(keep, 'daemon-new')
}

describe('the probation of a local replacement', () => {
  it('a server restarted inside it still judges the new daemon: gone, it is refused and the build before it starts', async () => {
    const previous = keptPrevious()
    previousOf.mockResolvedValue(previous)
    // The server before the restart replaced the old daemon, and its watch began.
    const first = daemonOn('old-version', 'new-version')
    vi.spyOn(first.daemon, 'pid', 'get').mockReturnValue(7001)
    await expect(first.i.ensureRunningInner()).resolves.toBe(32100)
    await first.trialDone()
    await expect(first.i.ensureRunningInner()).resolves.toBe(32400)
    expect(first.stay.watching('new-version')).toBe(true)
    // Written before the stop with no pid, then with the new daemon's.
    await vi.waitFor(() => expect(JSON.stringify(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_STAY_FILE!, 'utf8')))).toContain('"expected":"new-version","pid":7001'))
    // A deploy restarts the server; the new daemon died while no server ran.
    const restarted = daemonOn('new-version', 'new-version')
    restarted.alive.mockReturnValue(false)
    restarted.ping.mockResolvedValue({ alive: false })
    vi.spyOn(restarted.i, 'readPortFile').mockReturnValue(null)
    await expect(restarted.i.ensureRunningInner()).resolves.toBe(32400)
    expect(restarted.start.mock.calls.map(([file]) => file)).toEqual([previous])
    const gate = (restarted.daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate
    expect(gate.refusal('new-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
    first.stay.clear()
    restarted.stay.clear()
  })

  it('a newer build waits while the running one is on its probation: the build before it stays the way back', async () => {
    const previous = keptPrevious()
    previousOf.mockResolvedValue(previous)
    const d = daemonOn('old-version', 'mid-version')
    vi.spyOn(d.daemon, 'pid', 'get').mockReturnValue(7001)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32100)
    await d.trialDone()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.stay.watching('mid-version')).toBe(true)
    // A deploy brings a newer build within the window.
    vi.spyOn(d.i, 'readBinaryVersion').mockReturnValue('new-version')
    d.ping.mockResolvedValue({ alive: true, version: 'mid-version', capabilities: [] })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(32400)
    trial.mockClear()
    previousOf.mockClear()
    d.stop.mockClear()
    d.recheck.mockClear()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(trial).not.toHaveBeenCalled()
    expect(previousOf).not.toHaveBeenCalled()
    expect(d.stop).not.toHaveBeenCalled()
    expect(d.recheck).toHaveBeenCalledTimes(1)
    expect(keepSpy).not.toHaveBeenCalled()
    d.stay.clear()
  })

  /** A replacement of old-version by new-version: started, on its probation. */
  async function replaced() {
    keptPrevious()
    previousOf.mockResolvedValue(path.join(tmpDir, 'previous', 'daemon-new'))
    const d = daemonOn('old-version', 'new-version')
    vi.spyOn(d.daemon, 'pid', 'get').mockReturnValue(7001)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32100)
    await d.trialDone()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.stay.watching('new-version')).toBe(true)
    return d
  }

  // 2026-11-04 review 6: the build was kept only at its window's end, from the file on disk, which a
  // deploy inside the window had replaced: the way back silently became the build before it.
  it('the file of the build on its probation is kept at its start, and becomes the way back once it passed, whatever the file on disk is then', async () => {
    const d = await replaced()
    expect(pendSpy).toHaveBeenCalledWith(expect.objectContaining({ binaryPath: path.join(tmpDir, 'bin', 'daemon-new'), version: 'new-version' }))
    // A deploy put a newer build on disk; the window ends.
    vi.spyOn(d.i, 'readBinaryVersion').mockReturnValue('newer-version')
    d.ping.mockResolvedValue({ alive: true, version: 'new-version', capabilities: [] })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(32400)
    d.stay.watched!.at -= 20 * 60_000
    await d.i.ensureRunningInner()
    await vi.waitFor(() => expect(promoteSpy).toHaveBeenCalledWith(tmpDir, 'new-version'))
    expect(discardSpy).not.toHaveBeenCalled()
    expect(d.stay.watching('new-version')).toBe(false)
  })

  it('one gone inside its window: its kept file is dropped, never made the way back', async () => {
    const d = await replaced()
    d.alive.mockReturnValue(false)
    d.ping.mockResolvedValue({ alive: false })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
    await d.i.ensureRunningInner()
    await vi.waitFor(() => expect(discardSpy).toHaveBeenCalledWith(tmpDir, 'new-version'))
    expect(promoteSpy).not.toHaveBeenCalled()
    d.stay.clear()
  })

  // 2026-11-04 review 6: any end of its pid inside the window was its failure, a replacement by
  // another Walnut on the same daemon dir included, and the build was refused for a day.
  it('one replaced inside its window by a daemon of another build (another Walnut on this dir) is no failure of its build', async () => {
    const d = await replaced()
    d.alive.mockReturnValue(false)
    d.ping.mockResolvedValue({ alive: true, version: 'other-walnut-version', capabilities: [] })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(32500)
    const gate = (d.daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate
    await (d.daemon as unknown as { settleStay(): Promise<boolean> }).settleStay()
    expect(gate.refusal('new-version')).toBeNull()
    expect(d.stay.watching('new-version')).toBe(false)
    expect(discardSpy).toHaveBeenCalledWith(tmpDir, 'new-version')
  })

  // 2026-11-04 review 6: the source daemon's files of a build on its probation took the way back's
  // place when the next build's were written.
  it('the source daemon\'s files of a build on its probation wait beside the way back when the next build is written', async () => {
    const dir = path.join(tmpDir, 'src-daemon')
    fs.mkdirSync(dir, { recursive: true })
    const daemon = new LocalDaemon({ daemonDir: dir })
    const ld = daemon as unknown as { _stay: { start(e: string, p: number | null, due: () => void): void; clear(): void }; materializeSourceDaemon(): Promise<string>; keepsDurable: boolean }
    fs.writeFileSync(path.join(dir, 'daemon-fallback.cjs'), 'source of B')
    fs.writeFileSync(path.join(dir, 'daemon-fallback.cjs.version'), 'B')
    fs.writeFileSync(path.join(dir, 'daemon-fallback.cjs.sha256'), 'not-this-one')
    fs.writeFileSync(path.join(dir, 'daemon.version'), 'B')
    ld._stay.start('B', 7001, () => {})
    try {
      await ld.materializeSourceDaemon()
      const beside = path.join(dir, 'previous')
      const keep = ld.keepsDurable ? (await import('../../src/providers/local-daemon-replace.js')).previousKeepDir(dir) : beside
      expect(fs.readFileSync(path.join(`${keep}.next`, 'daemon-fallback.cjs'), 'utf8')).toBe('source of B')
      expect(fs.existsSync(path.join(keep, 'daemon-fallback.cjs'))).toBe(false)
      expect(fs.readFileSync(path.join(dir, 'daemon-fallback.cjs'), 'utf8')).not.toBe('source of B')
    } finally { ld._stay.clear() }
  })

  // 2026-11-04 review 7: a daemon found gone only long past its window ended the watch with no
  // verdict, so its next start was not watched, and on a Mac kept its file over the way back.
  it('a server back hours after the new daemon died watches its next start anew: no refusal, nothing kept at the start', async () => {
    keptPrevious()
    // The watch a server before this one kept: the replacement 3 h ago, in this boot, its pid gone.
    await stayWatches.write(`local:${tmpDir}`, { expected: 'new-version', pid: 6001, at: Date.now() - 3 * 3600_000, bootAt: Date.now() - os.uptime() * 1000 })
    const d = daemonOn('new-version', 'new-version')
    d.alive.mockImplementation((pid: number) => pid === 7002)
    d.ping.mockResolvedValue({ alive: false })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
    vi.spyOn(d.daemon, 'pid', 'get').mockReturnValue(7002)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    const gate = (d.daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate
    expect(gate.refusal('new-version')).toBeNull()
    expect(d.stay.watching('new-version')).toBe(true)
    expect(keepSpy).not.toHaveBeenCalled()
    expect(discardSpy).not.toHaveBeenCalled()
    // The start that followed is the one watched: gone inside its window, it is refused.
    d.alive.mockReturnValue(false)
    await (d.daemon as unknown as { settleStay(): Promise<boolean> }).settleStay()
    expect(gate.refusal('new-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
  })
})

const stayOnDisk = () => JSON.stringify(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_STAY_FILE!, 'utf8')))
const gateOf = (daemon: LocalDaemon) => (daemon as unknown as { _gate: { refusal(e: string): string | null } })._gate

// 2026-11-05 review 6: with no daemon running, the build on disk was started as if it had served
// here: unwatched, kept at once (on a Mac over the way back), and after a failed probation it was a
// newer build deployed inside the window, untried, instead of the build that ran before.
describe('a start with no daemon running', () => {
  it('after a probation failed, it is the kept build that ran before, never a newer build deployed inside the window; that one replaces it after its trial', async () => {
    const previous = keptPrevious()
    previousOf.mockResolvedValue(previous)
    const d = daemonOn('old-version', 'mid-version')
    vi.spyOn(d.daemon, 'pid', 'get').mockReturnValue(7001)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32100)
    await d.trialDone()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.stay.watching('mid-version')).toBe(true)
    // A deploy brings a newer build within the window: deferred while mid is on its probation.
    vi.spyOn(d.i, 'readBinaryVersion').mockReturnValue('new-version')
    d.ping.mockResolvedValue({ alive: true, version: 'mid-version', capabilities: [] })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(32400)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    // mid dies inside its window.
    d.alive.mockReturnValue(false)
    d.ping.mockResolvedValue({ alive: false })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
    d.start.mockClear(); trial.mockClear(); keepSpy.mockClear(); pendSpy.mockClear(); d.recheck.mockClear()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(gateOf(d.daemon).refusal('mid-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
    expect(d.start.mock.calls.map(([file]) => file)).toEqual([previous])
    expect(trial).not.toHaveBeenCalled()
    expect(d.stay.watching('new-version')).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(keepSpy).not.toHaveBeenCalled()
    expect(pendSpy).not.toHaveBeenCalled()
    // The build on disk is asked again on the upgrade clock.
    expect(d.recheck).toHaveBeenCalled()
    // The old build serves again: the new one replaces it the normal way, its trial first, then watched.
    d.alive.mockReturnValue(true)
    d.ping.mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(32400)
    d.start.mockClear()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.start).not.toHaveBeenCalled()
    await d.trialDone()
    expect(trial).toHaveBeenCalledTimes(1)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new')])
    expect(d.stay.watching('new-version')).toBe(true)
    expect(keepSpy).not.toHaveBeenCalled()
    d.stay.clear()
  })

  it('of a build that never stayed serving here is a replacement: watched, nothing kept until it passed, and gone in its window the kept build follows', async () => {
    const previous = keptPrevious()
    const d = daemonOn('unused', 'new-version')
    d.ping.mockResolvedValue({ alive: false })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
    vi.spyOn(d.daemon, 'pid', 'get').mockReturnValue(7002)
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new')])
    expect(trial).not.toHaveBeenCalled()
    expect(d.stay.watching('new-version')).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(keepSpy).not.toHaveBeenCalled()
    expect(pendSpy).toHaveBeenCalledWith(expect.objectContaining({ version: 'new-version' }))
    // It dies inside its window: refused, and the build that ran before starts.
    d.alive.mockReturnValue(false)
    d.start.mockClear()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(gateOf(d.daemon).refusal('new-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
    expect(d.start.mock.calls.map(([file]) => file)).toEqual([previous])
  })

  // 2026-11-05 review 6b: that one failed start (load at login, a slow hello) held the build a day
  // on disk, though a cold start runs no trial: the rule is for a build that passed one.
  it('of a build that never stayed serving here and does not start at all: the kept build starts, and the build is held only as a failed trial is', async () => {
    const previous = keptPrevious()
    process.env.WALNUT_BUILD_BACKOFF_FILE = path.join(tmpDir, 'backoff.json')
    try {
      const d = daemonOn('unused', 'new-version')
      d.ping.mockResolvedValue({ alive: false })
      vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
      d.start.mockRejectedValueOnce(new Error('started but not responding to hello'))
      await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
      expect(d.start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new'), previous])
      expect(gateOf(d.daemon).refusal('new-version')).toMatch(/did not start on the real dir/)
      expect((d.daemon as unknown as { _gate: { refused: { untilNewBuild: boolean } } })._gate.refused.untilNewBuild).toBe(false)
      expect(d.stay.watching('new-version')).toBe(false)
      await updateStoresSettled()
      expect(fs.existsSync(process.env.WALNUT_BUILD_BACKOFF_FILE)).toBe(false)
      // The next start inside that hold is the kept build again; after it, the build's own trial decides.
      d.start.mockClear()
      await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
      expect(d.start.mock.calls.map(([file]) => file)).toEqual([previous])
    } finally { delete process.env.WALNUT_BUILD_BACKOFF_FILE }
  })

  // 2026-11-05 review 6b: the cold start's watch was written only after the spawn, so a server killed
  // while the new daemon started left the next one to adopt it unwatched, proven, kept over the way back.
  it('of a build that never stayed serving here: its watch is on disk before it starts, and a server killed meanwhile leaves it watched', async () => {
    keptPrevious()
    const d = daemonOn('unused', 'new-version')
    d.ping.mockResolvedValue({ alive: false })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
    let atSpawn = ''
    // The server is killed while it waits for the new daemon's hello.
    d.start.mockImplementation(() => { atSpawn = stayOnDisk(); return new Promise(() => {}) })
    void d.i.ensureRunningInner()
    await vi.waitFor(() => expect(d.start).toHaveBeenCalled())
    expect(atSpawn).toContain('"expected":"new-version","pid":null')
    // The next server finds it serving: still on its probation, its pid named now; not kept, not proven.
    const next = daemonOn('new-version', 'new-version')
    vi.spyOn(next.i, 'readPidFile').mockReturnValue(7006)
    keepSpy.mockClear()
    await expect(next.i.ensureRunningInner()).resolves.toBe(32100)
    expect(next.stay.watching('new-version')).toBe(true)
    await vi.waitFor(() => expect(stayOnDisk()).toContain('"pid":7006'))
    await new Promise((r) => setTimeout(r, 20))
    expect(keepSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(process.env.WALNUT_UPDATE_PROVEN_FILE!)).toBe(false)
    d.stay.clear()
    next.stay.clear()
  })

  it('of a build proven here (it passed, or served with no probation) is a plain start: not watched, kept as it serves', async () => {
    keptPrevious()
    // Found serving with no probation running: vouched for, on disk.
    const first = daemonOn('new-version', 'new-version')
    await expect(first.i.ensureRunningInner()).resolves.toBe(32100)
    await vi.waitFor(() => expect(fs.readFileSync(process.env.WALNUT_UPDATE_PROVEN_FILE!, 'utf8')).toContain('"expected": "new-version"'))
    // A reboot later (a new server): no daemon runs.
    const d = daemonOn('unused', 'new-version')
    d.ping.mockResolvedValue({ alive: false })
    vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
    keepSpy.mockClear(); pendSpy.mockClear()
    await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
    expect(d.start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new')])
    expect(d.stay.watching('new-version')).toBe(false)
    await vi.waitFor(() => expect(keepSpy).toHaveBeenCalledWith(expect.objectContaining({ version: 'new-version' })))
    expect(pendSpy).not.toHaveBeenCalled()
    // A build that passed its watch is proven the same way.
    await provenBuilds.write(`local:${tmpDir}`, null)
    const other = daemonOn('unused', 'passed-version')
    const stay = (other.daemon as unknown as { _stay: { start(e: string, p: number | null, due: () => void): Promise<void>; settle(alive: (pid: number) => boolean): unknown; watched: { at: number } | null } })._stay
    await stay.start('passed-version', 7001, () => {})
    stay.watched!.at -= 20 * 60_000
    stay.settle(() => true)
    await vi.waitFor(() => expect(fs.readFileSync(process.env.WALNUT_UPDATE_PROVEN_FILE!, 'utf8')).toContain('"expected": "passed-version"'))
  })

  // 2026-11-05 review 6: nothing was on disk between the old daemon's stop and the new one's watch,
  // so a server killed in between left the next one to adopt the new build unwatched.
  it('the new build\'s watch is on disk before the old daemon stops, and the next server takes it up at its adopt', async () => {
    const previous = keptPrevious()
    previousOf.mockResolvedValue(previous)
    const d = daemonOn('old-version', 'new-version')
    let atStop = ''
    d.stop.mockImplementation(async () => { atStop = stayOnDisk() })
    await expect(d.i.ensureRunningInner()).resolves.toBe(32100)
    await d.trialDone()
    // The server is killed right after the stop: the new daemon never started.
    d.start.mockImplementation(() => new Promise(() => {}))
    void d.i.ensureRunningInner()
    await vi.waitFor(() => expect(d.stop).toHaveBeenCalled())
    expect(atStop).toContain('"expected":"new-version","pid":null')
    // The next server finds the new daemon serving (started by the killed one at the last moment):
    // still on its probation, its pid named now; not kept, not proven.
    const next = daemonOn('new-version', 'new-version')
    vi.spyOn(next.i, 'readPidFile').mockReturnValue(7005)
    keepSpy.mockClear()
    await expect(next.i.ensureRunningInner()).resolves.toBe(32100)
    expect(next.stay.watching('new-version')).toBe(true)
    await vi.waitFor(() => expect(stayOnDisk()).toContain('"pid":7005'))
    await new Promise((r) => setTimeout(r, 20))
    expect(keepSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(process.env.WALNUT_UPDATE_PROVEN_FILE!)).toBe(false)
    d.stay.clear()
    next.stay.clear()
  })
})

// 2026-11-05 review 7: two things a server restart lost between one step and the next.
describe('a server restarted between the steps of a probation', () => {
  it('a watch with no pid yet is claimed by the next server even with a newer build on disk, so the watched daemon\'s death is still its failure', async () => {
    const previous = keptPrevious()
    previousOf.mockResolvedValue(previous)
    const d = daemonOn('old-version', 'mid-version')
    await expect(d.i.ensureRunningInner()).resolves.toBe(32100)
    await d.trialDone()
    // The server is killed after the stop, while the new daemon starts: the watch has no pid.
    d.start.mockImplementation(() => new Promise(() => {}))
    void d.i.ensureRunningInner()
    await vi.waitFor(() => expect(d.start).toHaveBeenCalled())
    expect(stayOnDisk()).toContain('"expected":"mid-version","pid":null')
    // The next server has a newer build on disk and finds mid serving: held for mid's probation,
    // and mid's pid is named now.
    const next = daemonOn('mid-version', 'new-version')
    vi.spyOn(next.i, 'readPidFile').mockReturnValue(7008)
    await expect(next.i.ensureRunningInner()).resolves.toBe(32100)
    expect(next.stay.watching('mid-version')).toBe(true)
    expect(next.start).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(stayOnDisk()).toContain('"expected":"mid-version","pid":7008'))
    // mid dies inside its window: refused, and the build before it starts, not the untried newer one.
    next.alive.mockReturnValue(false)
    next.ping.mockResolvedValue({ alive: false })
    vi.spyOn(next.i, 'readPortFile').mockReturnValue(null)
    await expect(next.i.ensureRunningInner()).resolves.toBe(32400)
    expect(gateOf(next.daemon).refusal('mid-version')).toMatch(/stopped within \d+ s after it started on the real dir/)
    expect(next.start.mock.calls.map(([file]) => file)).toEqual([previous])
    d.stay.clear()
    next.stay.clear()
  })

  // 2026-11-05 review 8: past its window a watch passed on any live process under its pid, and the
  // pass proved the build: a build that had died started plain and unwatched from then on.
  it('a watch resumed past its window passes only on its build answering: a pid another process has now proves nothing', async () => {
    keptPrevious()
    const first = daemonOn('unused', 'new-version')
    first.ping.mockResolvedValue({ alive: false })
    vi.spyOn(first.i, 'readPortFile').mockReturnValue(null)
    vi.spyOn(first.daemon, 'pid', 'get').mockReturnValue(7001)
    await expect(first.i.ensureRunningInner()).resolves.toBe(32400)
    await updateStoresSettled()
    // The server is away past the window, in the same boot; the daemon died, and pid 7001 is another process's now.
    const pastWindow = () => {
      const rec = JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_STAY_FILE!, 'utf8')) as Record<string, { at: number; pid: number | null }>
      for (const k of Object.keys(rec)) { rec[k].at -= 20 * 60_000; rec[k].pid = 7001 }
      return JSON.stringify(rec)
    }
    const kept = pastWindow()
    first.stay.clear()
    await updateStoresSettled()
    fs.writeFileSync(process.env.WALNUT_UPDATE_STAY_FILE!, kept)
    const next = daemonOn('unused', 'new-version')
    next.ping.mockResolvedValue({ alive: false })
    vi.spyOn(next.i, 'readPortFile').mockReturnValue(null)
    keepSpy.mockClear(); promoteSpy.mockClear()
    await expect(next.i.ensureRunningInner()).resolves.toBe(32400)
    await new Promise((r) => setTimeout(r, 50))
    // Not passed, not proven, nothing kept: the start that follows is watched again.
    expect(fs.existsSync(process.env.WALNUT_UPDATE_PROVEN_FILE!)).toBe(false)
    expect(promoteSpy).not.toHaveBeenCalled()
    expect(keepSpy).not.toHaveBeenCalled()
    expect(next.stay.watching('new-version')).toBe(true)
    next.stay.clear()
    await updateStoresSettled()
    // The same watch with its build answering on the port passes, and proves it.
    fs.writeFileSync(process.env.WALNUT_UPDATE_STAY_FILE!, kept)
    const third = daemonOn('new-version', 'new-version')
    await expect(third.i.ensureRunningInner()).resolves.toBe(32100)
    await vi.waitFor(() => expect(fs.readFileSync(process.env.WALNUT_UPDATE_PROVEN_FILE!, 'utf8')).toContain('"expected": "new-version"'))
    expect(third.stay.watching('new-version')).toBe(false)
    expect(promoteSpy).toHaveBeenCalledWith(tmpDir, 'new-version')
  })

  it('a deploy restart between a failed probation and the next start still starts the build that ran before, not the newer build on disk', async () => {
    process.env.WALNUT_BUILD_BACKOFF_FILE = path.join(tmpDir, 'backoff.json')
    try {
      const previous = keptPrevious()
      previousOf.mockResolvedValue(previous)
      const d = daemonOn('old-version', 'mid-version')
      vi.spyOn(d.daemon, 'pid', 'get').mockReturnValue(7001)
      await expect(d.i.ensureRunningInner()).resolves.toBe(32100)
      await d.trialDone()
      await expect(d.i.ensureRunningInner()).resolves.toBe(32400)
      expect(d.stay.watching('mid-version')).toBe(true)
      // mid dies inside its window and is refused; the server is restarted before it starts anything.
      d.alive.mockReturnValue(false)
      d.ping.mockResolvedValue({ alive: false })
      vi.spyOn(d.i, 'readPortFile').mockReturnValue(null)
      await expect((d.daemon as unknown as { settleStay(): Promise<boolean> }).settleStay()).resolves.toBe(true)
      await updateStoresSettled()
      expect(fs.readFileSync(process.env.WALNUT_BUILD_BACKOFF_FILE, 'utf8')).toContain('mid-version')
      // The next server: a newer build on disk, no daemon running.
      const next = daemonOn('unused', 'new-version')
      next.ping.mockResolvedValue({ alive: false })
      vi.spyOn(next.i, 'readPortFile').mockReturnValue(null)
      trial.mockClear()
      await expect(next.i.ensureRunningInner()).resolves.toBe(32400)
      expect(next.start.mock.calls.map(([file]) => file)).toEqual([previous])
      expect(next.stay.watching('new-version')).toBe(false)
      expect(trial).not.toHaveBeenCalled()
      // The newer build comes after its trial, on the upgrade clock.
      expect(next.recheck).toHaveBeenCalled()
      // A daemon this server saw serving since: the refusal on disk asks for no way back any more.
      next.ping.mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
      next.alive.mockReturnValue(true)
      vi.spyOn(next.i, 'readPortFile').mockReturnValue(32400)
      await expect(next.i.ensureRunningInner()).resolves.toBe(32400)
      next.ping.mockResolvedValue({ alive: false })
      vi.spyOn(next.i, 'readPortFile').mockReturnValue(null)
      next.start.mockClear()
      await expect(next.i.ensureRunningInner()).resolves.toBe(32400)
      expect(next.start.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'bin', 'daemon-new')])
      expect(next.stay.watching('new-version')).toBe(true)
      d.stay.clear()
      next.stay.clear()
    } finally { delete process.env.WALNUT_BUILD_BACKOFF_FILE }
  })
})
