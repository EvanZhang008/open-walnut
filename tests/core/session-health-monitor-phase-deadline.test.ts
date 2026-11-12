/**
 * Every awaited phase of a health-monitor tick runs under a deadline.
 *
 * 2026-11-12: ticks of 14, 29 and 52 minutes. The tick budget is only checked
 * BETWEEN phases, so one phase waiting on a slow host (stream tail reads over a
 * choked link) held the whole tick, and with it the 30s snapshot pull that would
 * have settled a dead remote CLI. Meanwhile the capacity check kept finding that
 * CLI dead and logged "fixing stale records" every 5 seconds (157 in an hour).
 *
 * The class: an `await this.<phase>(...)` in checkInner that is not wrapped in
 * `this.phase(...)`. The ratchet below enumerates them from the source, so a new
 * phase added bare fails here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: () => null,
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: {} }),
}))
vi.mock('../../src/core/task-manager.js', () => ({
  clearSessionSlot: async (taskId: string, sessionId: string) => ({
    task: { id: taskId, session_id: sessionId, title: 'mock task' },
  }),
  listTasks: async () => [],
  listTasksByIds: async () => [],
  queryTasksSlim: async () => [],
  getTask: async () => { throw new Error('no task') },
}))

import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import { bus } from '../../src/core/event-bus.js'
import { log } from '../../src/logging/index.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import type { TickContext } from '../../src/core/periodic-task.js'

const SOURCE = path.resolve(__dirname, '../../src/core/session-health-monitor.ts')

/** Awaited calls in checkInner that need no deadline, each with its reason. */
const UNBOUNDED_OK: Record<string, string> = {
  phase: 'the deadline wrapper itself',
  outputFileHasResult: 'reads 8 KB of a local file',
}

