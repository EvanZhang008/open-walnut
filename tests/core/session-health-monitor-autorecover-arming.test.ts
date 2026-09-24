/**
 * recoverInfraFailedSessions — do not arm a recovery that cannot fire.
 *
 * fire() (session-auto-recover) hard-requires the task to still be IN_PROGRESS.
 * The probe-dead branch used to arm unconditionally on every 30s tick, so a
 * handed-back (NEED_ACTION) task produced an endless arm → "auto-recover
 * aborted — task no longer in progress" 20s later → re-arm loop (measured
 * running 2+ hours on one session), and `if (armed) continue` also skipped the
 * phase sync that IS appropriate in that state.
 *
 * Real SessionHealthMonitor; the daemon probe, the auto-recover scheduler, the
 * phase machine and the record writer are faked so the assertions are about the
 * ARMING DECISION only. No DB, no daemons, no ports.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-arming'))

// Daemon reachable, process confirmed dead — the host-reboot shape.
let probeResult = { alive: false, pid: null as number | null }
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => probeResult,
  getPooledSnapshotConnection: () => null,
}))

const scheduleMock = vi.fn(() => true)
const pendingMock = vi.fn(() => false)
vi.mock('../../src/core/session-auto-recover.js', () => ({
  scheduleSessionAutoRecover: (...args: unknown[]) => scheduleMock(...(args as [])),
  getSessionAutoRecover: () => ({ hasPending: pendingMock }),
}))

const applySessionPhaseMock = vi.fn(async () => undefined)
vi.mock('../../src/core/phase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/phase.js')>()
  return { ...actual, applySessionPhase: applySessionPhaseMock }
})

let taskPhase: string | null = 'IN_PROGRESS'
let taskLookupThrows = false
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => {
    if (taskLookupThrows) throw new Error('db unavailable')
    return taskPhase === null ? null : { id, phase: taskPhase }
  },
  clearSessionSlot: async (taskId: string, sessionId: string) => ({
    task: { id: taskId, session_id: sessionId },
  }),
  listTasks: async () => [],
  listTasksByIds: async () => [],
}))

import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import type { SessionRecord } from '../../src/core/types.js'
import { bus } from '../../src/core/event-bus.js'
import {
  markSnapshotCovered, _clearSnapshotRegistryForTests, setSnapshotModeForTests,
} from '../../src/core/session-snapshot-gate.js'

type Update = (id: string, up: Record<string, unknown>) => Promise<SessionRecord>

function wedged(sid = 'arm-1'): SessionRecord {
  return {
    claudeSessionId: sid,
    taskId: 'task-1',
    project: 'proj',
    host: 'devhost',
    process_status: 'error',
    errorMessage: 'Connection lost — unable to reach remote host',
    errorKind: 'infra',
    status_reason: 'remote_unreachable',
    status_changed_by: 'health-monitor',
    last_status_change: new Date(Date.now() - 60_000).toISOString(),
    mode: 'default',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastActiveAt: new Date(Date.now() - 3_600_000).toISOString(),
    messageCount: 1,
  } as SessionRecord
}

function recover(monitor: SessionHealthMonitor, sessions: SessionRecord[], update: Update): Promise<void> {
  return (monitor as unknown as {
    recoverInfraFailedSessions(s: SessionRecord[], u: Update): Promise<void>
  }).recoverInfraFailedSessions(sessions, update)
}

function fakeUpdate(): Update & { calls: () => Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  const fn = (async (id: string, up: Record<string, unknown>) => {
    calls.push(up)
    return { ...wedged(id), ...up } as SessionRecord
  }) as Update & { calls: () => Record<string, unknown>[] }
  fn.calls = () => calls
  return fn
}

beforeEach(() => {
  bus.clear()
  _clearSnapshotRegistryForTests()
  setSnapshotModeForTests('enforce')
  probeResult = { alive: false, pid: null }
  scheduleMock.mockReset().mockReturnValue(true)
  pendingMock.mockReset().mockReturnValue(false)
  applySessionPhaseMock.mockClear()
  taskPhase = 'IN_PROGRESS'
  taskLookupThrows = false
})

describe('probe-dead branch — auto-recover arming', () => {
  it('arms (and skips the phase sync) while the task is still IN_PROGRESS', async () => {
    const update = fakeUpdate()
    await recover(new SessionHealthMonitor(), [wedged()], update)

    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(applySessionPhaseMock).not.toHaveBeenCalled()
    // The record write itself is unchanged.
    expect(update.calls()[0]).toMatchObject({
      process_status: 'stopped', errorKind: 'infra', status_reason: 'auto_recovered_dead',
    })
  })

  it('does NOT arm when the task is handed back (NEED_ACTION) — fire() could only abort', async () => {
    taskPhase = 'NEED_ACTION'
    await recover(new SessionHealthMonitor(), [wedged()], fakeUpdate())

    expect(scheduleMock).not.toHaveBeenCalled()
    // The un-armed path is the existing fallback: the phase sync still runs.
    expect(applySessionPhaseMock).toHaveBeenCalledTimes(1)
    expect(applySessionPhaseMock.mock.calls[0]?.[1]).toBe('session:result')
  })

  it('does NOT arm for a COMPLETE task', async () => {
    taskPhase = 'COMPLETE'
    await recover(new SessionHealthMonitor(), [wedged()], fakeUpdate())
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  it('re-arming stays suppressed across repeated ticks (no 30s churn loop)', async () => {
    taskPhase = 'NEED_ACTION'
    const monitor = new SessionHealthMonitor()
    for (let i = 0; i < 4; i++) await recover(monitor, [wedged()], fakeUpdate())
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  it('an unanswerable phase lookup still arms — a transient read error must not disable recovery', async () => {
    taskLookupThrows = true
    await recover(new SessionHealthMonitor(), [wedged()], fakeUpdate())
    expect(scheduleMock).toHaveBeenCalledTimes(1)

    scheduleMock.mockClear()
    taskLookupThrows = false
    taskPhase = null // task row gone
    await recover(new SessionHealthMonitor(), [wedged()], fakeUpdate())
    expect(scheduleMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a staggered recovery pending across the next health tick', async () => {
    pendingMock.mockReturnValue(true)
    scheduleMock.mockReturnValue(false)
    markSnapshotCovered('arm-pending', 100)
    try {
      await recover(new SessionHealthMonitor(), [wedged('arm-pending')], fakeUpdate())
      expect(pendingMock).toHaveBeenCalledWith('arm-pending')
      expect(scheduleMock).not.toHaveBeenCalled()
      expect(applySessionPhaseMock).not.toHaveBeenCalled()
    } finally {
      _clearSnapshotRegistryForTests()
    }
  })

  it('a task-less session is left to schedule()\'s own guards', async () => {
    const rec = { ...wedged(), taskId: undefined } as SessionRecord
    await recover(new SessionHealthMonitor(), [rec], fakeUpdate())
    expect(scheduleMock).toHaveBeenCalledTimes(1)
  })
})

describe('probe-alive recovery reporting', () => {
  it('a covered live session leaves status recovery to snapshots without claiming success', async () => {
    probeResult = { alive: true, pid: null }
    markSnapshotCovered('alive-covered', 100)
    const update = fakeUpdate()
    const emitted: unknown[] = []
    bus.subscribe('session:status-changed', (event) => { emitted.push(event) })
    const { log } = await import('../../src/logging/index.js')
    const info = vi.spyOn(log.session, 'info')
    try {
      await recover(new SessionHealthMonitor(), [wedged('alive-covered')], update)
      expect(update.calls()).toEqual([])
      expect(emitted).toEqual([])
      expect(info.mock.calls.some(([message]) => message === 'health monitor: auto-recovered connection-lost session')).toBe(false)
      expect(scheduleMock).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })

  it('a covered live session still restores its process identity', async () => {
    probeResult = { alive: true, pid: 4242 }
    markSnapshotCovered('alive-pid', 100)
    const update = fakeUpdate()
    await recover(new SessionHealthMonitor(), [wedged('alive-pid')], update)
    expect(update.calls()).toEqual([{ pid: 4242 }])
  })

  it.each(['off', 'shadow'] as const)('a covered session keeps legacy recovery in %s mode', async (mode) => {
    setSnapshotModeForTests(mode)
    probeResult = { alive: true, pid: null }
    markSnapshotCovered('alive-legacy-mode', 100)
    const update = fakeUpdate()
    await recover(new SessionHealthMonitor(), [wedged('alive-legacy-mode')], update)
    expect(update.calls()[0]).toMatchObject({ process_status: 'running', status_reason: 'auto_recovered' })
  })

  it('an uncovered live session retains its recovery path', async () => {
    probeResult = { alive: true, pid: null }
    const update = fakeUpdate()
    await recover(new SessionHealthMonitor(), [wedged('alive-uncovered')], update)
    expect(update.calls()[0]).toMatchObject({ process_status: 'running', status_reason: 'auto_recovered' })
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  it('a rejected legacy recovery write does not announce success', async () => {
    probeResult = { alive: true, pid: null }
    const { log } = await import('../../src/logging/index.js')
    const info = vi.spyOn(log.session, 'info')
    const emitted: unknown[] = []
    bus.subscribe('session:status-changed', (event) => { emitted.push(event) })
    try {
      await recover(new SessionHealthMonitor(), [wedged('alive-rejected')], async (id) => wedged(id))
      expect(emitted).toEqual([])
      expect(info.mock.calls.some(([message]) => message === 'health monitor: auto-recovered connection-lost session')).toBe(false)
    } finally {
      info.mockRestore()
    }
  })
})

// ── The relabel write is skipped for a snapshot-covered session ──────────────
// ('health-monitor','auto_recovered_dead') is category-①, so for a covered
// session the gate drops the whole patch. Issuing it anyway cost a transaction,
// an urgent broadcast and an "auto-recovered" log line every 30s about a record
// that did not move — the 2026-09-03 wedge ran that loop for two hours. The
// relabel is the pull channel's re-examination class's job now; what must NOT
// change is the arming and the phase sync, which never needed the write.
describe('probe-dead branch — no write the gate would drop', () => {
  beforeEach(() => { _clearSnapshotRegistryForTests() })

  it('covered session: no record write, no status broadcast, but STILL arms', async () => {
    const update = fakeUpdate()
    const emitted: unknown[] = []
    bus.subscribe('session:status-changed', (e) => { emitted.push(e) })
    markSnapshotCovered('arm-1', 100)

    await recover(new SessionHealthMonitor(), [wedged('arm-1')], update)

    expect(update.calls()).toHaveLength(0)
    expect(emitted).toHaveLength(0)
    expect(scheduleMock).toHaveBeenCalledTimes(1)
  })

  it('covered session with a handed-back task: no write, no arm, phase sync still runs', async () => {
    taskPhase = 'NEED_ACTION'
    const update = fakeUpdate()
    markSnapshotCovered('arm-1', 100)

    await recover(new SessionHealthMonitor(), [wedged('arm-1')], update)

    expect(update.calls()).toHaveLength(0)
    expect(scheduleMock).not.toHaveBeenCalled()
    expect(applySessionPhaseMock).toHaveBeenCalledTimes(1)
  })

  it('an UNcovered session keeps the write — the skip is scoped, not a removal', async () => {
    const update = fakeUpdate()
    await recover(new SessionHealthMonitor(), [wedged('arm-2')], update)

    expect(update.calls()[0]).toMatchObject({
      process_status: 'stopped', errorKind: 'infra', status_reason: 'auto_recovered_dead',
    })
    expect(scheduleMock).toHaveBeenCalledTimes(1)
  })
})
