/**
 * "Wait until" in the phase machine (src/core/task-waiting-rules.ts + phase.ts).
 *
 * A waiting task is a plain To Do (user call 2026-09-28: it stays in Now, no
 * separate status). The one exception to the hand-back rule: a finished turn
 * lands on TODO with no red dot. Everything else pins when the wait ENDS, since
 * a wait that never ends is the parked-state bug the WAIT phase was removed for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-waiting-phase'))

// applySessionPhase dynamic-imports the runner for live-turn gates; no live turns here.
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findSessionByClaudeId: () => undefined },
}))

// A parent's pending expect_reply on the waiting task (session-request-watch's job
// on a NEED_ACTION edge, which a waiting task's quiet turn end never makes).
const pendingRequests: Array<{ id: string }> = []
const notified: Array<{ id: string; outcome: string }> = []
vi.mock('../../src/core/session-requests.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/session-requests.js')>()),
  pendingRequestsForTarget: async () => [...pendingRequests],
}))
vi.mock('../../src/core/sessions/session-request-notify.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/sessions/session-request-notify.js')>()),
  notifyRequesterFallback: async (request: { id: string }, outcome: string) => { notified.push({ id: request.id, outcome }); return true },
}))

import { applySessionPhase } from '../../src/core/phase.js'
import { addTask, updateTask, updateTaskRaw, getTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { isTaskWaiting, type TaskWaiting } from '../../src/core/types.js'
import {
  endedWait, normalizeWaitCondition, waitEndsOnStatusChange, waitingSessionPhase, WAIT_CONDITION_MAX,
} from '../../src/core/task-waiting-rules.js'

const WAITING: TaskWaiting = { condition: 'CR 1234 is approved', routine_id: 'r-1', since: '2026-09-28T00:00:00.000Z' }

describe('waitingSessionPhase (pure)', () => {
  const waitingTodo = { phase: 'TODO' as const, waiting: WAITING }
  const waitingRunning = { phase: 'IN_PROGRESS' as const, waiting: WAITING }

  it('passes everything through for a task that is not waiting', () => {
    expect(waitingSessionPhase({ phase: 'IN_PROGRESS' }, 'session:result', 'NEED_ACTION')).toEqual({ newPhase: 'NEED_ACTION' })
    // An ENDED wait is not waiting any more: the hand-back is back to normal.
    const ended = { phase: 'IN_PROGRESS' as const, waiting: endedWait(WAITING, 'fired') }
    expect(waitingSessionPhase(ended, 'session:result', 'NEED_ACTION')).toEqual({ newPhase: 'NEED_ACTION' })
  })

  it('a finished turn lands on TODO, or stays put when it already is TODO', () => {
    expect(waitingSessionPhase(waitingRunning, 'session:result', 'NEED_ACTION')).toEqual({ newPhase: 'TODO', absorbed: true })
    expect(waitingSessionPhase(waitingRunning, 'session:error', 'NEED_ACTION')).toEqual({ newPhase: 'TODO', absorbed: true })
    expect(waitingSessionPhase(waitingRunning, 'reconciler', 'NEED_ACTION')).toEqual({ newPhase: 'TODO', absorbed: true })
    expect(waitingSessionPhase(waitingTodo, 'reconciler', 'NEED_ACTION')).toEqual({ newPhase: null, absorbed: true })
  })

  it('a prompt that needs the human ends the wait and still goes red', () => {
    expect(waitingSessionPhase(waitingRunning, 'session:awaiting-human', 'NEED_ACTION'))
      .toEqual({ newPhase: 'NEED_ACTION', wake: 'needs-human' })
  })

  it('a human or peer send ends the wait; an automated send does not', () => {
    expect(waitingSessionPhase(waitingTodo, 'session:input', 'IN_PROGRESS', { humanSend: true }))
      .toEqual({ newPhase: 'IN_PROGRESS', wake: 'message' })
    expect(waitingSessionPhase(waitingTodo, 'session:input', 'IN_PROGRESS', { humanSend: false }))
      .toEqual({ newPhase: 'IN_PROGRESS' })
    // Mid-turn: no phase move, the wait still ends.
    expect(waitingSessionPhase(waitingRunning, 'session:input', null, { humanSend: true }))
      .toEqual({ newPhase: null, wake: 'message' })
  })

  it('a completed task is never waiting', () => {
    expect(isTaskWaiting({ phase: 'COMPLETE', waiting: WAITING })).toBe(false)
    expect(isTaskWaiting({ phase: 'TODO', waiting: WAITING })).toBe(true)
    expect(isTaskWaiting({ phase: 'TODO', waiting: null })).toBe(false)
  })
})

describe('waitEndsOnStatusChange + helpers (pure)', () => {
  it('Need Action or Complete ends the wait; To Do, In Progress or the same status does not', () => {
    const t = { phase: 'TODO' as const, waiting: WAITING }
    expect(waitEndsOnStatusChange(t, 'TODO')).toBe(false)
    // A session turn on a waiting task is In Progress (a session start writes it).
    expect(waitEndsOnStatusChange(t, 'IN_PROGRESS')).toBe(false)
    expect(waitEndsOnStatusChange(t, 'NEED_ACTION')).toBe(true)
    expect(waitEndsOnStatusChange(t, 'COMPLETE')).toBe(true)
    expect(waitEndsOnStatusChange({ phase: 'NEED_ACTION', waiting: WAITING }, 'NEED_ACTION')).toBe(false)
    expect(waitEndsOnStatusChange({ phase: 'TODO' }, 'NEED_ACTION')).toBe(false)
  })

  it('an ended wait keeps its routine link and says why', () => {
    const now = new Date('2026-09-28T10:00:00.000Z')
    expect(endedWait(WAITING, 'message', now)).toEqual({ ...WAITING, woke_at: now.toISOString(), woke_reason: 'message' })
  })

  it('the condition becomes one bounded line', () => {
    expect(normalizeWaitCondition('  CR 1234\n  is   approved ')).toBe('CR 1234 is approved')
    expect(normalizeWaitCondition('   ')).toBe('')
    expect(normalizeWaitCondition(42)).toBe('')
    const long = normalizeWaitCondition('x'.repeat(WAIT_CONDITION_MAX + 50))
    expect(long).toHaveLength(WAIT_CONDITION_MAX)
    expect(long.endsWith('\u2026')).toBe(true)
    // Non-ASCII test data (CJK) survives untouched.
    expect(normalizeWaitCondition('\u5ba1\u6279 \u901a\u8fc7')).toBe('\u5ba1\u6279 \u901a\u8fc7')
    // The cut never splits a surrogate pair (an emoji, U+1F600, straddling the limit).
    const emoji = normalizeWaitCondition(`${'x'.repeat(WAIT_CONDITION_MAX - 2)}\u{1F600}tail`)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false) // no lone high surrogate
    expect(emoji.endsWith('x\u2026')).toBe(true)
  })
})

describe('applySessionPhase on a waiting task', () => {
  beforeEach(async () => {
    closeDb()
    _resetSessionTrackerForTesting()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  })
  afterEach(async () => {
    pendingRequests.length = 0
    notified.length = 0
    closeDb()
    _resetSessionTrackerForTesting()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  })

  async function waitingTask(phase: 'TODO' | 'IN_PROGRESS'): Promise<string> {
    const { task } = await addTask({ title: 'Ship after review', project: 'p' })
    await updateTaskRaw(task.id, { phase, waiting: WAITING, unread: false })
    return task.id
  }

  it('a turn that ends lands on TODO with no red dot, and the wait goes on', async () => {
    const id = await waitingTask('IN_PROGRESS')
    const res = await applySessionPhase(id, 'session:result', 'test', { sessionId: 'sid-1' })
    expect(res).toMatchObject({ changed: true, oldPhase: 'IN_PROGRESS', newPhase: 'TODO' })
    const t = await getTask(id)
    expect(t.phase).toBe('TODO')
    expect(t.unread).toBeFalsy()
    expect(isTaskWaiting(t)).toBe(true)
  })

  it('a dead session\'s hand-back (reconciler) also lands on TODO', async () => {
    const id = await waitingTask('IN_PROGRESS')
    await applySessionPhase(id, 'reconciler', 'test', { newPhase: 'NEED_ACTION' })
    const t = await getTask(id)
    expect(t.phase).toBe('TODO')
    expect(t.unread).toBeFalsy()
    expect(isTaskWaiting(t)).toBe(true)
  })

  it('a prompt that needs the human ends the wait and goes red', async () => {
    const id = await waitingTask('IN_PROGRESS')
    await applySessionPhase(id, 'session:awaiting-human', 'test', { sessionId: 'sid-1' })
    const t = await getTask(id)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.unread).toBe(true)
    expect(isTaskWaiting(t)).toBe(false)
    expect(t.waiting).toMatchObject({ routine_id: 'r-1', woke_reason: 'needs-human' })
  })

  it('a human message ends the wait; the next finished turn hands back as usual', async () => {
    const id = await waitingTask('TODO')
    await applySessionPhase(id, 'session:input', 'test', { sessionId: 'sid-1', reopenTerminal: true })
    let t = await getTask(id)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(t.waiting).toMatchObject({ woke_reason: 'message' })
    await applySessionPhase(id, 'session:result', 'test', { sessionId: 'sid-1' })
    t = await getTask(id)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.unread).toBe(true)
  })

  it('a human message into a running turn ends the wait with no phase move', async () => {
    const id = await waitingTask('IN_PROGRESS')
    const res = await applySessionPhase(id, 'session:input', 'test', { sessionId: 'sid-1', reopenTerminal: true })
    expect(res.changed).toBe(false)
    const t = await getTask(id)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(t.waiting).toMatchObject({ woke_reason: 'message' })
  })

  it('an automated send (a trigger fire, auto-continue) keeps the wait', async () => {
    const id = await waitingTask('TODO')
    await applySessionPhase(id, 'session:input', 'test', { sessionId: 'sid-1' })
    const t = await getTask(id)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(isTaskWaiting(t)).toBe(true)
  })

  it('setting a status: To Do and In Progress keep the wait, Need Action ends it', async () => {
    const id = await waitingTask('TODO')
    await updateTask(id, { phase: 'TODO' }, { source: 'api' })
    expect(isTaskWaiting(await getTask(id))).toBe(true)
    // What every session start writes (claude-code-session.ts): not a human decision.
    await updateTask(id, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
    expect(isTaskWaiting(await getTask(id))).toBe(true)
    await updateTask(id, { phase: 'NEED_ACTION' }, { source: 'api' })
    const t = await getTask(id)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.waiting).toMatchObject({ routine_id: 'r-1', woke_reason: 'status-changed' })
  })

  it('a quiet turn end still tells a parent that asked for a reply', async () => {
    const id = await waitingTask('IN_PROGRESS')
    pendingRequests.push({ id: 'rq-parent-1' })
    await applySessionPhase(id, 'session:result', 'test', { sessionId: 'sid-1' })
    await vi.waitFor(() => expect(notified).toEqual([{ id: 'rq-parent-1', outcome: 'completed' }]))
    expect((await getTask(id)).phase).toBe('TODO')
  })

  it('a task that is not waiting leaves parents to the NEED_ACTION edge', async () => {
    const { task } = await addTask({ title: 'Plain', project: 'p' })
    await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' })
    pendingRequests.push({ id: 'rq-parent-2' })
    await applySessionPhase(task.id, 'session:result', 'test', { sessionId: 'sid-1' })
    await new Promise((r) => setTimeout(r, 200))
    expect(notified).toEqual([])
    expect((await getTask(task.id)).phase).toBe('NEED_ACTION')
  })
})
