/**
 * C2 pull channel — the RE-EXAMINATION candidate class (contract §5).
 *
 * The authoritative pull lane used to look at {running, idle} only, so a record
 * wedged in 'error' had NO writer: this lane refused to look, and
 * recoverInfraFailedSessions' fix pair is category-① so the enforce gate drops
 * it. Records froze in 'error' carrying "Connection lost — unable to reach
 * remote host" for hours after the host returned. These tests pin the second
 * class that breaks that deadlock, and pin that it can never starve the live one.
 *
 * Real SessionHealthMonitor + real session-tracker + REAL applySnapshot over an
 * isolated tmp SQLite (mock-constants); only the pool accessor is faked, so
 * "which sids were pulled" is read off the daemon RPC itself.
 *
 * MACHINE SAFETY: isolated tmp home, no daemons, no ports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-snap-reexam'))

// ── controllable pool accessor ──
type FakeConn = { send: ReturnType<typeof vi.fn> } | null
let pooledConn: FakeConn = null
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: () => pooledConn,
}))

vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
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
import { _resetSnapshotApplyForTests } from '../../src/core/session-snapshot-apply.js'
import type { SessionRecord } from '../../src/core/types.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'

/** A settled, non-error fold: the shape a reachable daemon reports for a session
 *  whose record still claims "unable to reach remote host". */
const IDLE_SNAP: SessionSnapshot = {
  v: 4096, cliState: 'idle', turnActive: false, pendingPermission: null,
  gatingBgCount: 0, teamActive: false,
  lastResult: { isError: false, endOffset: 4000 }, pid: null, exitCode: null,
}

function fakeConn(snapshot: SessionSnapshot = IDLE_SNAP): NonNullable<FakeConn> {
  return { send: vi.fn(async () => ({ ok: true, exists: true, snapshot })) }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function rec(sid: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: sid,
    taskId: '',
    project: 'proj',
    process_status: 'running',
    mode: 'default',
    startedAt: ago(HOUR),
    lastActiveAt: ago(HOUR),
    messageCount: 0,
    ...over,
  } as SessionRecord
}

/** A wedged 'error' record: infra cause, inside the recency window. */
function wedged(sid: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return rec(sid, {
    process_status: 'error',
    host: 'devhost',
    errorMessage: 'Connection lost — unable to reach remote host',
    errorKind: 'infra',
    status_reason: 'remote_unreachable',
    status_changed_by: 'health-monitor',
    last_status_change: ago(2 * HOUR),
    ...over,
  })
}

/** Reach the private step directly — the narrowest real-path invocation. */
function pull(
  monitor: SessionHealthMonitor,
  sessions: SessionRecord[],
  ctx?: TickContext,
  reexamPool?: SessionRecord[],
): Promise<void> {
  return (monitor as unknown as {
    checkSnapshotPull(s: SessionRecord[], c?: TickContext, p?: SessionRecord[]): Promise<void>
  }).checkSnapshotPull(sessions, ctx, reexamPool)
}

/** The sids the step actually asked the daemon about, in call order. */
function pulledSids(): string[] {
  return (pooledConn?.send.mock.calls ?? []).map((c) => (c[1] as { sid: string }).sid)
}

function reexamPullAt(monitor: SessionHealthMonitor): Map<string, number> {
  return (monitor as unknown as { snapshotReexamPullAt: Map<string, number> }).snapshotReexamPullAt
}

