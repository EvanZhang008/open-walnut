/**
 * A turn's report moving its task's phase against a real task store (src/core/sessions/report-phase.ts):
 * the guard against a later move, the parked task, Main, the clock a WAITING gets, and the pass
 * that applies stored reports at start. The pure mapping is in tests/core/user-status.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-report-phase'))

import { TASKS_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetForTesting, addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { applyReportPhase, applyStoredReports } from '../../../src/core/sessions/report-phase.js'
import type { StatusReport } from '../../../src/core/user-status.js'
import type { TaskPhase } from '../../../src/core/types.js'

const SID = 'no-such-session'
const MIN = 60_000

async function taskAt(phase: TaskPhase, movedMsAgo: number, extra: Record<string, unknown> = {}) {
  const t = (await addTask({ title: `a ${phase} task`, project: 'Acme' })).task
  await updateTaskRaw(t.id, { phase, ...extra } as never)
  // The phase write stamps its own time; the test sets when the move happened.
  await updateTaskRaw(t.id, { phase_changed_at: new Date(Date.now() - movedMsAgo).toISOString() } as never)
  return t.id
}

const report = (r: Partial<StatusReport>, atMsAgo = 0): StatusReport => ({ at: new Date(Date.now() - atMsAgo).toISOString(), ...r })

beforeEach(async () => {
  closeDb()
  _resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
})

afterEach(() => {
  closeDb()
  _resetForTesting()
})

describe('applyReportPhase', () => {
  it('a handed-back worker that waits on another task is parked, with the default clock', async () => {
    const lead = (await addTask({ title: 'lead', project: 'Acme' })).task.id
    const id = await taskAt('NEED_ACTION', 2 * MIN, { parent_task_id: lead })
    const ended = Date.now() - 2 * MIN
    expect(await applyReportPhase(id, SID, report({ state: 'waiting', waiting_kind: 'task' }), ended)).toBe('WAITING')
    const t = await getTask(id)
    expect(t.phase).toBe('WAITING')
    // A WAITING nobody picks up still comes back: about a day out.
    expect(Date.parse(t.wait_until!) - Date.now()).toBeGreaterThan(20 * 60 * MIN)
  })

  it('never over a move made after the turn ended', async () => {
    const id = await taskAt('NEED_ACTION', 0)
    expect(await applyReportPhase(id, SID, report({ state: 'waiting', waiting_kind: 'task' }), Date.now() - 3 * MIN)).toBeNull()
    expect((await getTask(id)).phase).toBe('NEED_ACTION')
  })

  it('a parked task moves only for a real stop on the user', async () => {
    const id = await taskAt('WAITING', 2 * MIN)
    const ended = Date.now() - 2 * MIN
    expect(await applyReportPhase(id, SID, report({ state: 'waiting', waiting_kind: 'you' }), ended)).toBeNull()
    expect((await getTask(id)).phase).toBe('WAITING')
    expect(await applyReportPhase(id, SID, report({ state: 'needs', ask: 'Approve?' }), ended)).toBe('NEED_ACTION')
  })

  it('Main is not handed to the user for waiting on their next message', async () => {
    const id = await taskAt('IN_PROGRESS', 2 * MIN, { org_role: 'main' })
    const ended = Date.now() - 2 * MIN
    expect(await applyReportPhase(id, SID, report({ state: 'waiting', waiting_kind: 'you' }), ended)).toBeNull()
    expect(await applyReportPhase(id, SID, report({ state: 'needs', ask: 'Which one?' }), ended)).toBe('NEED_ACTION')
  })
})

describe('applyStoredReports', () => {
  it('applies the report of the move it followed, and leaves an older move or a later one alone', async () => {
    const lead = (await addTask({ title: 'lead', project: 'Acme' })).task.id
    // The turn ended 6 minutes ago, its report came 2 minutes ago.
    const fresh = await taskAt('NEED_ACTION', 6 * MIN, { parent_task_id: lead, status_report: report({ state: 'waiting', waiting_kind: 'task' }, 2 * MIN) })
    // A phase set long before the report: an older turn's.
    const old = await taskAt('NEED_ACTION', 90 * MIN, { parent_task_id: lead, status_report: report({ state: 'waiting', waiting_kind: 'task' }, 2 * MIN) })
    // Moved after the report: someone else's move.
    const later = await taskAt('NEED_ACTION', 0, { parent_task_id: lead, status_report: report({ state: 'waiting', waiting_kind: 'task' }, 2 * MIN) })
    // Working, with no live process at start: nothing to move.
    const working = await taskAt('NEED_ACTION', 6 * MIN, { status_report: report({ state: 'working' }, 2 * MIN) })
    expect(await applyStoredReports()).toBe(1)
    expect((await getTask(fresh)).phase).toBe('WAITING')
    for (const id of [old, later, working]) expect((await getTask(id)).phase).toBe('NEED_ACTION')
    // Again: nothing more.
    expect(await applyStoredReports()).toBe(0)
  })
})