function checkInnerBody(src: string): string {
  const start = src.indexOf('  private async checkInner(')
  expect(start).toBeGreaterThan(0)
  // The next method at class indentation ends the body.
  const rest = src.slice(start + 1)
  const end = rest.search(/\n  (?:private |async |public )?(?:async )?[a-zA-Z]+[(<]/)
  return rest.slice(0, end)
}

type MonitorInternals = {
  phase<T>(name: string, ctx: TickContext, skipped: T, run: () => Promise<T>): Promise<T>
  phasesInFlight: Map<string, number>
  phaseStuckWarnedAt: Map<string, number>
  checkInner(ctx: TickContext): Promise<void>
}

const ctxAt = (elapsed: () => number): TickContext => ({
  elapsedMs: elapsed,
  overBudget: () => elapsed() > 20_000,
})

describe('health monitor: every awaited phase has a deadline (ratchet)', () => {
  it('checkInner awaits no method of its own outside this.phase()', () => {
    const body = checkInnerBody(fs.readFileSync(SOURCE, 'utf8'))
    const bare = [...body.matchAll(/await\s+this\.(\w+)\s*(?:<[^>]*>)?\(/g)].map((m) => m[1])
      .filter((name) => !(name in UNBOUNDED_OK))
    expect(bare).toEqual([])
    // No phase awaited through a batch either (Promise.all over this.<method>).
    expect(body).not.toMatch(/Promise\.(?:all|allSettled|race)\([^;]*this\.\w+\(/)
    // The wrapper is really used, and on the phases this incident was about.
    for (const name of ['snapshotPull', 'reconcileStuck', 'hungSessions', 'idleTimeout', 'liveLimit', 'taskPhases']) {
      expect(body).toContain(`this.phase('${name}'`)
    }
  })
})

describe('health monitor: phase()', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns the phase result when it settles in time, and rethrows its error', async () => {
    const m = new SessionHealthMonitor() as unknown as MonitorInternals
    const ctx = ctxAt(() => 0)
    expect(await m.phase('a', ctx, 'skipped', async () => 'done')).toBe('done')
    await expect(m.phase('b', ctx, 'skipped', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(m.phasesInFlight.size).toBe(0)
  })

  it('stops waiting at the deadline, skips the phase while it still runs, and runs it again once it settles', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(log.session, 'info').mockImplementation(() => {})
    const m = new SessionHealthMonitor() as unknown as MonitorInternals
    let release!: () => void
    const stuck = new Promise<Set<string>>((resolve) => { release = () => resolve(new Set(['late'])) })
    const runs = vi.fn(() => stuck)

    const first = m.phase('reconcileStuck', ctxAt(() => 0), new Set<string>(), runs)
    // Deadline at elapsed 0: the 20s budget plus 15s of grace.
    await vi.advanceTimersByTimeAsync(34_999)
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect([...(await first)]).toEqual([]) // the skipped value, not the late result
    expect(warn.mock.calls.some(([msg, data]) => msg === 'health monitor: phase overran its deadline, the tick moves on'
      && (data as { phase?: string }).phase === 'reconcileStuck')).toBe(true)
    expect(m.phasesInFlight.has('reconcileStuck')).toBe(true)

    // Next tick: the phase is still running, so it is not started a second time.
    const next = vi.fn(async () => new Set(['x']))
    expect([...(await m.phase('reconcileStuck', ctxAt(() => 0), new Set<string>(), next))]).toEqual([])
    expect(next).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(m.phasesInFlight.size).toBe(0)
    expect(info.mock.calls.some(([msg]) => msg === 'health monitor: overrun phase finished')).toBe(true)
    expect([...(await m.phase('reconcileStuck', ctxAt(() => 0), new Set<string>(), next))]).toEqual(['x'])
    expect(runs).toHaveBeenCalledTimes(1)
  })

  it('warns again every 5 min while skipped, and gives up after 15 min so the phase runs again', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const m = new SessionHealthMonitor() as unknown as MonitorInternals
    const never = () => new Promise<string>(() => {})
    const p = m.phase('idleTimeout', ctxAt(() => 0), 'skipped', never)
    await vi.advanceTimersByTimeAsync(36_000)
    expect(await p).toBe('skipped')
    const stillRunning = () => warn.mock.calls.filter(([msg]) => msg === 'health monitor: overrun phase still running, skipped again').length

    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await m.phase('idleTimeout', ctxAt(() => 0), 'skipped', never)
    expect(stillRunning()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await m.phase('idleTimeout', ctxAt(() => 0), 'skipped', never)
    expect(stillRunning()).toBe(1)
    await m.phase('idleTimeout', ctxAt(() => 0), 'skipped', never)
    expect(stillRunning()).toBe(1)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const fresh = vi.fn(async () => 'ran')
    expect(await m.phase('idleTimeout', ctxAt(() => 0), 'skipped', fresh)).toBe('ran')
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(error.mock.calls.some(([msg]) => msg === 'health monitor: overrun phase given up on, it runs again')).toBe(true)
    expect(m.phasesInFlight.size).toBe(0)
  })

  it('a phase that fails after its deadline is logged, never an unhandled rejection', async () => {
    vi.useFakeTimers()
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const m = new SessionHealthMonitor() as unknown as MonitorInternals
      let fail!: () => void
      const late = new Promise<void>((_, reject) => { fail = () => reject(new Error('host gone')) })
      const p = m.phase('pendingBgTasks', ctxAt(() => 0), undefined, () => late)
      await vi.advanceTimersByTimeAsync(40_000)
      await p
      fail()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
      await late.catch(() => {})
      // An unhandled rejection is reported after the microtask queue drains.
      await new Promise((r) => setImmediate(r))
      expect(onUnhandled).not.toHaveBeenCalled()
      expect(m.phasesInFlight.size).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('the deadline shrinks with the budget left, never below the floor', async () => {
    vi.useFakeTimers()
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const m = new SessionHealthMonitor() as unknown as MonitorInternals
    // 18s into the tick: 5s floor (budget left is 2s) plus 15s grace = 20s.
    const p = m.phase('taskPhases', ctxAt(() => 18_000), 'skipped', () => new Promise<string>(() => {}))
    await vi.advanceTimersByTimeAsync(19_999)
    expect(m.phasesInFlight.size).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(await p).toBe('skipped')
  })
})

describe('health monitor: a tick with an overrun phase in flight', () => {
  beforeEach(async () => {
    closeDb()
    _resetSessionTrackerForTesting()
    bus.clear()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    closeDb()
    _resetSessionTrackerForTesting()
    bus.clear()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  })

  it('still runs the snapshot pull, and none of the phases that read each other', async () => {
    const sid = 'hm-phase-in-flight'
    await createSessionRecord(sid, '', 'proj', '/Users/test/hm-phase', { pid: process.pid })
    await updateSessionRecord(sid, { process_status: 'running' })

    const monitor = new SessionHealthMonitor()
    const m = monitor as unknown as MonitorInternals & Record<string, unknown>
    m.phasesInFlight.set('reconcileStuck', Date.now())
    const pull = vi.spyOn(m as never, 'checkSnapshotPull' as never).mockImplementation((async () => {}) as never)
    const reconcile = vi.spyOn(m as never, 'reconcileStuckRunningSessions' as never)
    const hung = vi.spyOn(m as never, 'checkHungSessions' as never)
    const idle = vi.spyOn(m as never, 'checkIdleTimeout' as never)
    const phases = vi.spyOn(m as never, 'reconcileTaskPhases' as never)

    await m.checkInner(ctxAt(() => 0))

    expect(pull).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(hung).not.toHaveBeenCalled()
    expect(idle).not.toHaveBeenCalled()
    expect(phases).not.toHaveBeenCalled()

    // Once it settles, the next tick runs every phase again.
    m.phasesInFlight.clear()
    await m.checkInner(ctxAt(() => 0))
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(phases).toHaveBeenCalledTimes(1)
  })

  it('an overrun of a phase the others do not read (pendingBgTasks) holds nothing back', async () => {
    const sid = 'hm-phase-independent'
    await createSessionRecord(sid, '', 'proj', '/Users/test/hm-phase', { pid: process.pid })
    await updateSessionRecord(sid, { process_status: 'running' })
    const monitor = new SessionHealthMonitor()
    const m = monitor as unknown as MonitorInternals & Record<string, unknown>
    m.phasesInFlight.set('pendingBgTasks', Date.now())
    vi.spyOn(m as never, 'checkSnapshotPull' as never).mockImplementation((async () => {}) as never)
    const bg = vi.spyOn(m as never, 'reconcilePendingBackgroundTasks' as never)
    const phases = vi.spyOn(m as never, 'reconcileTaskPhases' as never)
    await m.checkInner(ctxAt(() => 0))
    expect(bg).not.toHaveBeenCalled()
    expect(phases).toHaveBeenCalledTimes(1)
  })
})
