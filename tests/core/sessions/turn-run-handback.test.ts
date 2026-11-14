/**
 * A hand-back the phase held because Walnut continued the turn (sessions/turn-run.ts) goes ahead once
 * the retrier lets go without a new turn taking over; the runner and the server agree on a turn the
 * context recovery takes; a late new-turn clear never removes a later attempt.
 *
 * Found by the independent review of the turn record (2026-11-14, round 1): an endpoint wait a person
 * stopped, and a usage-limit wait closed on another error, left their tasks IN_PROGRESS with a dead
 * session; the runner cleared the session of a recoverable "Prompt is too long"; and a person's send
 * whose clear waited for the write lock deleted the attempt noted after it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('turn-run-handback'))
import { WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, updateSessionRecord, updateSessionRecordConditionally } from '../../../src/core/session-tracker.js'
import { addTask, updateTask, getTask } from '../../../src/core/task-manager.js'
import * as tasks from '../../../src/core/task-manager.js'
import { applySessionPhase, handBackTaskOnSessionEnd } from '../../../src/core/phase.js'
import { startEndpointWait } from '../../../src/core/sessions/endpoint-wait.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { startUsageLimitWait } from '../../../src/core/sessions/usage-limit-wait.js'
import { startContextFullRecovery } from '../../../src/core/sessions/context-full-recovery.js'
import { __resetTurnRunForTesting, __setHeldHandBackRecheckForTesting, __setTurnRetrierForTesting, turnRetryEnded, turnEndKeepsPhase, noteTurnAttempt, startTurnRun } from '../../../src/core/sessions/turn-run.js'
import * as tracker from '../../../src/core/session-tracker.js'

beforeEach(async () => {
  closeDb(); _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
// The spies first: one taken on a fake setTimeout would otherwise be restored to the fake.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); __resetTurnRunForTesting(); __setHeldHandBackRecheckForTesting(null); closeDb(); _resetSessionTrackerForTesting() })

describe('what the turn record holds is let go', () => {
  it('an endpoint wait stopped by a person releases its held hand-back', async () => {
    const { task } = await addTask({ title: 'Stopped wait' })
    await updateTask(task.id, { phase: 'IN_PROGRESS' })
    await createSessionRecord('sid-stopped', task.id, 'demo')
    await updateSessionRecord('sid-stopped', {
      process_status: 'stopped', status_reason: 'user_stopped', status_changed_by: 'user',
      endpointWait: { state: 'waiting', host: '__local__', where: 'this machine', since: new Date().toISOString(), resumes: 0 },
    })
    const waiter = startEndpointWait({ deps: {
      listSessions: async () => [], holdsOff: async () => 'person-stopped',
      getSession: async (sid) => getSessionByClaudeId(sid),
    } })
    try {
      await handBackTaskOnSessionEnd(task.id, 'sid-stopped', 'snapshot-apply:push')
      await (waiter.instance as any).tick('sid-stopped')
      expect((await getSessionByClaudeId('sid-stopped'))?.endpointWait).toBeUndefined()
      // The held hand-back goes ahead once the wait closed (turnRetryEnded).
      for (let i = 0; i < 100 && (await getTask(task.id)).phase === 'IN_PROGRESS'; i++) await new Promise((r) => setTimeout(r, 10))
      expect((await getTask(task.id)).phase).toBe('NEED_ACTION')
    } finally { waiter.stop() }
  })

  it('a delayed new-turn clear never removes a later retry attempt', async () => {
    await createSessionRecord('sid-race', '', 'demo')
    const handle = await startTurnRun()
    await noteTurnAttempt('sid-race', 'endpoint_wait')
    let unblock!: () => void
    const blocked = new Promise<void>((r) => { unblock = r })
    let entered!: () => void
    const hasEntered = new Promise<void>((r) => { entered = r })
    const realWrite = tracker.updateSessionRecordConditionally
    vi.spyOn(tracker, 'updateSessionRecordConditionally').mockImplementation(async (sid, patch, predicate, options) => {
      if ('turn' in patch && patch.turn === undefined) { entered(); await blocked }
      return realWrite(sid, patch, predicate, options)
    })
    try {
      bus.emit(EventNames.SESSION_SEND, { sessionId: 'sid-race', message: 'new question' }, ['*'], { source: 'ui' })
      await hasEntered
      // Noted after the send: it waits behind the clear, and the clear takes only what came before the send.
      await new Promise((r) => setTimeout(r, 5))
      const noted = noteTurnAttempt('sid-race', 'usage_limit')
      unblock()
      await noted
      expect((await getSessionByClaudeId('sid-race'))?.turn?.attempts.map((a) => a.reason)).toEqual(['usage_limit'])
    } finally { unblock(); handle.stop() }
  })
  it('another error releases the held phase after the wait closes', async () => {
    const { task } = await addTask({ title: 'Waiting task' })
    await updateTask(task.id, { phase: 'IN_PROGRESS' })
    await createSessionRecord('sid-limit', task.id, 'demo')
    await updateSessionRecord('sid-limit', {
      process_status: 'error', errorMessage: 'Other API failure',
      usageLimit: { state: 'waiting', engine: 'claude', since: new Date().toISOString(), resumes: 0, tries: 0 },
    })
    let unblock!: () => void
    const blocked = new Promise<void>((r) => { unblock = r })
    let entered!: () => void
    const hasEntered = new Promise<void>((r) => { entered = r })
    const waiter = startUsageLimitWait({ pickUp: false, deps: {
      patchWait: async (sid, fn) => {
        entered(); await blocked
        await updateSessionRecordConditionally(sid, { usageLimit: fn((await getSessionByClaudeId(sid))?.usageLimit) ?? undefined }, () => true)
      },
    } })
    try {
      bus.emit(EventNames.SESSION_ERROR, { sessionId: 'sid-limit', taskId: task.id, error: 'Other API failure' }, ['*'])
      await hasEntered
      await applySessionPhase(task.id, 'session:error', 'server.ts:session-error', { sessionId: 'sid-limit' })
      unblock()
      for (let i = 0; i < 100 && (await getSessionByClaudeId('sid-limit'))?.usageLimit; i++) await new Promise((r) => setTimeout(r, 10))
      expect((await getSessionByClaudeId('sid-limit'))?.usageLimit).toBeUndefined()
      // The held hand-back replays once the wait closed (turnRetryEnded runs after the close).
      for (let i = 0; i < 100 && (await getTask(task.id)).phase === 'IN_PROGRESS'; i++) await new Promise((r) => setTimeout(r, 10))
      expect((await getTask(task.id)).phase).toBe('NEED_ACTION')
    } finally { unblock(); waiter.stop() }
  })

  it('the runner keeps the typed slot for a recoverable context error', async () => {
    const { task } = await addTask({ title: 'Overflow task' })
    const rec = await createSessionRecord('sid-overflow', task.id, 'demo')
    const recovery = startContextFullRecovery()
    try {
      const end = { event: 'result' as const, sessionId: 'sid-overflow', isError: true, result: 'Prompt is too long' }
      expect(await turnEndKeepsPhase({ ...end, record: rec })).toBe('context_recovery')
      // Without the record: the turn reads it itself.
      expect(await turnEndKeepsPhase(end)).toBe('context_recovery')
    } finally { recovery.stop() }
  })

  it('a wait that went away with no word from its retrier: the recheck lets the hand-back go; a session that moved on keeps its own', async () => {
    __setHeldHandBackRecheckForTesting([30])
    try {
      const { task } = await addTask({ title: 'Opening wait never written' })
      await updateTask(task.id, { phase: 'IN_PROGRESS' })
      await createSessionRecord('sid-opening', task.id, 'demo')
      await updateSessionRecord('sid-opening', {
        process_status: 'error', errorMessage: 'API Error: 500',
        usageLimit: { state: 'waiting', engine: 'claude', since: new Date().toISOString(), resumes: 0, tries: 0 },
      })
      await applySessionPhase(task.id, 'session:error', 'server.ts:session-error', { sessionId: 'sid-opening' })
      expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
      // Still held at the recheck: kept.
      await new Promise((r) => setTimeout(r, 80))
      expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
      // The wait is gone (no retrier said so): the next recheck hands it back.
      await updateSessionRecordConditionally('sid-opening', { usageLimit: undefined }, () => true)
      for (let i = 0; i < 100 && (await getTask(task.id)).phase === 'IN_PROGRESS'; i++) await new Promise((r) => setTimeout(r, 10))
      expect((await getTask(task.id)).phase).toBe('NEED_ACTION')

      // Held again on another task whose session then ran a new turn: that turn hands back for itself.
      const { task: other } = await addTask({ title: 'Moved on' })
      await updateTask(other.id, { phase: 'IN_PROGRESS' })
      await createSessionRecord('sid-moved', other.id, 'demo')
      await updateSessionRecord('sid-moved', {
        process_status: 'error', errorMessage: 'API Error: 500',
        usageLimit: { state: 'waiting', engine: 'claude', since: new Date().toISOString(), resumes: 0, tries: 0 },
      })
      await applySessionPhase(other.id, 'session:error', 'server.ts:session-error', { sessionId: 'sid-moved' })
      await updateSessionRecord('sid-moved', { process_status: 'running', usageLimit: undefined })
      await new Promise((r) => setTimeout(r, 150))
      expect((await getTask(other.id)).phase).toBe('IN_PROGRESS')
    } finally {
      __setHeldHandBackRecheckForTesting(null)
    }
  })
})

async function heldTask(sid: string) {
  const { task } = await addTask({ title: 'Held turn' })
  await updateTask(task.id, { phase: 'IN_PROGRESS' })
  await createSessionRecord(sid, task.id, 'demo')
  await updateSessionRecord(sid, {
    process_status: 'error', errorMessage: 'API Error: 500',
    usageLimit: { state: 'waiting', engine: 'claude', since: new Date().toISOString(), resumes: 0, tries: 0 },
  })
  await applySessionPhase(task.id, 'session:error', 'server.ts:session-error', { sessionId: sid })
  return task
}

describe('a held hand-back never hands back a turn that moved on (review round 2)', () => {
  it('a resumed session wins even after replay passed its first status check', async () => {
    const task = await heldTask('sid-race')
    await updateSessionRecordConditionally('sid-race', { usageLimit: undefined }, () => true)
    const realWrite = tasks.updateTaskRaw
    let started!: () => void
    const atWrite = new Promise<void>((r) => { started = r })
    vi.spyOn(tasks, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      // A new turn starts after releaseHeldHandBack checked the status stamp,
      // but before the task write lock's shouldUpdate check.
      await updateSessionRecord('sid-race', { process_status: 'running' })
      started()
      return realWrite(...args)
    })
    turnRetryEnded('sid-race', 'usage_limit')
    await atWrite
    await new Promise((r) => setTimeout(r, 50))
    expect((await getSessionByClaudeId('sid-race'))?.process_status).toBe('running')
    expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
  })

  it('a new queued user message supersedes the old hand-back before the process status changes', async () => {
    const task = await heldTask('sid-new-send')
    const { startTurnRun } = await import('../../../src/core/sessions/turn-run.js')
    const { startUsageLimitWait } = await import('../../../src/core/sessions/usage-limit-wait.js')
    const { bus, EventNames } = await import('../../../src/core/event-bus.js')
    const run = await startTurnRun()
    const waiter = startUsageLimitWait({ pickUp: false })
    try {
      bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 'sid-new-send', message: 'new user question', messageId: 'qm-new' }, ['*'], { source: 'ui' })
      await vi.waitFor(async () => expect((await getSessionByClaudeId('sid-new-send'))?.usageLimit).toBeUndefined())
      // Negative: the wait closed (someone else sent), and the old error must not hand the task back.
      await new Promise((r) => setTimeout(r, 100))
      expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
    } finally { waiter.stop(); run.stop() }
  })

  it('an unchanged hold backs off from its original start instead of resetting each replay', async () => {
    __setHeldHandBackRecheckForTesting([10, 20, 30])
    await heldTask('sid-cadence')
    // Held again under a fake clock, so the rechecks can be driven.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    await applySessionPhase((await getSessionByClaudeId('sid-cadence'))!.taskId!, 'session:error', 'server.ts:session-error', { sessionId: 'sid-cadence' })
    expect(timer.mock.calls.at(-1)?.[1]).toBe(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(timer.mock.calls.at(-1)?.[1]).toBe(20)
  })

  it('a message that comes in while the phase is still deciding to hold drops that hold (review round 3)', async () => {
    __setHeldHandBackRecheckForTesting([20])
    const run = await startTurnRun()
    let first = true
    await __setTurnRetrierForTesting('usage_limit', {
      reason: 'usage_limit', sources: ['test-retrier'], takes: () => false,
      wait: (rec) => {
        if (!first || rec.claudeSessionId !== 'sid-gen') return null
        first = false
        // A person's message lands after the phase read the hold, before it notes it.
        queueMicrotask(() => bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 'sid-gen', message: 'new question', messageId: 'qm-gen' }, ['*'], { source: 'ui' }))
        return { reason: 'usage_limit', usageLimit: { state: 'waiting', engine: 'claude', since: new Date().toISOString(), resumes: 0, tries: 0 } }
      },
    })
    try {
      const { task } = await addTask({ title: 'New message mid-hold' })
      await updateTask(task.id, { phase: 'IN_PROGRESS' })
      await createSessionRecord('sid-gen', task.id, 'demo')
      await updateSessionRecord('sid-gen', { process_status: 'error', errorMessage: 'API Error: 500' })
      await applySessionPhase(task.id, 'session:error', 'server.ts:session-error', { sessionId: 'sid-gen' })
      await new Promise((r) => setTimeout(r, 150))
      // The new message drives the session: its own turn hands back, never the old error.
      expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
    } finally {
      await __setTurnRetrierForTesting('usage_limit', null)
      run.stop()
    }
  })
})
