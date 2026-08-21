/**
 * Reconciler guard: a remote session whose record still says 'running' must NOT
 * flip its task to the handed-back phase just because the liveness probe failed
 * (the flip target was WAIT at incident time; WAIT was removed 2026-08-18 and
 * the reconciler now lands on AGENT_COMPLETE — the guard itself is unchanged)
 * (incident inc-1786691991988, 2026-08-14: an SSH flap to a remote host made
 * cachedIsAlive→false; the legacy 'remote_unreachable' breadcrumb write was
 * SUPPRESSED by the snapshot gate's enforce mode, so the old guard — which only
 * checked status_reason — didn't match, and the reconciler painted a live
 * session's task red: "Running 又是 Await Human Action 这不对吧").
 *
 * The guard now treats EITHER signal as "connectivity noise, not death":
 *   status_reason === 'remote_unreachable'  (legacy breadcrumb, shadow mode)
 *   process_status === 'running' on a remote record (daemon truth, enforce mode)
 *
 * These are unit tests of reconcileTaskPhases invoked directly on a monitor
 * instance (private → accessed via cast), with liveness stubbed dead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const applySessionPhaseCalls: Array<{ taskId: string; newPhase?: string }> = []
vi.mock('../../src/core/phase.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/phase.js')>()
  return {
    ...mod,
    applySessionPhase: vi.fn(async (taskId: string, _t: string, _s: string, opts?: { newPhase?: string }) => {
      applySessionPhaseCalls.push({ taskId, newPhase: opts?.newPhase })
      return { changed: true }
    }),
  }
})

import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import { registerSessionManager, unregisterSessionManager } from '../../src/providers/session-manager.js'
import type { SessionRecord } from '../../src/core/session-tracker.js'
import type { Task } from '../../src/core/types.js'

function makeTask(id: string, sessionId: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: 't', status: 'in_progress', phase: 'IN_PROGRESS',
    session_id: sessionId, created_at: '', updated_at: '',
    ...patch,
  } as unknown as Task
}

function makeRemoteSession(sid: string, taskId: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: sid, taskId, host: 'remotehost', pid: 1234,
    process_status: 'running', archived: false,
    ...patch,
  } as unknown as SessionRecord
}

async function runReconcile(session: SessionRecord, task: Task): Promise<void> {
  const monitor = new SessionHealthMonitor()
  const taskMap = new Map([[task.id, task]])
  const deadProbe = async () => false // the incident shape: probe says dead
  await (monitor as unknown as {
    reconcileTaskPhases(s: SessionRecord[], t: Map<string, Task>, c: (x: SessionRecord) => Promise<boolean>): Promise<void>
  }).reconcileTaskPhases([session], taskMap, deadProbe)
}

beforeEach(() => { applySessionPhaseCalls.length = 0 })

describe('reconciler remote-running guard (inc-1786691991988)', () => {
  it('INCIDENT SHAPE: remote record still running + dead probe → phase untouched', async () => {
    // Enforce mode suppressed the unreachable write, so status_reason is absent —
    // process_status='running' alone must hold the guard.
    await runReconcile(makeRemoteSession('sid-1', 'task-1'), makeTask('task-1', 'sid-1'))
    expect(applySessionPhaseCalls).toHaveLength(0)
  })

  it('legacy breadcrumb still guards (shadow-mode shape)', async () => {
    await runReconcile(
      makeRemoteSession('sid-2', 'task-2', { process_status: 'error', status_reason: 'remote_unreachable' } as Partial<SessionRecord>),
      makeTask('task-2', 'sid-2'),
    )
    expect(applySessionPhaseCalls).toHaveLength(0)
  })

  // (WAIT removed 2026-08-18 — the reconciler's expectedPhase is AGENT_COMPLETE.)
  it('a genuinely settled remote session (stopped, no breadcrumb) still reconciles', async () => {
    await runReconcile(
      makeRemoteSession('sid-3', 'task-3', { process_status: 'stopped' } as Partial<SessionRecord>),
      makeTask('task-3', 'sid-3'),
    )
    expect(applySessionPhaseCalls).toEqual([{ taskId: 'task-3', newPhase: 'AGENT_COMPLETE' }])
  })

  it('a dead LOCAL session is never held by the guard (hard OS fact)', async () => {
    await runReconcile(
      makeRemoteSession('sid-4', 'task-4', { host: undefined, process_status: 'running' } as Partial<SessionRecord>),
      makeTask('task-4', 'sid-4'),
    )
    expect(applySessionPhaseCalls).toEqual([{ taskId: 'task-4', newPhase: 'AGENT_COMPLETE' }])
  })
})

describe('reconciler freshness grace + registry see-through (incident 0dc8352f, 2026-08-18)', () => {
  // The incident: a send flipped the task IN_PROGRESS and started a cold
  // --resume (86s for a whale). Mid-resume the record still said 'stopped'
  // (enforce mode suppresses the legacy running write), the probe judged it
  // dead, and the reconciler flipped the 19-second-old IN_PROGRESS back to
  // AGENT_COMPLETE → "Running 但 Agent Complete".

  it('INCIDENT SHAPE: a task updated seconds ago is inside the grace window — untouched', async () => {
    const fresh = new Date().toISOString()
    await runReconcile(
      makeRemoteSession('sid-5', 'task-5', { host: undefined, process_status: 'stopped' } as Partial<SessionRecord>),
      makeTask('task-5', 'sid-5', { updated_at: fresh }),
    )
    expect(applySessionPhaseCalls).toHaveLength(0)
  })

  it('a task past the grace window still reconciles (the reconciler is not dead)', async () => {
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    await runReconcile(
      makeRemoteSession('sid-6', 'task-6', { host: undefined, process_status: 'stopped' } as Partial<SessionRecord>),
      makeTask('task-6', 'sid-6', { updated_at: stale }),
    )
    expect(applySessionPhaseCalls).toEqual([{ taskId: 'task-6', newPhase: 'AGENT_COMPLETE' }])
  })

  it('stale stopped flag + live registered manager → counted alive, untouched', async () => {
    // Even past the grace window: a registered manager whose isAlive() says true
    // (mid-resume, CLI booting) must override the record's stale 'stopped'.
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const session = makeRemoteSession('sid-7', 'task-7', { host: undefined, process_status: 'stopped' } as Partial<SessionRecord>)
    registerSessionManager('sid-7', { isAlive: async () => true } as never)
    try {
      await runReconcile(session, makeTask('task-7', 'sid-7', { updated_at: stale }))
      expect(applySessionPhaseCalls).toHaveLength(0)
    } finally {
      unregisterSessionManager('sid-7')
    }
  })

  it('registered manager that reports dead does NOT hold the flip', async () => {
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const session = makeRemoteSession('sid-8', 'task-8', { host: undefined, process_status: 'stopped' } as Partial<SessionRecord>)
    registerSessionManager('sid-8', { isAlive: async () => false } as never)
    try {
      await runReconcile(session, makeTask('task-8', 'sid-8', { updated_at: stale }))
      expect(applySessionPhaseCalls).toEqual([{ taskId: 'task-8', newPhase: 'AGENT_COMPLETE' }])
    } finally {
      unregisterSessionManager('sid-8')
    }
  })
})
