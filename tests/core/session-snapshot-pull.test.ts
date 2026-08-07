/**
 * C2 pull channel — health-monitor 30s snapshot pull (contract §5).
 *
 * Real SessionHealthMonitor + real session-tracker over an isolated tmp SQLite
 * (mock-constants); the pool accessor and applySnapshot are mocked so the test
 * asserts the pull-channel CONTRACT: eligibility filter (running/idle, native
 * engine, pooled snapshot-capable connection), per-sid 25s spacing, the
 * 10-sids/tick cap, "never dial" (only the pool accessor is consulted), and
 * that a full monitor.check() tick actually reaches the step.
 *
 * MACHINE SAFETY: isolated tmp home, no daemons, no ports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-snap-pull'))

// ── controllable pool accessor ──
type FakeConn = { send: ReturnType<typeof vi.fn> } | null
let pooledConn: FakeConn = null
const getPooledSnapshotConnection = vi.fn(() => pooledConn)
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: (host: string | null) => getPooledSnapshotConnection(host),
}))

// applySnapshot is the unit under test's downstream — assert the routing.
const applySnapshotMock = vi.fn(async () => ({ outcome: 'shadow' as const, diverged: false }))
vi.mock('../../src/core/session-snapshot-apply.js', () => ({
  applySnapshot: (...args: unknown[]) => applySnapshotMock(...(args as [never, never, never])),
}))

// Full-tick support mocks (same shape as session-health-monitor-reconcile.test.ts).
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
// The tick's other steps import the (heavy) session runner — stub the surface
// they touch so the full-tick test stays light and deterministic.
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    reconcilePendingBackgroundTasks: async () => {},
    isTeamActive: () => false,
    isBackgroundWorkActive: () => false,
    hasPendingPermission: () => false,
    getSessionTimestamps: () => undefined,
    findSessionByClaudeId: () => undefined,
  },
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
  getTask: async () => { throw new Error('no task') },
}))

import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import type { TickContext } from '../../src/core/periodic-task.js'
import { setSnapshotModeForTests, _resetSnapshotGateForTests } from '../../src/core/session-snapshot-gate.js'
import type { SessionRecord } from '../../src/core/types.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import {
  createSessionRecord,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SNAP: SessionSnapshot = {
  v: 123, cliState: 'idle', turnActive: false, pendingPermission: null,
  gatingBgCount: 0, teamActive: false,
  lastResult: { isError: false, endOffset: 100 }, pid: null, exitCode: null,
}

function fakeConn(snapshot: SessionSnapshot | null = SNAP): NonNullable<FakeConn> {
  return {
    send: vi.fn(async () =>
      snapshot === null
        ? { ok: true, exists: true } // old daemon: no snapshot field
        : { ok: true, exists: true, snapshot }),
  }
}

function rec(sid: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: sid,
    taskId: '',
    project: 'proj',
    process_status: 'running',
    mode: 'default',
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messageCount: 0,
    ...over,
  } as SessionRecord
}

/** Reach the private step directly — the narrowest real-path invocation. */
function pull(
  monitor: SessionHealthMonitor,
  sessions: SessionRecord[],
  ctx?: TickContext,
): Promise<void> {
  return (monitor as unknown as {
    checkSnapshotPull(s: SessionRecord[], c?: TickContext): Promise<void>
  }).checkSnapshotPull(sessions, ctx)
}

