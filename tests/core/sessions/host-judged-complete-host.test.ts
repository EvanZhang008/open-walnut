/**
 * The host's half of a completed task's stop (src/core/sessions/host-judged-complete.ts
 * takeCompletionStop): a host that runs and judges its sessions keeps a `turn_end` ask on its own
 * row, stops the session itself when its turn ends, and watches the ask again after its own
 * restart; the same ask taken twice stops it once; a `now` ask stops it at once; a task copy that
 * shows the task reopened since vetoes the stop.
 *
 * Real: a host replica's role and own-row writer, its session store (closed and reopened for the
 * restart), the real turn-end wait on the real bus. Stubbed: the stop itself (terminateSession,
 * which reaches this host's daemon) and this host's task copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { stops, taskCopy, refuse } = vi.hoisted(() => ({
  stops: [] as Array<{ sid: string; force?: boolean; by?: string }>,
  /** A stop that fails, with this status (404: the session is not there). */
  refuse: { status: 0 },
  taskCopy: new Map<string, { id: string; phase: string; reopens?: number }>(),
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-judged-complete-host', { CLOUD_MODE: false }))
vi.mock('../../../src/core/sessions/session-lifecycle.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/sessions/session-lifecycle.js')>()),
  terminateSession: async (sid: string, opts: { force?: boolean; by?: string }) => {
    stops.push({ sid, ...opts })
    if (refuse.status) throw Object.assign(new Error('refused'), { status: refuse.status })
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    await updateSessionRecord(sid, { process_status: 'stopped', pid: undefined })
    return { status: 'terminated', sessionId: sid }
  },
}))
vi.mock('../../../src/core/task-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/task-manager.js')>()),
  listTasksByIds: async (ids: string[]) => ids.map((id) => taskCopy.get(id)).filter(Boolean),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import {
  __setHostSummaryWaitMs, _awaitingLeaderSummaryForTest, _stopRetriesArmedForTest, _resetHostJudgedCompleteForTesting,
  completionSummaryDone, takeCompletionStop,
} from '../../../src/core/sessions/host-judged-complete.js'
import {
  __setSelfCompleteSettleMs, _pendingSelfCompleteStopsForTest, _resetSelfCompleteStopsForTest, _selfCompleteStoppingForTest,
} from '../../../src/core/sessions/self-complete-stop.js'
import { resumeTaskCompleteStops } from '../../../src/core/sessions/task-complete-stop.js'
import { loadTurnRetriers } from '../../../src/core/sessions/turn-run.js'

const KEY = 'devbox'
let n = 0
let sid = ''
/** The task of the newest own row (one session per task). */
let TASK = ''

async function ownRow(status: 'running' | 'idle' = 'running'): Promise<string> {
  const id = `cccccccc-3333-4333-8333-${String(++n).padStart(12, '0')}`
  TASK = `task-host-${n}`
  taskCopy.set(TASK, { id: TASK, phase: 'COMPLETE', reopens: 0 })
  await tracker.createSessionRecord(id, TASK, 'Marina', '/tmp', { host: KEY, judge: 'host', pid: 2 ** 22 + n } as never)
  await tracker.updateSessionRecord(id, { process_status: status })
  return id
}

async function turnEnds(id: string): Promise<void> {
  const rec = await tracker.updateSessionRecord(id, { process_status: 'idle' })
  tracker.emitSessionStatusChanged(rec, {}, ['*'], { source: 'session-runner' })
}

/** This host's service restarts: what it held in memory is gone, its store stays. */
function restartHost(): void {
  _resetSelfCompleteStopsForTest()
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  sessionDb.allowOwnRowWrites(KEY)
}

const ask = (when: 'now' | 'turn_end', reopens = 0) => ({ at: new Date().toISOString(), when, reopens })

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  sessionDb.applySessionCopy({ rows: [] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
  __setSelfCompleteSettleMs(0)
  // The leader's summary of the last turn is told at once in these cases (the summary cases set their own wait).
  __setHostSummaryWaitMs(0)
  // The retry rows load at a server's start; loaded here so a wait's first look is quick.
  await loadTurnRetriers()
})

afterAll(async () => {
  __setSelfCompleteSettleMs()
  _resetSelfCompleteStopsForTest()
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  _resetSelfCompleteStopsForTest()
  _resetHostJudgedCompleteForTesting()
  stops.length = 0
  refuse.status = 0
  taskCopy.clear()
})

