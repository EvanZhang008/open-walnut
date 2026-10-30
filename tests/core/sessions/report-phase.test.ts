/**
 * A turn's report moving its task's phase against a real task store (src/core/sessions/report-phase.ts):
 * the guard against a later move, the parked task, Main, the clock a WAITING gets, and the pass
 * that applies stored reports at start. The pure mapping is in tests/core/user-status.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-report-phase'))

// The task's triggers, as the park gate reads them (sessions/outside-wait.ts).
const triggers = vi.hoisted(() => ({ list: [] as Array<{ id: string; state: string; fires: number; watchesUser?: boolean }> }))
vi.mock('../../../src/core/task-wait-until.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  triggersWatching: async () => triggers.list,
}))

import { TASKS_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetForTesting, addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { applyReportPhase, applyStoredReports } from '../../../src/core/sessions/report-phase.js'
import { createSessionRequest } from '../../../src/core/session-requests.js'
import { DEFAULT_WAIT_MS } from '../../../src/core/types.js'
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
  triggers.list = []
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
    // A WAITING nobody picks up still comes back, the same half day: DEFAULT_WAIT_MS (4 hours) out.
    const ahead = Date.parse(t.wait_until!) - Date.now()
    expect(ahead).toBeGreaterThan(DEFAULT_WAIT_MS - MIN)
    expect(ahead).toBeLessThanOrEqual(DEFAULT_WAIT_MS)
  })

  // 2026-10-30: a worker that had delivered its work reported "waiting, other: the meeting notes and
  // the deadline" (the user's to give) and was parked for a day, off the user's list.
  it('a wait on nothing outside lands on the user, never WAITING (the reported case)', async () => {
    const ended = Date.now() - 2 * MIN
    const userWait = report({ state: 'waiting', waiting_kind: 'other', waiting_on: '\u7b49\u5f85\u53ef\u8bfb\u53d6\u7684\u7b14\u8bb0\u5185\u5bb9' })
    const handedBack = await taskAt('NEED_ACTION', 2 * MIN)
    expect(await applyReportPhase(handedBack, SID, userWait, ended)).toBeNull()
    expect((await getTask(handedBack)).phase).toBe('NEED_ACTION')
    const working = await taskAt('IN_PROGRESS', 2 * MIN)
    expect(await applyReportPhase(working, SID, userWait, ended)).toBe('NEED_ACTION')
    // No kind at all, a time with nothing armed, a lead wait with no lead, words that name the user.
    for (const r of [
      report({ state: 'waiting' }),
      report({ state: 'waiting', waiting_kind: 'time', waiting_on: 'tomorrow morning' }),
      report({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'its lead' }),
      report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'you: paste the meeting notes' }),
    ]) {
      const id = await taskAt('IN_PROGRESS', 2 * MIN)
      expect(await applyReportPhase(id, SID, r, ended), JSON.stringify(r)).toBe('NEED_ACTION')
    }
  })

  it('a wait it names as outside parks it: outside, another task, the machine, its lead', async () => {
    const ended = Date.now() - 2 * MIN
    const lead = (await addTask({ title: 'lead', project: 'Acme' })).task.id
    for (const kind of ['outside', 'task', 'machine', 'lead'] as const) {
      const id = await taskAt('NEED_ACTION', 2 * MIN, { parent_task_id: lead })
      expect(await applyReportPhase(id, SID, report({ state: 'waiting', waiting_kind: kind, waiting_on: 'the CI run on main' }), ended), kind).toBe('WAITING')
    }
  })

  it('an unnamed wait parks only on what the task has armed: a trigger, a request out, an open subtask', async () => {
    const ended = Date.now() - 2 * MIN
    const other = report({ state: 'waiting', waiting_kind: 'other', waiting_on: 'the pipeline' })
    // A trigger that watches the user's ask is a wait on the user.
    const watchOnly = await taskAt('NEED_ACTION', 2 * MIN)
    triggers.list = [{ id: 'cron-ask', state: 'armed', fires: 0, watchesUser: true }]
    expect(await applyReportPhase(watchOnly, SID, other, ended)).toBeNull()
    expect((await getTask(watchOnly)).phase).toBe('NEED_ACTION')
    // Its own trigger on an outside thing.
    const withTrigger = await taskAt('NEED_ACTION', 2 * MIN)
    triggers.list = [{ id: 'cron-ci', state: 'armed', fires: 0 }]
    expect(await applyReportPhase(withTrigger, SID, other, ended)).toBe('WAITING')
    triggers.list = []
    // A paused trigger counts for nothing.
    const paused = await taskAt('NEED_ACTION', 2 * MIN)
    triggers.list = [{ id: 'cron-ci', state: 'paused', fires: 0 }]
    expect(await applyReportPhase(paused, SID, other, ended)).toBeNull()
    triggers.list = []
    // A request its session sent, still unanswered.
    const asker = await taskAt('NEED_ACTION', 2 * MIN)
    await createSessionRequest({ fromSessionId: 'asker-sid', toTaskId: 'someone', text: 'review this?' })
    expect(await applyReportPhase(asker, 'asker-sid', other, ended)).toBe('WAITING')
    // A subtask at work; one not started (or on the user) says nothing about the wait.
    const leader = await taskAt('NEED_ACTION', 2 * MIN)
    const worker = (await addTask({ title: 'worker', project: 'Acme' })).task.id
    await updateTaskRaw(worker, { parent_task_id: leader } as never)
    expect(await applyReportPhase(leader, SID, other, Date.now() - 2 * MIN)).toBeNull()
    await updateTaskRaw(worker, { phase: 'IN_PROGRESS' } as never)
    expect(await applyReportPhase(leader, SID, other, ended)).toBe('WAITING')
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