/** A budget that reports over-budget after `after` calls to overBudget(). */
function budgetAfter(after: number): TickContext & { calls: () => number } {
  let calls = 0
  return {
    overBudget: () => ++calls > after,
    elapsedMs: () => 0,
    calls: () => calls,
  }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  setSnapshotModeForTests('shadow')
  bus.clear()
  pooledConn = null
  getPooledSnapshotConnection.mockClear()
  applySnapshotMock.mockClear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('checkSnapshotPull — eligibility + routing', () => {
  it('pulls getState for a running session with a pooled snapshot connection and routes to applySnapshot', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [rec('pull-1', { host: 'devhost' })])

    expect(getPooledSnapshotConnection).toHaveBeenCalledWith('devhost')
    expect(pooledConn!.send).toHaveBeenCalledWith('getState', { sid: 'pull-1' })
    expect(applySnapshotMock).toHaveBeenCalledTimes(1)
    expect(applySnapshotMock).toHaveBeenCalledWith('pull-1', SNAP, 'pull-30s')
  })

  it('idle sessions are eligible; stopped/error are not', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [
      rec('pull-idle', { process_status: 'idle' }),
      rec('pull-stopped', { process_status: 'stopped' }),
      rec('pull-error', { process_status: 'error' }),
    ])
    expect(applySnapshotMock).toHaveBeenCalledTimes(1)
    expect(applySnapshotMock.mock.calls[0][0]).toBe('pull-idle')
  })

  it('excludes codex / embedded / sdk / awaiting_spawn sessions', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [
      rec('pull-codex', { engine: 'codex' }),
      rec('pull-embedded', { provider: 'embedded' }),
      rec('pull-sdk', { provider: 'sdk' }),
      rec('pull-spawn', { status_reason: 'awaiting_spawn' }),
    ])
    expect(applySnapshotMock).not.toHaveBeenCalled()
    expect(pooledConn!.send).not.toHaveBeenCalled()
  })

  it('no pooled snapshot-capable connection → skip, NEVER dial', async () => {
    pooledConn = null
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [rec('pull-nopool')])
    expect(getPooledSnapshotConnection).toHaveBeenCalled()
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })

  it('mode off → the whole step is inert', async () => {
    setSnapshotModeForTests('off')
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [rec('pull-off')])
    expect(getPooledSnapshotConnection).not.toHaveBeenCalled()
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })

  it('per-sid 25s spacing: a second pull inside the window is skipped', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [rec('pull-spacing')])
    await pull(monitor, [rec('pull-spacing')])
    expect(applySnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('caps at 10 pulls per tick and logs when capped', async () => {
    pooledConn = fakeConn()
    const { log } = await import('../../src/logging/index.js')
    const infoSpy = vi.spyOn(log.session, 'info')
    const monitor = new SessionHealthMonitor()
    const sessions = Array.from({ length: 12 }, (_, i) => rec(`pull-cap-${i}`))
    await pull(monitor, sessions)
    expect(applySnapshotMock).toHaveBeenCalledTimes(10)
    expect(infoSpy.mock.calls.find(([msg]) => msg === 'health monitor: snapshot pull capped this tick')).toBeTruthy()
  })

  it('a getState without a snapshot field (old daemon reply raced in) is a no-op', async () => {
    pooledConn = fakeConn(null)
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [rec('pull-nosnap')])
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })

  it('a throwing send is contained (step never throws)', async () => {
    pooledConn = { send: vi.fn(async () => { throw new Error('boom') }) }
    const monitor = new SessionHealthMonitor()
    await expect(pull(monitor, [rec('pull-throw')])).resolves.toBeUndefined()
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })
})

// ── C8+C12: the tick budget is honored INSIDE the loop ───────────────────────
describe('checkSnapshotPull — TickContext budget', () => {
  it('aborts MID-LOOP when the budget runs out and logs it', async () => {
    // Each iteration is a real daemon RPC (probe-timeout ceiling), so up to 10
    // slow hosts could burn 10 × the timeout sequentially BEFORE the
    // authoritative reconcile phases that run after this step.
    pooledConn = fakeConn()
    const { log } = await import('../../src/logging/index.js')
    const warnSpy = vi.spyOn(log.session, 'warn')
    const monitor = new SessionHealthMonitor()
    const sessions = Array.from({ length: 8 }, (_, i) => rec(`budget-${i}`))

    // Over budget from the 3rd iteration's check onward → 2 pulls happen.
    await pull(monitor, sessions, budgetAfter(2))

    expect(applySnapshotMock).toHaveBeenCalledTimes(2)
    expect(
      warnSpy.mock.calls.find(([msg]) => msg === 'health monitor: checkSnapshotPull abandoned mid-loop (over budget)'),
      'the abandonment must be visible in the logs',
    ).toBeTruthy()
  })

  it('an already-exhausted budget pulls nothing at all', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [rec('budget-none')], budgetAfter(0))
    expect(applySnapshotMock).not.toHaveBeenCalled()
  })

  it('no ctx (manual check()) keeps the unlimited-budget behavior', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    await pull(monitor, Array.from({ length: 5 }, (_, i) => rec(`nobudget-${i}`)))
    expect(applySnapshotMock).toHaveBeenCalledTimes(5)
  })
})