describe('the host waits for its leader\'s summary of the last turn before it stops', () => {
  afterAll(() => { __setHostSummaryWaitMs(0) })

  it('the stop waits for the leader\'s word that the summary is done', async () => {
    __setHostSummaryWaitMs(60_000)
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    await turnEnds(sid)
    await vi.waitFor(() => expect(_awaitingLeaderSummaryForTest()).toEqual([sid]), { timeout: 5_000 })
    expect(stops, 'the CLI must still answer the leader\'s self-report').toEqual([])
    expect(await completionSummaryDone(sid, {})).toEqual({ ok: true })
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
    expect(_awaitingLeaderSummaryForTest()).toEqual([])
  })

  it('no summary will come (the leader said so at the ask): the stop does not wait', async () => {
    __setHostSummaryWaitMs(60_000)
    sid = await ownRow('running')
    await takeCompletionStop(sid, { ...ask('turn_end'), summary: false })
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
  })

  it('a word for the turn that ended does not stand for a follow-up turn: that one waits for its own', async () => {
    __setHostSummaryWaitMs(60_000)
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    await turnEnds(sid)
    await vi.waitFor(() => expect(_awaitingLeaderSummaryForTest()).toEqual([sid]), { timeout: 5_000 })
    // A follow-up turn starts before the word comes.
    await tracker.updateSessionRecord(sid, { process_status: 'running' })
    await completionSummaryDone(sid, {})
    // The stop saw the turn running again and waits for its end (the wait, not the stop, holds it).
    await vi.waitFor(() => {
      expect(_selfCompleteStoppingForTest()).toEqual([])
      expect(_pendingSelfCompleteStopsForTest()).toEqual([sid])
    }, { timeout: 5_000 })
    expect(stops).toEqual([])
    await turnEnds(sid)
    await vi.waitFor(() => expect(_awaitingLeaderSummaryForTest()).toEqual([sid]), { timeout: 5_000 })
    expect(stops, 'waits for the follow-up turn\'s own word').toEqual([])
    await completionSummaryDone(sid, {})
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
  })

  it('a reopen the task copy shows by the time the word comes: the marker goes, nothing stops', async () => {
    __setHostSummaryWaitMs(60_000)
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end', 0))
    await turnEnds(sid)
    await vi.waitFor(() => expect(_awaitingLeaderSummaryForTest()).toEqual([sid]), { timeout: 5_000 })
    taskCopy.set(TASK, { id: TASK, phase: 'IN_PROGRESS', reopens: 1 })
    await completionSummaryDone(sid, {})
    await vi.waitFor(async () => expect((await tracker.getSessionByClaudeId(sid))?.taskCompleteStop).toBeUndefined(), { timeout: 5_000 })
    expect(stops).toEqual([])
  })

  it('a word that came before the turn\'s end counts; no word stops it after the wait\'s limit', async () => {
    __setHostSummaryWaitMs(60_000)
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    await completionSummaryDone(sid, {})
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })

    stops.length = 0
    __setHostSummaryWaitMs(300)
    const quiet = await ownRow('running')
    await takeCompletionStop(quiet, ask('turn_end'))
    await turnEnds(quiet)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([quiet]), { timeout: 5_000 })
  })
})

