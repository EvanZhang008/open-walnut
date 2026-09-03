/**
 * recoverInfraFailedSessions — do not arm a recovery that cannot fire.
 *
 * fire() (session-auto-recover) hard-requires the task to still be IN_PROGRESS.
 * The probe-dead branch used to arm unconditionally on every 30s tick, so a
 * handed-back (AGENT_COMPLETE) task produced an endless arm → "auto-recover
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
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => ({ alive: false, pid: null }),
  getPooledSnapshotConnection: () => null,
}))

const scheduleMock = vi.fn(() => true)
vi.mock('../../src/core/session-auto-recover.js', () => ({
  scheduleSessionAutoRecover: (...args: unknown[]) => scheduleMock(...(args as [])),
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
  scheduleMock.mockClear()
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

  it('does NOT arm when the task is handed back (AGENT_COMPLETE) — fire() could only abort', async () => {
    taskPhase = 'AGENT_COMPLETE'
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
    taskPhase = 'AGENT_COMPLETE'
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

  it('a task-less session is left to schedule()\'s own guards', async () => {
    const rec = { ...wedged(), taskId: undefined } as SessionRecord
    await recover(new SessionHealthMonitor(), [rec], fakeUpdate())
    expect(scheduleMock).toHaveBeenCalledTimes(1)
  })
})
