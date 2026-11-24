/**
 * The leader's half of a completed task's stop for a session its host runs and judges
 * (`judge: 'host'`; src/core/sessions/host-judged-complete.ts, session-tracker completeTaskSessions).
 * The twin of task-complete-stop-restart.test.ts, whose rows this server judges.
 *
 * A host naming session-complete-stop-v1 is asked (`takeCompletionStop`): the session that
 * completed its own task mid-turn, and every pass that did not just decide the completion (the
 * boot pass after a restart, a later write), ask `turn_end`, never cut the turn; a row whose copy
 * shows the host's marker is asked nothing more; one that does not is asked again. An older host
 * keeps the old way: this leader waits for the turn's end and then hands it the stop. An ask made
 * before the host's report says which waits for it; one the host did not take waits for its link.
 *
 * Real task and session stores, closed and reopened for the restart; the host's side is stubbed at
 * host-judged-controls.ts (each call recorded; HOST's link is `connected`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { HOST, connected, handed, asked } = vi.hoisted(() => ({
  HOST: 'devbox',
  connected: new Set<string>(),
  /** terminateOnHost calls: the old way's whole stop. */
  handed: [] as Array<{ sid: string; force?: boolean; by?: string }>,
  /** takeCompletionStop asks of a host that takes them. */
  asked: [] as Array<{ sid: string; when: string; reopens?: number }>,
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-complete-stop-host-judged'))
vi.mock('../../../src/core/sessions/owner-stop.js', () => ({
  ownerConnection: async () => ({ connected: true }),
  stopThroughOwner: async () => 'stopped',
  stopAcpThroughOwner: async () => 'stopped',
}))
vi.mock('../../../src/core/sessions/host-judged-controls.js', () => ({
  terminateOnHost: async (sid: string, opts: { force?: boolean; by?: string }) => {
    if (!connected.has(HOST)) throw new Error('host not linked')
    handed.push({ sid, ...opts })
    return { status: 'terminated', sessionId: sid }
  },
  onJudgingHost: async (sid: string, member: string, args: unknown[]) => {
    if (!connected.has(HOST)) throw new Error('host not linked')
    if (member !== 'takeCompletionStop') throw new Error(`unexpected member ${member}`)
    const a = args[0] as { when: string; reopens?: number }
    asked.push({ sid, when: a.when, ...(a.reopens !== undefined ? { reopens: a.reopens } : {}) })
    return { state: a.when === 'now' ? 'stopped' : a.when === 'cancel' ? 'cancelled' : 'turn_end' }
  },
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { markExpectedTeardown: () => () => {} },
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
  createSessionRecord, emitSessionStatusChanged, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import {
  addTask, completeTask, linkSession, migrateCompletedTaskSessions, updateTask, _resetForTesting,
} from '../../../src/core/task-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import {
  __setSelfCompleteSettleMs, _pendingSelfCompleteStopsForTest, _resetSelfCompleteStopsForTest,
} from '../../../src/core/sessions/self-complete-stop.js'
import {
  _completionStopsWaitingForTesting, _resetHostJudgedCompleteForTesting, noteHostCompleteStop, retryCompletionStopsFor,
} from '../../../src/core/sessions/host-judged-complete.js'
import { writingAsHost } from '../../../src/core/sessions/session-row-owner.js'
import { loadTurnRetriers } from '../../../src/core/sessions/turn-run.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const PID = 2 ** 22 + 11
let signals: Array<[number, unknown]>

/** What the host's service writes of its own row, as the channel brings it here. */
const hostWrites = (sid: string, patch: Parameters<typeof updateSessionRecord>[1]) =>
  writingAsHost(() => updateSessionRecord(sid, patch))

async function hostTask(sid: string) {
  const { task } = await addTask({ title: 'Ship the fix' })
  await createSessionRecord(sid, task.id, 'proj', undefined, { pid: PID, host: HOST })
  await hostWrites(sid, { judge: 'host', process_status: 'running' })
  await linkSession(task.id, sid)
  return task
}

async function turnEnds(sid: string) {
  const rec = await hostWrites(sid, { process_status: 'idle' })
  emitSessionStatusChanged(rec, {}, ['*'], { source: 'session-runner' })
}

/** A deploy of the leader: everything in memory is gone (the host's last report too), the stores stay. */
function restart() {
  _resetSelfCompleteStopsForTest()
  _resetHostJudgedCompleteForTesting()
  closeTaskDb()
  closeSessionDb()
  _resetSessionTrackerForTesting()
  _resetForTesting()
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => { await loadTurnRetriers() })

beforeEach(async () => {
  restart()
  __setSelfCompleteSettleMs(0)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  connected.clear()
  connected.add(HOST)
  handed.length = 0
  asked.length = 0
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'the leader never signals a host-judged session').toEqual([])
  __setSelfCompleteSettleMs()
  vi.restoreAllMocks()
  restart()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a host that takes the stop itself (session-complete-stop-v1)', () => {
  beforeEach(() => { noteHostCompleteStop(HOST, 'takes') })

  it('a session that completes its own task mid-turn: its host is asked turn_end; the leader neither waits nor cuts it', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(asked).toEqual([{ sid: 'self', when: 'turn_end', reopens: 0 }]))
    expect(_pendingSelfCompleteStopsForTest(), 'the wait is the host\'s').toEqual([])
    expect(handed).toEqual([])
    // The host keeps it on its row; a later write to the complete task asks nothing more.
    await hostWrites('self', { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })
    await updateTask(task.id, { title: 'Ship the fix, refined' })
    await settle()
    expect(asked).toHaveLength(1)
    expect(handed).toEqual([])
  })

  it('a leader restart: a row whose host recorded the stop is asked nothing, none is cut', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await hostWrites('self', { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })

    restart()
    noteHostCompleteStop(HOST, 'takes')
    await migrateCompletedTaskSessions()
    await settle()
    expect(asked).toHaveLength(1)
    expect(handed).toEqual([])
    expect(_pendingSelfCompleteStopsForTest(), 'the host\'s marker is not this leader\'s wait').toEqual([])
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'running', pid: PID })
  })

  it('a leader restart before the host took it: the boot pass asks turn_end again, at the host\'s report and link, never a stop now', async () => {
    const task = await hostTask('self')
    connected.delete(HOST)
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_completionStopsWaitingForTesting(HOST)).toEqual(['self']))
    expect(asked).toEqual([])

    // The leader restarts: its waiting asks and the host's last report are gone.
    restart()
    await migrateCompletedTaskSessions()
    await settle()
    expect(_completionStopsWaitingForTesting(HOST), 'waits for the host\'s report').toEqual(['self'])
    // A write to the complete task before the host is back changes nothing.
    await updateTask(task.id, { title: 'Ship the fix, refined' })
    await settle()
    expect(_completionStopsWaitingForTesting(HOST)).toEqual(['self'])

    // The host reports (it takes the stop) and links.
    connected.add(HOST)
    noteHostCompleteStop(HOST, 'takes')
    await vi.waitFor(() => expect(asked).toEqual([{ sid: 'self', when: 'turn_end', reopens: 0 }]))
    retryCompletionStopsFor(HOST)
    await settle()
    expect(asked).toHaveLength(1)
    expect(handed).toEqual([])
    expect(await getSessionByClaudeId('self'), 'never written stopped by the leader').toMatchObject({ process_status: 'running', pid: PID })
  })

  it('a reopen tells the host to drop the stop it waits to make', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await hostWrites('self', { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    await vi.waitFor(() => expect(asked.map((a) => a.when)).toEqual(['turn_end', 'cancel']))
  })

  it('a new completion asks again even while the copy still shows a marker the host dropped; a later write does not', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    // The host vetoed and dropped its marker; this copy has not heard yet.
    await hostWrites('self', { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    await completeTask(task.id)
    await vi.waitFor(() => expect(asked.map((a) => a.when)).toEqual(['turn_end', 'cancel', 'now']))
    await updateTask(task.id, { title: 'Ship the fix, refined' })
    await settle()
    expect(asked).toHaveLength(3)
  })

  it('a completion decided from the board asks now', async () => {
    const task = await hostTask('board')
    await completeTask(task.id)
    await vi.waitFor(() => expect(asked).toEqual([{ sid: 'board', when: 'now', reopens: 0 }]))
    expect(handed).toEqual([])
  })
})

