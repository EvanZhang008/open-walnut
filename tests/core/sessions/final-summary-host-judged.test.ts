/**
 * The last turn of a session its host runs that completed its own task is summarized into the
 * task note before its host stops it (session-hooks/builtins.ts turnCompleteTriageHook,
 * sessions/host-judged-complete.ts). The wait for the turn's end is the host's (its own row's
 * marker), so this leader's in-memory wait is empty: the summary hook asks the row and the ask
 * instead, summarizes at once, and tells the host when it is done (`completionSummaryDone`),
 * which the host waits for before its stop.
 *
 * 2026-11-24 (review of the host-owned stop): the leader saw no wait of its own, so the turn went
 * to the 4-minute debounce; the host stopped the session about 13 s after the turn ended, and the
 * last turn's summary never reached the note.
 *
 * Real task store, session store and summary hook; the live session is a fake in the runner's map
 * whose self-report the test answers; the host is stubbed at host-judged-controls.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { hostCalls } = vi.hoisted(() => ({
  hostCalls: [] as Array<{ sid: string; member: string; arg: Record<string, unknown> }>,
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-final-summary-host-judged'))
vi.mock('../../../src/core/sessions/host-judged-controls.js', () => ({
  terminateOnHost: async () => { throw new Error('a host that takes the stop is never handed one') },
  onJudgingHost: async (sid: string, member: string, args: unknown[]) => {
    hostCalls.push({ sid, member, arg: (args[0] ?? {}) as Record<string, unknown> })
    return member === 'takeCompletionStop' ? { state: 'turn_end' } : { ok: true }
  },
}))
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string }) => s.process_status !== 'stopped' && s.process_status !== 'error',
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
vi.mock('../../../src/web/terminal/dtach-lifecycle.js', () => ({ conditionalReap: async () => 'kept' }))

import {
  createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { addTask, completeTask, getTask, linkSession, _resetForTesting } from '../../../src/core/task-manager.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import {
  turnCompleteTriageHook, __resetTriageRateLimiter, __setFinalSummaryLimits,
} from '../../../src/core/session-hooks/builtins.js'
import { setSessionHookDispatcher, type SessionHookDispatcher } from '../../../src/core/session-hooks/index.js'
import { _pendingSelfCompleteStopsForTest, _resetSelfCompleteStopsForTest } from '../../../src/core/sessions/self-complete-stop.js'
import { _resetHostJudgedCompleteForTesting, hostAwaitsCompletionStop, noteHostCompleteStop } from '../../../src/core/sessions/host-judged-complete.js'
import { writingAsHost } from '../../../src/core/sessions/session-row-owner.js'
import type { OnTurnCompletePayload } from '../../../src/core/session-hooks/types.js'
import type { Task } from '../../../src/core/types.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const HOST = 'devbox'

const report = (workLog: string) => `EXEC_SUMMARY: Shipped the fix.
GOAL: unchanged
CONTEXT: unchanged
PROGRESS: unchanged
WORK_LOG: append: ${workLog}
RECAP: Shipped and closed the task.
WHAT_I_DID: committed the fix.
STATUS: succeeded
PHASE_SIGNAL: committed
NEXT_STEPS: none
BLOCKERS: none
USER_INTENT: autonomous
VERIFIED: yes`

/** The session as the leader reaches it (the host's live session through its proxy): a self-report the test answers. */
function liveSession(sid: string) {
  let answer: ((text: string) => void) | undefined
  const asked: string[] = []
  const fake = {
    sessionId: sid,
    turnGen: 3,
    askSideQuestion: vi.fn((q: string) => { asked.push(q); return new Promise<string>((resolve) => { answer = resolve }) }),
    markExpectedTeardown: () => () => {},
    detach: () => {},
    kill: () => {},
    get active() { return true },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(sessionRunner as any).sessions.set(sid, fake)
  return { asked, answer: (text: string) => answer?.(text) }
}

const hostWrites = (sid: string, patch: Parameters<typeof updateSessionRecord>[1]) => writingAsHost(() => updateSessionRecord(sid, patch))

async function hostTask(sid: string): Promise<Task> {
  const { task } = await addTask({ title: 'Ship the fix' })
  await createSessionRecord(sid, task.id, 'proj', undefined, { pid: 2 ** 22 + 21, host: HOST })
  await hostWrites(sid, { judge: 'host', process_status: 'running' })
  await linkSession(task.id, sid)
  return getTask(task.id)
}

async function payload(sid: string, task: Task): Promise<OnTurnCompletePayload> {
  return {
    sessionId: sid, taskId: task.id, task, session: (await getSessionByClaudeId(sid)) ?? undefined,
    result: 'Done: shipped.', totalCost: 0, duration: 1, turnIndex: 1, isPlanSession: false,
  } as OnTurnCompletePayload
}

beforeEach(async () => {
  closeTaskDb()
  closeSessionDb()
  _resetSessionTrackerForTesting()
  _resetForTesting()
  _resetSelfCompleteStopsForTest()
  _resetHostJudgedCompleteForTesting()
  __resetTriageRateLimiter()
  __setFinalSummaryLimits({ startMs: 300, finishMs: 2_000 })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  // A normal turn would wait 10 minutes: anything sooner is the final summary.
  await updateConfig({ agent: { triage: { debounce_minutes: 10, notify_mode: 'off' } } })
  hostCalls.length = 0
  setSessionHookDispatcher({ getHooks: () => [turnCompleteTriageHook] } as unknown as SessionHookDispatcher)
  noteHostCompleteStop(HOST, 'takes')
})

afterEach(async () => {
  setSessionHookDispatcher(null)
  __setFinalSummaryLimits()
  vi.restoreAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (sessionRunner as any).sessions as Map<string, unknown>
  for (const k of [...map.keys()]) if (k.startsWith('fh-')) map.delete(k)
  closeTaskDb()
  closeSessionDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the last turn of a host-judged session that completed its own task', () => {
  it('is summarized at once into the note, and its host is told when the summary is done', async () => {
    const sid = 'fh-main'
    const cli = liveSession(sid)
    const task = await hostTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(hostCalls.map((c) => `${c.member}:${c.arg.when}`)).toEqual(['takeCompletionStop:turn_end']))
    expect(_pendingSelfCompleteStopsForTest(), 'the wait is the host\'s, not this leader\'s').toEqual([])
    // The host keeps it on its row; the copy here shows it.
    await hostWrites(sid, { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })

    // The turn ends on the host; its facts reach this leader's summary hook.
    await hostWrites(sid, { process_status: 'idle' })
    await turnCompleteTriageHook.handler!(await payload(sid, await getTask(task.id)))
    await vi.waitFor(() => expect(cli.asked, 'summarized at once, not after the debounce').toHaveLength(1), { timeout: 2_000 })
    expect(hostCalls.some((c) => c.member === 'completionSummaryDone'), 'not before the summary is written').toBe(false)

    cli.answer(report('closed the task on the host'))
    await vi.waitFor(() => expect(hostCalls.filter((c) => c.member === 'completionSummaryDone')).toEqual([
      { sid, member: 'completionSummaryDone', arg: { gen: 3 } },
    ]))
    expect((await getTask(task.id)).note).toContain('closed the task on the host')
  })

  it('a host not reported yet whose row shows its marker: its last turn is still summarized at once; an older host\'s is not', async () => {
    const sid = 'fh-down'
    await hostTask(sid)
    await hostWrites(sid, { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })
    _resetHostJudgedCompleteForTesting()
    expect(await hostAwaitsCompletionStop(sid)).toBe(true)
    noteHostCompleteStop(HOST, 'old')
    expect(await hostAwaitsCompletionStop(sid)).toBe(false)
  })

  it('the turn_end ask says whether a summary will come: the hook on, yes', async () => {
    const sid = 'fh-ask'
    liveSession(sid)
    const task = await hostTask(sid)
    await completeTask(task.id, { actorSid: sid })
    await vi.waitFor(() => expect(hostCalls.map((c) => c.member)).toEqual(['takeCompletionStop']))
    expect(hostCalls[0]!.arg.summary).toBeUndefined()
  })

  it('a host-judged session with no stop asked keeps the debounce', async () => {
    const sid = 'fh-plain'
    const cli = liveSession(sid)
    const task = await hostTask(sid)
    await hostWrites(sid, { process_status: 'idle' })
    await turnCompleteTriageHook.handler!(await payload(sid, task))
    await new Promise((r) => setImmediate(r))
    expect(cli.asked).toEqual([])
    expect(hostCalls).toEqual([])
  })
})
