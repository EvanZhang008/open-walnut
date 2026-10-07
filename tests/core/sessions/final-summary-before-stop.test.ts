/**
 * A session that completes its own task is stopped when that turn ends
 * (sessions/self-complete-stop.ts). Its summary of that last turn must reach
 * the task note first: once the CLI is gone nothing answers the self-report,
 * and a completed task has no next turn to catch up in.
 *
 * Real task store, session store and summary hook; the live session is a fake
 * in the runner's map whose askSideQuestion the test answers. owner-stop is
 * stubbed and records its calls; process.kill is spied on and must see nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { ownerStops } = vi.hoisted(() => ({
  ownerStops: [] as Array<{ sid: string; at: number }>,
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-final-summary-stop'))
vi.mock('../../../src/core/sessions/owner-stop.js', () => ({
  stopThroughOwner: async (row: { claudeSessionId: string }) => {
    ownerStops.push({ sid: row.claudeSessionId, at: Date.now() })
    return 'stopped'
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
  createSessionRecord,
  emitSessionStatusChanged,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { addTask, completeTask, getTask, linkSession, _resetForTesting } from '../../../src/core/task-manager.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { bus } from '../../../src/core/event-bus.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import {
  turnCompleteTriageHook,
  __resetTriageRateLimiter,
  __setFinalSummaryLimits,
} from '../../../src/core/session-hooks/builtins.js'
import { setSessionHookDispatcher, type SessionHookDispatcher } from '../../../src/core/session-hooks/index.js'
import { __setSelfCompleteSettleMs, _pendingSelfCompleteStopsForTest, _resetSelfCompleteStopsForTest } from '../../../src/core/sessions/self-complete-stop.js'
import type { OnTurnCompletePayload } from '../../../src/core/session-hooks/types.js'
import type { Task } from '../../../src/core/types.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const BASE = 2 ** 22
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const report = (workLog: string, signal = 'committed') => `EXEC_SUMMARY: Shipped the fix.
GOAL: unchanged
CONTEXT: unchanged
PROGRESS: unchanged
WORK_LOG: append: ${workLog}
RECAP: Shipped and closed the task.
WHAT_I_DID: committed the fix.
STATUS: succeeded
PHASE_SIGNAL: ${signal}
NEXT_STEPS: none
BLOCKERS: none
USER_INTENT: autonomous
VERIFIED: yes`

/** A fake live CLI whose self-report the test answers when it chooses. */
function liveSession(sid: string) {
  let answer: ((text: string) => void) | undefined
  const asked: string[] = []
  const fake = {
    sessionId: sid,
    turnGen: 1,
    askSideQuestion: vi.fn((q: string) => {
      asked.push(q)
      return new Promise<string>((resolve) => { answer = resolve })
    }),
    markExpectedTeardown: () => () => {},
    detach: () => {},
    kill: () => {},
    get active() { return true },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(sessionRunner as any).sessions.set(sid, fake)
  return {
    asked,
    answer: (text: string) => answer?.(text),
    /** The CLI starts another turn on its own (a background command's follow-up). */
    nextTurn: () => { fake.turnGen++ },
  }
}

let notices: unknown[]

async function runningTask(sid: string): Promise<Task> {
  const { task } = await addTask({ title: 'Ship the fix' })
  await createSessionRecord(sid, task.id, 'proj', undefined, { pid: BASE + 1 })
  await updateSessionRecord(sid, { process_status: 'running' })
  await linkSession(task.id, sid)
  return getTask(task.id)
}

function turnPayload(sid: string, task: Task): OnTurnCompletePayload {
  return {
    sessionId: sid, taskId: task.id, task,
    session: { provider: 'claude-code', cwd: '/tmp/x' } as OnTurnCompletePayload['session'],
    result: 'Done: shipped.', totalCost: 0, duration: 1, turnIndex: 1, isPlanSession: false,
  } as OnTurnCompletePayload
}

async function turnEnds(sid: string) {
  const rec = await updateSessionRecord(sid, { process_status: 'idle' })
  emitSessionStatusChanged(rec, {}, ['*'], { source: 'session-runner' })
}

const summaryHookOn = () => setSessionHookDispatcher({ getHooks: () => [turnCompleteTriageHook] } as unknown as SessionHookDispatcher)

beforeEach(async () => {
  closeTaskDb()
  closeSessionDb()
  _resetSessionTrackerForTesting()
  _resetForTesting()
  _resetSelfCompleteStopsForTest()
  __setSelfCompleteSettleMs(0)
  __resetTriageRateLimiter()
  __setFinalSummaryLimits({ startMs: 300, finishMs: 2_000 })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  // A normal turn would wait 10 minutes: anything sooner is the final summary.
  await updateConfig({ agent: { triage: { debounce_minutes: 10, notify_mode: 'off' } } })
  ownerStops.length = 0
  notices = []
  bus.subscribe('test-final-summary-notices', (e) => { notices.push(e.data) }, { global: true, interest: ['subagent:result'] })
  summaryHookOn()
  vi.spyOn(process, 'kill').mockImplementation((() => { throw new Error('no signal may be sent') }) as typeof process.kill)
})

afterEach(async () => {
  bus.unsubscribe('test-final-summary-notices')
  setSessionHookDispatcher(null)
  __setFinalSummaryLimits()
  __setSelfCompleteSettleMs()
  vi.restoreAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (sessionRunner as any).sessions as Map<string, unknown>
  for (const k of [...map.keys()]) if (k.startsWith('fs-')) map.delete(k)
  closeTaskDb()
  closeSessionDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the last turn of a session that completed its own task', () => {
  it('is summarized at once, and the session stops only after the note has it', async () => {
    const sid = 'fs-main'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))

    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))
    await turnEnds(sid)
    await sleep(400) // past the start limit: the run had started, so the stop waits for it
    expect(ownerStops).toEqual([])

    const answeredAt = Date.now()
    cli.answer(report('closed the task after shipping ✓'))
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    expect(ownerStops[0].at).toBeGreaterThanOrEqual(answeredAt)
    const after = await getTask(task.id)
    expect(after.note).toContain('closed the task after shipping ✓')
    expect(after.phase).toBe('COMPLETE')
    // committed would notify an open task; a completed one only records it.
    expect(notices).toEqual([])
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('waits for an onTurnComplete that arrives after the turn end', async () => {
    const sid = 'fs-late'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))

    await turnEnds(sid)
    await sleep(100)
    expect(ownerStops).toEqual([])
    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))
    cli.answer(report('late hook'))
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    expect((await getTask(task.id)).note).toContain('late hook')
  })

  it('a turn with no onTurnComplete (an error, a background follow-up) stops after the start limit, asking nothing', async () => {
    const sid = 'fs-none'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))

    const endedAt = Date.now()
    await turnEnds(sid)
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    expect(ownerStops[0].at - endedAt).toBeGreaterThanOrEqual(250)
    expect(cli.asked).toEqual([])
  })

  it('with the summary hook off, it stops at once', async () => {
    setSessionHookDispatcher(null)
    const sid = 'fs-off'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))

    const endedAt = Date.now()
    await turnEnds(sid)
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    expect(ownerStops[0].at - endedAt).toBeLessThan(250)
    expect(cli.asked).toEqual([])
  })

  it('a summary that never answers holds the stop only up to the finish limit', async () => {
    const sid = 'fs-hang'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))

    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))
    const endedAt = Date.now()
    await turnEnds(sid)
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
    expect(ownerStops[0].at - endedAt).toBeGreaterThanOrEqual(1_800)
  })

  it('an ask already out for an earlier turn is answered first, then the last turn is asked about', async () => {
    await updateConfig({ agent: { triage: { debounce_minutes: 0.001, notify_mode: 'off' } } })
    const sid = 'fs-inflight'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    // An earlier turn's ordinary summary fires (60ms debounce) and is still waiting for its answer.
    await turnCompleteTriageHook.handler!(turnPayload(sid, task))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))

    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))
    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await turnEnds(sid)
    await sleep(400)
    expect(ownerStops).toEqual([])
    expect(cli.asked).toHaveLength(1) // one question at a time

    // The earlier ask was sent while the task was open; its answer lands after the
    // completion and only records (its phase is read after the answer).
    cli.answer(report('earlier turn answer'))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(2))
    expect(ownerStops).toEqual([])
    cli.answer(report('the last turn, asked after it ended'))
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    const note = (await getTask(task.id)).note
    expect(note).toContain('earlier turn answer')
    expect(note).toContain('the last turn, asked after it ended')
    expect(notices).toEqual([])
  })

  it("the same turn's second onTurnComplete (result, then turn-settled) asks once", async () => {
    const sid = 'fs-twice'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))
    const payload = turnPayload(sid, await getTask(task.id))
    await turnCompleteTriageHook.handler!(payload)
    await turnCompleteTriageHook.handler!(payload)
    await turnEnds(sid)
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))
    cli.answer(report('one answer'))
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    expect(cli.asked).toHaveLength(1)
  })

  it('a background follow-up turn after the completing one is the turn the stop waits for', async () => {
    const sid = 'fs-followup'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))
    // The completing turn ends with a background command still running: the
    // session stays running, and that turn's summary is done long before the stop.
    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))
    cli.answer(report('completing turn'))
    await vi.waitFor(async () => expect((await getTask(task.id)).note).toContain('completing turn'))

    // The command finishes; the CLI runs its follow-up turn, which ends before
    // its own onTurnComplete arrives (settled by the snapshot).
    cli.nextTurn()
    await turnEnds(sid)
    await sleep(100)
    expect(ownerStops).toEqual([])
    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(2))
    cli.answer(report('follow-up turn'))
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual([sid]))
    expect((await getTask(task.id)).note).toContain('follow-up turn')
  })

  it('a task reopened while the summary runs keeps its session', async () => {
    const sid = 'fs-reopen'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([sid]))
    await turnCompleteTriageHook.handler!(turnPayload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked).toHaveLength(1))
    await turnEnds(sid)

    const { updateTask } = await import('../../../src/core/task-manager.js')
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    cli.answer(report('reopened mid-summary', 'reconfirmed'))
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([]))
    await sleep(150)
    expect(ownerStops).toEqual([])
  })
})

describe('a session that is not stopping keeps the ordinary debounce', () => {
  it('its turn is not summarized before the quiet window', async () => {
    const sid = 'fs-normal'
    const cli = liveSession(sid)
    const task = await runningTask(sid)
    await turnCompleteTriageHook.handler!(turnPayload(sid, task))
    await sleep(300)
    expect(cli.asked).toEqual([])
  })
})