function livePullAt(monitor: SessionHealthMonitor): Map<string, number> {
  return (monitor as unknown as { snapshotPullAt: Map<string, number> }).snapshotPullAt
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  setSnapshotModeForTests('shadow')
  bus.clear()
  pooledConn = fakeConn()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('checkSnapshotPull — re-examination eligibility', () => {
  it('an error record with an infra cause IS pulled', async () => {
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [wedged('reexam-infra')])
    expect(pulledSids()).toEqual(['reexam-infra'])
  })

  it('a positively TERMINAL cause is NOT pulled', async () => {
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [
      wedged('term-kind', { errorKind: 'terminal', errorMessage: 'context overflow' }),
      wedged('term-reason', { errorKind: undefined, status_reason: 'user_stopped' }),
      wedged('term-idle', { errorKind: undefined, status_reason: 'idle_timeout' }),
      rec('term-stopped', {
        process_status: 'stopped', status_reason: 'normal_completion',
        last_status_change: ago(MINUTE),
      }),
    ])
    expect(pulledSids()).toEqual([])
  })

  it('an error older than the recency window is NOT pulled', async () => {
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [
      wedged('stale-25h', { last_status_change: ago(25 * HOUR) }),
      wedged('fresh-23h', { last_status_change: ago(23 * HOUR) }),
    ])
    expect(pulledSids()).toEqual(['fresh-23h'])
  })

  it('an absent or unparsable last_status_change is settled history — NOT pulled', async () => {
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [
      wedged('no-stamp', { last_status_change: undefined }),
      wedged('bad-stamp', { last_status_change: 'not-a-date' }),
    ])
    expect(pulledSids()).toEqual([])
  })

  it('classification is structural, never prose: an unexplained error and an unrelated message both qualify', async () => {
    // A prose gate ('Connection lost') is exactly what stranded 51 sessions —
    // the snapshot projection writes 'error' with NO message at all.
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [
      wedged('no-message', { errorKind: undefined, status_reason: undefined, errorMessage: undefined }),
      wedged('other-prose', {
        errorKind: undefined, status_reason: undefined,
        errorMessage: 'Error getting credentials from the credential provider',
      }),
    ])
    expect(pulledSids()).toEqual(['no-message', 'other-prose'])
  })

  it('a recent stopped record with a non-intentional cause is pulled', async () => {
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [
      rec('reexam-stopped', {
        process_status: 'stopped', errorKind: 'infra',
        last_status_change: ago(10 * MINUTE),
      }),
    ])
    expect(pulledSids()).toEqual(['reexam-stopped'])
  })

  it('keeps every shared exclusion: codex / embedded / sdk / awaiting_spawn / archived', async () => {
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [
      wedged('x-codex', { engine: 'codex' }),
      wedged('x-embedded', { provider: 'embedded' }),
      wedged('x-sdk', { provider: 'sdk' }),
      wedged('x-spawn', { status_reason: 'awaiting_spawn' }),
      wedged('x-archived', { archived: true }),
    ])
    expect(pulledSids()).toEqual([])
  })

  it('mode off → no re-examination either', async () => {
    setSnapshotModeForTests('off')
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [wedged('off-reexam')])
    expect(pulledSids()).toEqual([])
  })

  it('re-examination cadence is 5 minutes, not the live 25s', async () => {
    const monitor = new SessionHealthMonitor()
    const pool = [wedged('gap-1')]
    await pull(monitor, [], undefined, pool)
    await pull(monitor, [], undefined, pool)
    expect(pulledSids()).toEqual(['gap-1'])

    // Rewind the stamp past the 5-min gap → eligible again. A 25s rewind (the
    // live cadence) must NOT be enough, which the second pull above proves.
    reexamPullAt(monitor).set('gap-1', Date.now() - 6 * MINUTE)
    await pull(monitor, [], undefined, pool)
    expect(pulledSids()).toEqual(['gap-1', 'gap-1'])
  })
})

describe('checkSnapshotPull — the two classes have separate budgets', () => {
  it('re-examination caps at 5 per tick and logs its own class', async () => {
    const { log } = await import('../../src/logging/index.js')
    const infoSpy = vi.spyOn(log.session, 'info')
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined,
      Array.from({ length: 12 }, (_, i) => wedged(`cap-r-${i}`)))

    expect(pulledSids()).toHaveLength(5)
    const capLog = infoSpy.mock.calls.find(([msg, meta]) =>
      msg === 'health monitor: snapshot pull capped this tick'
      && (meta as { candidateClass?: string }).candidateClass === 'reexam')
    expect(capLog?.[1]).toMatchObject({ cap: 5, candidateCount: 12 })
  })

  it('a backlog of re-examination candidates cannot shrink the live budget (and vice versa)', async () => {
    const monitor = new SessionHealthMonitor()
    const live = Array.from({ length: 12 }, (_, i) => rec(`mix-live-${i}`))
    const stuck = Array.from({ length: 12 }, (_, i) => wedged(`mix-err-${i}`))
    await pull(monitor, live, undefined, [...live, ...stuck])

    const sids = pulledSids()
    expect(sids.filter((s) => s.startsWith('mix-live-'))).toHaveLength(10)
    expect(sids.filter((s) => s.startsWith('mix-err-'))).toHaveLength(5)
    // Live first, in full: a re-examination pile never displaces a live pull.
    expect(sids.slice(0, 10).every((s) => s.startsWith('mix-live-'))).toBe(true)
  })

  it('an exhausted tick budget stops both classes (the leftovers belong to the next tick)', async () => {
    const monitor = new SessionHealthMonitor()
    const spent: TickContext = { overBudget: () => true, elapsedMs: () => 0 }
    await pull(monitor, [rec('bud-live')], spent, [rec('bud-live'), wedged('bud-err')])
    expect(pulledSids()).toEqual([])
    // Nothing was stamped, so nothing is silently skipped next tick either.
    expect(reexamPullAt(monitor).size).toBe(0)
    expect(livePullAt(monitor).size).toBe(0)
  })
})