describe('a host stops its own completed session', () => {
  it('a turn_end ask is kept on its own row, never cuts the turn, and stops it once when the turn ends', async () => {
    sid = await ownRow('running')
    expect(await takeCompletionStop(sid, ask('turn_end'))).toEqual({ state: 'turn_end' })
    // Taken again (a later pass of the leader that did not see the marker yet): no second wait.
    expect(await takeCompletionStop(sid, ask('turn_end'))).toEqual({ state: 'turn_end' })
    expect((await tracker.getSessionByClaudeId(sid))?.taskCompleteStop).toMatchObject({ state: 'turn_end', actor: true, reopens: 0 })
    expect(_pendingSelfCompleteStopsForTest()).toEqual([sid])
    expect(stops, 'the turn that completed the task goes on').toEqual([])

    await turnEnds(sid)
    await vi.waitFor(() => expect(stops).toEqual([{ sid, force: true, by: 'task_completed' }]), { timeout: 5_000 })
    await vi.waitFor(async () => expect((await tracker.getSessionByClaudeId(sid))?.taskCompleteStop).toBeUndefined())
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
    // The leader asks again after its own restart: the session is stopped, nothing more happens.
    expect(await takeCompletionStop(sid, ask('turn_end'))).toEqual({ state: 'stopped' })
    expect(stops).toHaveLength(1)
  })

  it('the wait survives this host\'s restart: watched again from its own row, stopped at the turn\'s end', async () => {
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    restartHost()
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])

    expect(await resumeTaskCompleteStops()).toBe(1)
    expect(_pendingSelfCompleteStopsForTest()).toEqual([sid])
    expect(stops).toEqual([])
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
  })

  it('a now ask stops it at once; on a session already waiting for its turn it keeps waiting', async () => {
    const board = await ownRow('running')
    expect(await takeCompletionStop(board, ask('now'))).toEqual({ state: 'stopped' })
    expect(stops.map((s) => s.sid)).toEqual([board])

    stops.length = 0
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    expect(await takeCompletionStop(sid, ask('now'))).toEqual({ state: 'turn_end' })
    expect(stops).toEqual([])
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
  })

  it('a task copy that shows the task reopened since vetoes the stop; a copy that lags does not', async () => {
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end', 0))
    // Lagging: the copy still shows the phase before the completion, with no reopen counted.
    taskCopy.set(TASK, { id: TASK, phase: 'IN_PROGRESS', reopens: 0 })
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })

    stops.length = 0
    const again = await ownRow('running')
    await takeCompletionStop(again, ask('turn_end', 0))
    taskCopy.set(TASK, { id: TASK, phase: 'IN_PROGRESS', reopens: 1 })
    await turnEnds(again)
    await vi.waitFor(async () => expect((await tracker.getSessionByClaudeId(again))?.taskCompleteStop).toBeUndefined(), { timeout: 5_000 })
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
    expect(stops).toEqual([])
  })

  it('a marker left on a row already stopped (this host restarted between the stop and its clear): resumed, it only goes, no second stop', async () => {
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    await tracker.updateSessionRecord(sid, { process_status: 'stopped', pid: undefined })
    restartHost()
    expect(await resumeTaskCompleteStops()).toBe(1)
    await vi.waitFor(async () => expect((await tracker.getSessionByClaudeId(sid))?.taskCompleteStop).toBeUndefined(), { timeout: 5_000 })
    expect(stops).toEqual([])
  })

  it('a cancel (its task reopened on the leader) drops the wait and the marker; the turn\'s end stops nothing', async () => {
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    expect(await takeCompletionStop(sid, ask('cancel'))).toEqual({ state: 'cancelled' })
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
    expect((await tracker.getSessionByClaudeId(sid))?.taskCompleteStop).toBeUndefined()
    await turnEnds(sid)
    // Completed again later: taken again, and stopped at that turn's end.
    expect(await takeCompletionStop(sid, ask('turn_end'))).toEqual({ state: 'turn_end' })
    expect(stops).toEqual([])
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
  })

  it('an ask whose reopen count the leader did not know is never vetoed by the task copy', async () => {
    sid = await ownRow('running')
    await takeCompletionStop(sid, { at: new Date().toISOString(), when: 'turn_end' })
    taskCopy.set(TASK, { id: TASK, phase: 'IN_PROGRESS', reopens: 2 })
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
  })

  it('a stop refused as final (the session is not there) is not tried again', async () => {
    sid = await ownRow('running')
    await takeCompletionStop(sid, ask('turn_end'))
    refuse.status = 404
    await turnEnds(sid)
    await vi.waitFor(() => expect(stops.map((s) => s.sid)).toEqual([sid]), { timeout: 5_000 })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual([]))
    expect(_stopRetriesArmedForTest()).toEqual([])

    // One that may pass later is tried again after a poll.
    stops.length = 0
    refuse.status = 500
    const again = await ownRow('running')
    await takeCompletionStop(again, ask('turn_end'))
    await turnEnds(again)
    await vi.waitFor(() => expect(_stopRetriesArmedForTest()).toEqual([again]), { timeout: 5_000 })
  })

  it('a row this host does not own is not taken', async () => {
    const other = `dddddddd-4444-4444-8444-${String(++n).padStart(12, '0')}`
    expect(await takeCompletionStop(other, ask('turn_end'))).toEqual({ state: 'not_own' })
    expect(stops).toEqual([])
  })
})