describe('an older host (no session-complete-stop-v1): the old way', () => {
  beforeEach(() => { noteHostCompleteStop(HOST, 'old') })

  it('the leader waits for the turn\'s end, then hands the stop over once, when the host links', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    expect(handed, 'the turn that completed the task is not cut').toEqual([])
    expect(asked, 'an older host is never asked').toEqual([])
    expect((await getSessionByClaudeId('self'))?.taskCompleteStop, 'its row is its host\'s').toBeUndefined()

    connected.delete(HOST)
    await turnEnds('self')
    await vi.waitFor(() => expect(_completionStopsWaitingForTesting(HOST)).toEqual(['self']), { timeout: 10_000 })
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
    expect(await getSessionByClaudeId('self'), 'never written stopped by the leader').toMatchObject({ process_status: 'idle', pid: PID })

    connected.add(HOST)
    retryCompletionStopsFor(HOST)
    await vi.waitFor(() => expect(handed).toEqual([{ sid: 'self', force: true, by: 'task_completed' }]))
    expect(_completionStopsWaitingForTesting(HOST)).toEqual([])
  })

  it('a host that went back to an older Walnut: the marker it left is not read, the old way stops it', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    // The marker a newer service of this host wrote before it went back.
    await hostWrites('self', { taskCompleteStop: { at: new Date().toISOString(), state: 'turn_end', actor: true, reopens: 0 } })
    restart()
    noteHostCompleteStop(HOST, 'old')
    await migrateCompletedTaskSessions()
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest(), 'this leader waits for the turn itself').toEqual(['self']))
    expect(asked).toEqual([])
    await turnEnds('self')
    await vi.waitFor(() => expect(handed.map((h) => h.sid)).toEqual(['self']), { timeout: 10_000 })
  })

  it('the boot pass after a leader restart waits for the turn\'s end too, instead of a stop mid-turn', async () => {
    const task = await hostTask('self')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    restart()
    noteHostCompleteStop(HOST, 'old')
    await migrateCompletedTaskSessions()
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    expect(handed).toEqual([])
    await turnEnds('self')
    await vi.waitFor(() => expect(handed.map((h) => h.sid)).toEqual(['self']), { timeout: 10_000 })
  })
})
