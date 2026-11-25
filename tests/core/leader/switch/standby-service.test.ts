/**
 * The handed-over standby's hold of this machine's session runtime (src/web/standby-service.ts) for a
 * plain server (no service runtime: `walnut web`, the Mac's launchd `web`): its decisions, with the
 * in-process start mocked (the real start runs in switch-stop-sessions.test.ts). A daemon program of
 * its own holds nothing; a declined or failed start is named in the state, never a program in its
 * place; a held runtime stops for good with the standby; and a stop while the hold still starts
 * (its prewarm) closes the runtime first, so nothing is held after the stop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  wanted: true,
  hold: null as null | (() => Promise<{ kind: 'in-process'; url: string } | { kind: 'declined'; why: string }>),
  stops: [] as Array<{ reason: string; budgetMs?: number; forGood?: boolean }>,
  ensureRunning: 0,
}))

vi.mock('../../../../src/providers/in-process-daemon.js', () => ({
  inProcessDaemonWanted: async () => m.wanted,
  stopInProcessDaemon: async (reason: string, budgetMs?: number, opts: { forGood?: boolean } = {}) => { m.stops.push({ reason, budgetMs, forGood: opts.forGood }); return 0 },
  startInProcessDaemon: async () => { throw new Error('a plain server never starts the service runtime') },
}))
vi.mock('../../../../src/providers/local-daemon.js', () => ({
  localDaemon: {
    dir: '/tmp/d',
    holdInProcess: () => m.hold!(),
    // The program path is never taken by the standby.
    ensureRunning: async () => { m.ensureRunning++; return 0 },
  },
}))
vi.mock('../../../../src/web/serve-launcher-beat.js', () => ({ startServeLauncherBeat: () => {}, serveLauncherLeaving: () => {} }))

async function load() {
  vi.resetModules()
  return import('../../../../src/web/standby-service.js')
}

beforeEach(() => {
  m.wanted = true
  m.hold = async () => ({ kind: 'in-process', url: 'in-process://daemon' })
  m.stops = []
  m.ensureRunning = 0
})

describe('a plain server\'s standby and this machine\'s session runtime', () => {
  it('holds the in-process runtime on the local daemon\'s dir, and its stop ends it for good', async () => {
    const s = await load()
    expect(s.standbyRuntimeState()).toBeNull()
    expect(await s.holdServiceRuntimeInStandby(0)).toBe(true)
    expect(s.standbyRuntimeState()).toEqual({ held: 'in-process', dir: '/tmp/d' })
    await s.releaseServiceRuntimeInStandby('leader-switch', 4_000)
    expect(m.stops).toEqual([{ reason: 'leader-switch', budgetMs: 4_000, forGood: true }])
    expect(s.standbyRuntimeState()).toBeNull()
    // A second stop has nothing to stop.
    await s.releaseServiceRuntimeInStandby('again', 4_000)
    expect(m.stops).toHaveLength(1)
    expect(m.ensureRunning).toBe(0)
  })

  it('a daemon program of its own (in_process_daemon off): holds nothing, starts nothing, its stop stops nothing', async () => {
    m.wanted = false
    m.hold = async () => { throw new Error('not asked') }
    const s = await load()
    expect(await s.holdServiceRuntimeInStandby(0)).toBe(false)
    expect(s.standbyRuntimeState()).toMatchObject({ held: false, why: expect.stringMatching(/program of its own/) })
    await s.releaseServiceRuntimeInStandby('stop', 4_000)
    expect(m.stops).toEqual([])
    expect(m.ensureRunning).toBe(0)
  })

  it('a declined or failed start is named in the state, and no daemon program starts in its place', async () => {
    m.hold = async () => ({ kind: 'declined', why: 'another daemon holds the dir (port 1)' })
    let s = await load()
    expect(await s.holdServiceRuntimeInStandby(0)).toBe(false)
    expect(s.standbyRuntimeState()).toEqual({ held: false, why: 'another daemon holds the dir (port 1)' })
    m.hold = async () => { throw new Error('Another Walnut server (pid 7) already runs the session daemon') }
    s = await load()
    expect(await s.holdServiceRuntimeInStandby(0)).toBe(false)
    expect(s.standbyRuntimeState()).toEqual({ held: false, why: 'Another Walnut server (pid 7) already runs the session daemon' })
    expect(m.ensureRunning).toBe(0)
  })

  it('a stop while the hold still starts closes the runtime for good, and the hold then reports nothing held', async () => {
    let finish!: () => void
    m.hold = () => new Promise((resolve) => { finish = () => resolve({ kind: 'in-process', url: 'in-process://daemon' }) })
    const s = await load()
    const hold = s.holdServiceRuntimeInStandby(0)
    await new Promise((r) => setTimeout(r, 10))
    await s.releaseServiceRuntimeInStandby('SIGTERM', 4_000)
    expect(m.stops).toEqual([{ reason: 'SIGTERM', budgetMs: 4_000, forGood: true }])
    finish()
    expect(await hold).toBe(false)
    expect(s.standbyRuntimeState()).toBeNull()
  })
})