// ── C9+C29: oldest-pull-first rotation, so sids 11+ are not starved ──────────
describe('checkSnapshotPull — rotation (oldest lastPullAt first)', () => {
  it('11 candidates: tick 1 pulls #0-9, the NEXT tick starts with #10', async () => {
    // In list order the SAME first ten sids were pulled every tick and — since
    // the 25s per-sid gap is shorter than the 30s cadence — #10 was never
    // pulled at all: the pull channel silently did not exist for it.
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    const sessions = Array.from({ length: 11 }, (_, i) => rec(`rot-${i}`))

    await pull(monitor, sessions)
    const firstTick = applySnapshotMock.mock.calls.map((c) => c[0] as string)
    expect(firstTick).toHaveLength(10)
    expect(firstTick).not.toContain('rot-10')

    // Next tick: the 10 already-pulled sids are inside their 25s gap, so only
    // the never-pulled one is eligible — and it goes FIRST by construction.
    applySnapshotMock.mockClear()
    await pull(monitor, sessions)
    expect(applySnapshotMock.mock.calls.map((c) => c[0] as string)).toEqual(['rot-10'])
  })

  it('sorts by lastPullAt ascending: a stale sid outranks a recently-pulled one', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    const pullAt = (monitor as unknown as { snapshotPullAt: Map<string, number> }).snapshotPullAt
    const now = Date.now()
    // All three are past the 25s gap; 'oldest' is the stalest.
    pullAt.set('rot-recent', now - 26_000)
    pullAt.set('rot-mid', now - 60_000)
    pullAt.set('rot-oldest', now - 600_000)

    await pull(monitor, [rec('rot-recent'), rec('rot-mid'), rec('rot-oldest')])
    expect(applySnapshotMock.mock.calls.map((c) => c[0] as string))
      .toEqual(['rot-oldest', 'rot-mid', 'rot-recent'])
  })

  it('never-pulled sids come before every previously-pulled sid', async () => {
    pooledConn = fakeConn()
    const monitor = new SessionHealthMonitor()
    const pullAt = (monitor as unknown as { snapshotPullAt: Map<string, number> }).snapshotPullAt
    pullAt.set('rot-seen', Date.now() - 30_000)
    await pull(monitor, [rec('rot-seen'), rec('rot-fresh')])
    expect(applySnapshotMock.mock.calls.map((c) => c[0] as string)).toEqual(['rot-fresh', 'rot-seen'])
  })
})

describe('checkSnapshotPull — wired into the real tick', () => {
  it('monitor.check() reaches the pull step for a persisted running session', async () => {
    pooledConn = fakeConn()
    // Persisted record (real tracker/db): running + alive pid so no other step
    // rewrites it; old last_status_change so grace windows don't interfere.
    await createSessionRecord('pull-tick', '', 'proj', '/tmp/snap-pull', { pid: process.pid })
    await updateSessionRecord('pull-tick', {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    } as never)

    const monitor = new SessionHealthMonitor()
    await monitor.check()

    expect(applySnapshotMock).toHaveBeenCalledWith('pull-tick', SNAP, 'pull-30s')
  })
})
