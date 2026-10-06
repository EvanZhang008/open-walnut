/**
 * A session that completes its own task is stopped when its turn ends, not at
 * once: stopping it at once cut the very Bash call running `task_complete`
 * (the CLI records a cut call as "The user doesn't want to proceed with this
 * tool use") and the turn's closing words (2026-10-05).
 *
 * Real task store + session store; owner-stop is stubbed and records its calls,
 * process.kill is spied on and must see nothing. Pids are fabricated above any
 * real pid limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { ownerStops, marks } = vi.hoisted(() => ({
  ownerStops: [] as Array<{ sid: string; host?: string; reason: string; why: string }>,
  marks: [] as Array<{ sid: string; reason: string }>,
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-self-complete-stop'))
vi.mock('../../../src/core/sessions/owner-stop.js', () => ({
  stopThroughOwner: async (row: { claudeSessionId: string; host?: string }, reason: string, why: string) => {
    ownerStops.push({ sid: row.claudeSessionId, host: row.host, reason, why })
    return 'stopped'
  },
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    markExpectedTeardown: (sid: string, reason: string) => { marks.push({ sid, reason }); return () => {} },
  },
}))
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string }) => s.process_status !== 'stopped' && s.process_status !== 'error',
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
vi.mock('../../../src/web/terminal/dtach-lifecycle.js', () => ({
  conditionalReap: async () => 'kept',
}))

import {
  completeTaskSessions,
  createSessionRecord,
  emitSessionStatusChanged,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { addTask, completeTask, linkSession, updateTask, _resetForTesting } from '../../../src/core/task-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import {
  _pendingSelfCompleteStopsForTest,
  _resetSelfCompleteStopsForTest,
} from '../../../src/core/sessions/self-complete-stop.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const BASE = 2 ** 22
let signals: Array<[number, unknown]>

/** A task with one CLI session per entry, each in the given process state. */
async function taskWithSessions(sessions: Array<{ sid: string; status: 'running' | 'idle'; host?: string; provider?: 'embedded' }>) {
  const { task } = await addTask({ title: 'Ship the fix' })
  let n = 0
  for (const s of sessions) {
    await createSessionRecord(s.sid, task.id, 'proj', undefined, {
      pid: BASE + ++n,
      ...(s.host ? { host: s.host } : {}),
      ...(s.provider ? { provider: s.provider } : {}),
    })
    await updateSessionRecord(s.sid, { process_status: s.status })
    await linkSession(task.id, s.sid)
  }
  return task
}

/** The turn's end as the runner and the snapshot report it: the record leaves 'running'. */
async function turnEnds(sid: string, status: 'idle' | 'error' = 'idle') {
  const rec = await updateSessionRecord(sid, { process_status: status })
  emitSessionStatusChanged(rec, {}, ['*'], { source: 'session-runner' })
}

/** A status event for the session that does not touch its record. */
function statusEvent(sid: string, process_status: 'running' | 'idle') {
  bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: sid, process_status }, ['*'], { source: 'test' })
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

const stoppedSids = () => ownerStops.map((s) => s.sid).sort()

