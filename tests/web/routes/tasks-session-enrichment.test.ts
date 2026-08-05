/**
 * Unit tests for enrichTasksWithSessionStatus (REST enrichment, src/web/routes/tasks.ts).
 *
 * This helper backs GET /api/tasks: it attaches live session status to each task
 * (session_status / plan_session_status / exec_session_status) by cross-referencing
 * the session store. It also performs several self-healing steps that are easy to
 * regress and previously had NO direct coverage:
 *   - reverse-map sessions via SessionRecord.taskId when task.session_ids is out of sync
 *   - heal session_id / plan_session_id / exec_session_id that point to archived sessions
 *   - filter archived IDs out of session_ids
 *   - infer plan/exec slot status from session_ids + session mode / planCompleted
 *   - graceful degradation when the session store is unreadable
 *
 * Strategy: mock the session store (listSessions) so we drive the enrichment purely
 * from in-memory fixtures, and mock constants so the task-manager / session-tracker
 * module-load side effects don't touch the real filesystem.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

// Replace the session store read with a controllable mock. enrichTasksWithSessionStatus
// is the only consumer of listSessions in tasks.ts, so this fully isolates the unit.
vi.mock('../../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(),
}))

import { enrichTasksWithSessionStatus } from '../../../src/web/routes/tasks.js'
import { listSessions } from '../../../src/core/session-tracker.js'
import type { Task, SessionRecord, ProcessStatus, SessionMode, SessionProvider } from '../../../src/core/types.js'

const listSessionsMock = vi.mocked(listSessions)

// ── Fixture builders ────────────────────────────────────────────────

let sessionSeq = 0

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  sessionSeq += 1
  return {
    claudeSessionId: `sess-${sessionSeq}`,
    taskId: 'task-1',
    project: 'proj',
    process_status: 'running' as ProcessStatus,
    mode: 'default' as SessionMode,
    startedAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    messageCount: 1,
    ...overrides,
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    project: 'Walnut',
    status: 'todo',
    session_ids: [],
    ...overrides,
  } as Task
}

beforeEach(() => {
  listSessionsMock.mockReset()
})

// ════════════════════════════════════════════════════════════════════
//  Happy path: single-slot session_status
// ════════════════════════════════════════════════════════════════════

describe('enrichTasksWithSessionStatus — single-slot enrichment', () => {
  it('maps session_id → session_status with mode/provider/planCompleted', async () => {
    const sess = makeSession({
      claudeSessionId: 'live-1',
      process_status: 'running',
      activity: 'editing files',
      mode: 'bypass' as SessionMode,
      provider: 'cli' as SessionProvider,
      planCompleted: true,
    })
    listSessionsMock.mockResolvedValue([sess])

    const task = makeTask({ session_id: 'live-1', session_ids: ['live-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.session_status).toEqual({
      process_status: 'running',
      activity: 'editing files',
      mode: 'bypass',
      provider: 'cli',
      planCompleted: true,
    })
  })

  it('omits planCompleted from session_status when falsy', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'live-1', planCompleted: false }),
    ])

    const [enriched] = await enrichTasksWithSessionStatus([
      makeTask({ session_id: 'live-1', session_ids: ['live-1'] }),
    ])

    expect(enriched.session_status).toBeDefined()
    expect('planCompleted' in enriched.session_status!).toBe(false)
  })

  it('does not attach session_status when the slot session is archived', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'live-1', archived: true }),
    ])

    const [enriched] = await enrichTasksWithSessionStatus([
      makeTask({ session_id: 'live-1', session_ids: ['live-1'] }),
    ])

    expect(enriched.session_status).toBeUndefined()
  })

  it('returns tasks unchanged when no task references any session', async () => {
    listSessionsMock.mockResolvedValue([])
    const task = makeTask({ session_ids: [] })
    const [enriched] = await enrichTasksWithSessionStatus([task])
    expect(enriched.session_status).toBeUndefined()
    expect(enriched.session_ids).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
//  Reverse-map via SessionRecord.taskId
// ════════════════════════════════════════════════════════════════════

describe('enrichTasksWithSessionStatus — reverse-map via taskId', () => {
  it('discovers sessions linked by SessionRecord.taskId even when task fields are empty', async () => {
    // Session record references the task, but task.session_ids never got updated
    // (e.g. linkSessionSlot failed under file-lock contention).
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'orphan-1', taskId: 'task-1' }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: [], session_id: undefined })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.session_ids).toContain('orphan-1')
    // Backfilled into session_id and surfaced as live status.
    expect(enriched.session_id).toBe('orphan-1')
    expect(enriched.session_status?.process_status).toBe('running')
  })

  it('excludes embedded subagent sessions from reverse-map discovery', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'embedded-1', taskId: 'task-1', provider: 'embedded' as SessionProvider }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: [] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.session_ids ?? []).not.toContain('embedded-1')
    expect(enriched.session_id).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════
//  Archived-session healing
// ════════════════════════════════════════════════════════════════════

describe('enrichTasksWithSessionStatus — archived healing', () => {
  it('heals session_id pointing at an archived session by backfilling the latest live one', async () => {
    // Chronological order: archived first, then a live session, both linked via taskId.
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'archived-1', taskId: 'task-1', archived: true }),
      makeSession({ claudeSessionId: 'live-2', taskId: 'task-1', archived: false }),
    ])

    const task = makeTask({ id: 'task-1', session_id: 'archived-1', session_ids: ['archived-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.session_id).toBe('live-2')
    expect(enriched.session_status?.process_status).toBe('running')
  })

  it('filters archived IDs out of session_ids', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'archived-1', taskId: 'task-1', archived: true }),
      makeSession({ claudeSessionId: 'live-2', taskId: 'task-1', archived: false }),
    ])

    const task = makeTask({ id: 'task-1', session_id: 'live-2', session_ids: ['archived-1', 'live-2'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.session_ids).not.toContain('archived-1')
    expect(enriched.session_ids).toContain('live-2')
  })

  it('clears plan_session_id / exec_session_id that point at archived sessions', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'plan-arch', taskId: 'task-1', archived: true, mode: 'plan' as SessionMode }),
      makeSession({ claudeSessionId: 'exec-arch', taskId: 'task-1', archived: true, mode: 'default' as SessionMode }),
    ])

    const task = makeTask({
      id: 'task-1',
      plan_session_id: 'plan-arch',
      exec_session_id: 'exec-arch',
      session_ids: ['plan-arch', 'exec-arch'],
    })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.plan_session_id).toBeUndefined()
    // exec is cleared first, then re-backfilled from the most recent live non-plan
    // session — there is none here, so it stays undefined.
    expect(enriched.exec_session_id).toBeUndefined()
    expect(enriched.plan_session_status).toBeUndefined()
    expect(enriched.exec_session_status).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════
//  Slot inference from session_ids + mode
// ════════════════════════════════════════════════════════════════════

describe('enrichTasksWithSessionStatus — slot inference', () => {
  it('infers plan_session_status from a plan-mode session in session_ids', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'plan-1', taskId: 'task-1', mode: 'plan' as SessionMode }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: ['plan-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.plan_session_status).toBeDefined()
    expect(enriched.plan_session_status?.mode).toBe('plan')
  })

  it('infers exec_session_status from a non-plan session in session_ids', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'exec-1', taskId: 'task-1', mode: 'default' as SessionMode }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: ['exec-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.exec_session_status).toBeDefined()
    expect(enriched.exec_session_status?.mode).toBe('default')
  })

  it('treats planCompleted sessions as the plan slot during inference', async () => {
    // taskId is deliberately unrelated so this session is NOT picked up by the
    // taskId reverse-map (which would otherwise run the exec-backfill path first
    // and claim it as exec). This isolates the pure session_ids inference loop,
    // where planCompleted is treated as a plan-slot marker.
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'planned-1', taskId: 'unrelated', mode: 'bypass' as SessionMode, planCompleted: true }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: ['planned-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.plan_session_status).toBeDefined()
    expect(enriched.plan_session_status?.planCompleted).toBe(true)
    expect(enriched.exec_session_status).toBeUndefined()
  })

  it('does not infer slot status from terminal (error) sessions', async () => {
    // taskId unrelated → reverse-map skipped → reaches the inference loop, which
    // gates on isActiveSession() and so skips the error session entirely.
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'dead-1', taskId: 'unrelated', mode: 'default' as SessionMode, process_status: 'error' }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: ['dead-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    expect(enriched.exec_session_status).toBeUndefined()
    expect(enriched.plan_session_status).toBeUndefined()
  })

  // Documents a real behavior asymmetry surfaced during verification:
  // isActiveSession() (which excludes 'error') ONLY gates the session_ids
  // inference loop. The taskId reverse-map backfill path surfaces the most
  // recent NON-ARCHIVED session even when its process_status is 'error', and
  // the single-slot / explicit-slot enrichment only checks `archived`, not
  // liveness. So a reverse-mapped error session still shows up as a slot status.
  it('reverse-mapped error sessions still surface as a slot (archived gate only, not liveness)', async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ claudeSessionId: 'dead-1', taskId: 'task-1', mode: 'default' as SessionMode, process_status: 'error' }),
    ])

    const task = makeTask({ id: 'task-1', session_ids: [] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    // Backfilled into session_id + exec_session_id despite being terminal.
    expect(enriched.session_id).toBe('dead-1')
    expect(enriched.session_status?.process_status).toBe('error')
    expect(enriched.exec_session_status?.process_status).toBe('error')
  })
})

// ════════════════════════════════════════════════════════════════════
//  Graceful degradation
// ════════════════════════════════════════════════════════════════════

describe('enrichTasksWithSessionStatus — graceful degradation', () => {
  it('returns tasks unmodified when the session store throws', async () => {
    listSessionsMock.mockRejectedValue(new Error('session store unreadable'))

    const task = makeTask({ id: 'task-1', session_id: 'live-1', session_ids: ['live-1'] })
    const [enriched] = await enrichTasksWithSessionStatus([task])

    // Same object, no enrichment fields added.
    expect(enriched).toBe(task)
    expect(enriched.session_status).toBeUndefined()
  })

  it('handles an empty task list', async () => {
    listSessionsMock.mockResolvedValue([])
    const result = await enrichTasksWithSessionStatus([])
    expect(result).toEqual([])
  })
})