describe('checkSnapshotPull — oldest-pull-first rotation holds for both classes', () => {
  it('live: 11 candidates → tick 1 pulls #0-9, tick 2 starts with #10', async () => {
    const monitor = new SessionHealthMonitor()
    const live = Array.from({ length: 11 }, (_, i) => rec(`rot-l-${i}`))
    await pull(monitor, live, undefined, live)
    expect(pulledSids()).toHaveLength(10)
    expect(pulledSids()).not.toContain('rot-l-10')

    pooledConn = fakeConn()
    await pull(monitor, live, undefined, live)
    expect(pulledSids()).toEqual(['rot-l-10'])
  })

  it('re-examination: 6 candidates → tick 1 pulls #0-4, tick 2 starts with #5', async () => {
    const monitor = new SessionHealthMonitor()
    const stuck = Array.from({ length: 6 }, (_, i) => wedged(`rot-r-${i}`))
    await pull(monitor, [], undefined, stuck)
    expect(pulledSids()).toHaveLength(5)
    expect(pulledSids()).not.toContain('rot-r-5')

    pooledConn = fakeConn()
    await pull(monitor, [], undefined, stuck)
    expect(pulledSids()).toEqual(['rot-r-5'])
  })

  it('re-examination sorts by its OWN lastPullAt ascending', async () => {
    const monitor = new SessionHealthMonitor()
    const at = reexamPullAt(monitor)
    const now = Date.now()
    // All three are past the 5-min gap; 'oldest' is the stalest.
    at.set('sort-recent', now - 6 * MINUTE)
    at.set('sort-mid', now - 30 * MINUTE)
    at.set('sort-oldest', now - 3 * HOUR)
    // A live-lane stamp must not reorder the re-examination lane.
    livePullAt(monitor).set('sort-oldest', now)

    await pull(monitor, [], undefined,
      [wedged('sort-recent'), wedged('sort-mid'), wedged('sort-oldest')])
    expect(pulledSids()).toEqual(['sort-oldest', 'sort-mid', 'sort-recent'])
  })

  it('never-pulled re-examination sids come before every previously-pulled one', async () => {
    const monitor = new SessionHealthMonitor()
    reexamPullAt(monitor).set('seen-r', Date.now() - 10 * MINUTE)
    await pull(monitor, [], undefined, [wedged('seen-r'), wedged('fresh-r')])
    expect(pulledSids()).toEqual(['fresh-r', 'seen-r'])
  })
})

describe('checkSnapshotPull — the wedged record actually converges (real applySnapshot)', () => {
  it('an infra error converges to the daemon-projected status and the stale prose is cleared', async () => {
    const sid = 'converge-1'
    await createSessionRecord(sid, '', 'proj', '/tmp/reexam', { host: 'devhost' })
    const before = await updateSessionRecord(sid, {
      process_status: 'error',
      errorMessage: 'Connection lost — unable to reach remote host',
      errorKind: 'infra',
      last_status_change: ago(2 * HOUR),
      status_reason: 'remote_unreachable',
      status_changed_by: 'health-monitor',
    } as never)
    expect(before.process_status).toBe('error')

    setSnapshotModeForTests('enforce')
    const monitor = new SessionHealthMonitor()
    await pull(monitor, [], undefined, [before])

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('idle')
    expect(after?.status_reason).toBe('snapshot_projection')
    expect(after?.errorMessage ?? null).toBeNull()
    expect(after?.errorKind ?? null).toBeNull()
  })
})

describe('checkSnapshotPull — wired into the real tick', () => {
  it('monitor.check() re-examines a persisted wedged error record', async () => {
    // The tick's own working set drops 'error' rows (isTerminalSession), so this
    // only passes if the wider health-scan set is what feeds re-examination.
    const sid = 'tick-reexam'
    await createSessionRecord(sid, '', 'proj', '/tmp/reexam-tick', { host: 'devhost' })
    await updateSessionRecord(sid, {
      process_status: 'error',
      errorMessage: 'Connection lost — unable to reach remote host',
      errorKind: 'infra',
      last_status_change: ago(2 * HOUR),
      status_reason: 'remote_unreachable',
      status_changed_by: 'health-monitor',
    } as never)

    const monitor = new SessionHealthMonitor()
    await monitor.check()

    expect(pulledSids()).toContain(sid)
  })
})