beforeEach(async () => {
  closeTaskDb()
  closeSessionDb()
  _resetSessionTrackerForTesting()
  _resetForTesting()
  _resetSelfCompleteStopsForTest()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  ownerStops.length = 0
  marks.length = 0
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'no stop path may signal a pid it read from a record').toEqual([])
  vi.restoreAllMocks()
  closeTaskDb()
  closeSessionDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a session completing its own task', () => {
  it('keeps running until its turn ends, then stops through its daemon; the task\'s other sessions stop at once', async () => {
    const task = await taskWithSessions([
      { sid: 'self', status: 'running', host: 'devbox' },
      { sid: 'older', status: 'idle' },
    ])

    await completeTask(task.id, { actorSid: 'self' })

    await vi.waitFor(() => expect(stoppedSids()).toEqual(['older']))
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'running', pid: BASE + 1 })
    expect(_pendingSelfCompleteStopsForTest()).toEqual(['self'])

    await turnEnds('self')

    await vi.waitFor(() => expect(stoppedSids()).toEqual(['older', 'self']))
    expect(ownerStops.find((s) => s.sid === 'self')).toEqual({ sid: 'self', host: 'devbox', reason: 'maintenance', why: 'task_completed' })
    expect(marks.find((m) => m.sid === 'self')).toEqual({ sid: 'self', reason: 'task_completed' })
    const rec = await getSessionByClaudeId('self')
    expect(rec).toMatchObject({ process_status: 'stopped', status_reason: 'expected_teardown' })
    expect(rec?.pid).toBeUndefined()
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('a PATCH to COMPLETE from its own session waits for the turn end the same way', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])

    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'api', actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    expect(ownerStops).toEqual([])

    await turnEnds('self')
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['self']))
  })

  it('a turn that ends in an error ends the wait, and the error record is left as every completion leaves one', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))

    await turnEnds('self', 'error')
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([]))
    await settle()
    // completeTaskSessions skips an 'error' record (isTerminalSession) for any caller.
    expect(ownerStops).toEqual([])
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'error' })
  })

  it('the turn end is the status leaving running, not session:result (a background follow-up closes with the status alone)', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))

    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'self', taskId: task.id, result: 'Done.' }, ['session-runner'], { source: 'session-runner' })
    await settle()
    expect(ownerStops).toEqual([])

    await turnEnds('self')
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['self']))
  })

  it('nothing mid-turn stops it: a running status update, a failed message delivery, a write to the task without an actor', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))

    const rec = await getSessionByClaudeId('self')
    emitSessionStatusChanged(rec!, {}, ['*'], { source: 'session-runner' })
    bus.emit(EventNames.SESSION_ERROR, { sessionId: 'self', taskId: task.id, error: 'send failed', errorKind: 'delivery_failed' }, ['session-runner'], { source: 'session-runner' })
    // The background title refine and the cwd-rename detector write the complete task mid-turn.
    await updateTask(task.id, { title: 'Ship the fix, refined' })
    await settle()

    expect(ownerStops).toEqual([])
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'running', pid: BASE + 1 })
    expect(_pendingSelfCompleteStopsForTest()).toEqual(['self'])
  })

  it('is not stopped when the task was reopened before the turn ended', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api', actorSid: 'self' })

    await turnEnds('self')
    // The check reads the task store; give it every chance to (wrongly) stop.
    await settle(250)
    expect(ownerStops).toEqual([])
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'idle' })
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('a turn that has already started again by the time of the stop waits for its own end', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))

    // The turn ended and a new one began before the stop ran: the record says running.
    statusEvent('self', 'idle')
    await settle()
    expect(ownerStops).toEqual([])
    expect(_pendingSelfCompleteStopsForTest()).toEqual(['self'])

    await turnEnds('self')
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['self']))
  })

  it('stops at once when it is between turns (a completion replayed after the turn ended)', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'idle' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['self']))
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('a completion it repeats in the same turn still stops it once, at the turn end', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))

    await turnEnds('self')
    statusEvent('self', 'idle')
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['self']))
    await settle(100)
    expect(stoppedSids()).toEqual(['self'])
  })

  it('another session\'s turn end does not consume the wait', async () => {
    const task = await taskWithSessions([{ sid: 'self', status: 'running' }])
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))

    statusEvent('someone-else', 'idle')
    await settle(50)
    expect(_pendingSelfCompleteStopsForTest()).toEqual(['self'])
    expect(ownerStops).toEqual([])
  })
})

describe('completions made by anyone else stop every live session at once', () => {
  it('the board or a human (no actor)', async () => {
    const task = await taskWithSessions([{ sid: 'worker', status: 'running' }])
    await completeTask(task.id)
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['worker']))
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('a leader completing its worker\'s task', async () => {
    const task = await taskWithSessions([{ sid: 'worker', status: 'running' }])
    await completeTask(task.id, { actorSid: 'leader' })
    await vi.waitFor(() => expect(stoppedSids()).toEqual(['worker']))
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('an embedded session has no CLI to cut and is marked stopped at once', async () => {
    await taskWithSessions([{ sid: 'lane', status: 'running', provider: 'embedded' }])
    const updated = await completeTaskSessions(['lane'], { actorSid: 'lane' })
    expect(updated).toBe(1)
    expect(await getSessionByClaudeId('lane')).toMatchObject({ process_status: 'stopped' })
    expect(ownerStops).toEqual([])
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })
})
