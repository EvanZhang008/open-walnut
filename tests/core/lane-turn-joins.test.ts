/**
 * Messages sent into a running lane turn (runLaneTurn `onJoinable`,
 * core/sessions/lane-turn-joins.ts).
 *
 * The phone's Chat tab sends a message written while the Personal AI answers
 * straight into that turn (2026-11-09, the owner: "不要queue了 就像网页版也一样直接发出去",
 * then "而且order一定要对"). Pinned on the real runner, gate and event bus: when the
 * turn takes a message, that it goes to the lane in the order offered, that the turn
 * ends only once every message it took has an answer (in the same CLI turn or in
 * one of its own), that a result read before the CLI took the line never counts as
 * its answer (the write is not that moment: the review of 2026-11-09), that a
 * message that leaves the line unrun is not waited for, and that a failure never
 * loses the answer the turn already has. Only the send, the queue read and the
 * session record are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-turn-joins'))

const sendMessageToSession = vi.hoisted(() => vi.fn())
const getQueue = vi.hoisted(() => vi.fn())
const getSessionByClaudeId = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-message-queue.js', () => ({ sendMessageToSession, getQueue }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId }))
const movingFrom = vi.hoisted(() => vi.fn())
const switchingFrom = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/sessions/engine-switch.js', () => ({ movingFrom, switchingFrom }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import {
  runLaneTurn, LANE_TURN_STALL_MS, LANE_TURN_TICK_MS, type LaneTurnJoiner, type LaneTurnTarget, type LaneTurnResult,
} from '../../src/core/sessions/lane-turn.js'
import { MAX_JOINS_PER_TURN } from '../../src/core/sessions/lane-turn-joins.js'
import { _resetLaneGatesForTesting, laneGate } from '../../src/core/sessions/lane-turn-gate.js'
import { _resetSessionProgressForTesting } from '../../src/core/sessions/session-progress.js'

const SID = 'bbbbbbbb-1111-2222-3333-444444444444'
let nextId = 0

function lane(created = false): LaneTurnTarget {
  return {
    resolve: async () => ({ sessionId: SID, created }),
    catchUp: async (_sid, message) => ({ message }),
  }
}

function emit(name: string, data: Record<string, unknown>): void {
  bus.emit(name, data as never, ['main-ai'], { source: 'test' })
}
const delivered = (messageId: string, turnGen: number): void =>
  emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, count: 1, messageIds: [messageId], turnGen })
const result = (text: string, turnGen: number): void =>
  emit(EventNames.SESSION_RESULT, { sessionId: SID, result: text, turnGen })
/** The CLI took the line carrying these rows (`command_lifecycle started`). */
const taken = (...rowIds: string[]): void =>
  emit(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: `line-${rowIds.join('-')}`, rowIds })

async function yieldReal(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

async function sends(n: number): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    if (sendMessageToSession.mock.calls.length >= n) return
    await yieldReal(1)
  }
  throw new Error(`expected ${n} sends, saw ${sendMessageToSession.mock.calls.length}`)
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= LANE_TURN_TICK_MS) {
    await vi.advanceTimersByTimeAsync(Math.min(LANE_TURN_TICK_MS, left))
    await yieldReal()
  }
}

/** Start a turn on a reused lane and hand back its joiner once the turn's own send went out. */
async function startTurn(created = false): Promise<{ turn: Promise<LaneTurnResult>; joiner: LaneTurnJoiner; done: () => boolean }> {
  let joiner: LaneTurnJoiner | null = null
  let finished = false
  const turn = runLaneTurn('general', 'conv-j', 'the first question', {
    source: 'api-v1', target: lane(created), onJoinable: (j) => { joiner = j },
  })
  void turn.then(() => { finished = true })
  for (let i = 0; i < 5_000 && !joiner; i++) await yieldReal(1)
  if (!joiner) throw new Error('the turn never became joinable')
  return { turn, joiner, done: () => finished }
}

beforeEach(() => {
  bus.clear()
  _resetLaneGatesForTesting()
  _resetSessionProgressForTesting()
  nextId = 0
  sendMessageToSession.mockReset()
  sendMessageToSession.mockImplementation(async (_sid: string, _text: string, opts?: { messageId?: string }) =>
    ({ id: opts?.messageId ?? `qm-${++nextId}` }))
  getQueue.mockReset()
  getQueue.mockImplementation(async () => [])
  movingFrom.mockReset()
  switchingFrom.mockReset()
  getSessionByClaudeId.mockReset()
  // A CLI that reports its queue, as every current Claude Code does.
  getSessionByClaudeId.mockImplementation(async () => ({ process_status: 'running', status_reason: null, pid: 7, lineLifecyclePid: 7 }))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  _resetLaneGatesForTesting()
  bus.clear()
})

describe('a message sent into a running lane turn', () => {
  it('is refused until the CLI has the turn its own message', async () => {
    const { turn, joiner } = await startTurn()
    expect(joiner.offer('too early', 'qm-mobile-early')).toBeNull()
    delivered('qm-1', 1)
    const offer = joiner.offer('in time', 'qm-mobile-in-time')
    expect(offer).not.toBeNull()
    await offer
    delivered('qm-mobile-in-time', 1)
    taken('qm-mobile-in-time')
    result('both answered', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'both answered' })
  })

  it('taken by the CLI inside the turn (a tool boundary): the one result answers both', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    await expect(joiner.offer('also check the logs', 'qm-mobile-a')).resolves.toBeUndefined()
    expect(sendMessageToSession).toHaveBeenLastCalledWith(SID, 'also check the logs', { source: 'api-v1', messageId: 'qm-mobile-a' })
    delivered('qm-mobile-a', 1)
    taken('qm-mobile-a')
    result('Done, and the logs are clean.', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'Done, and the logs are clean.' })
  })

  it('written mid-turn but run by the CLI as a turn of its own: the first result is not its answer', async () => {
    // The order a real CLI gives when the model is writing its last words: the write
    // is reported delivered at once, the turn ends, then the CLI takes the line.
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('one more thing', 'qm-mobile-b')
    delivered('qm-mobile-b', 1)
    result('first answer', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    // Still taking messages while it waits.
    await joiner.offer('and another', 'qm-mobile-c')
    delivered('qm-mobile-c', 1)
    taken('qm-mobile-b', 'qm-mobile-c')
    result('second answer', 2)
    await expect(turn).resolves.toMatchObject({ resultText: 'first answer\n\nsecond answer' })
  })

  it('a lane that names a taken line is known to report its queue, whatever its record says', async () => {
    getSessionByClaudeId.mockImplementation(async () => ({ process_status: 'running', status_reason: null }))
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    taken('qm-1')
    await joiner.offer('later words', 'qm-mobile-d')
    delivered('qm-mobile-d', 1)
    result('answer to the first question', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    taken('qm-mobile-d')
    result('answer to the later words', 2)
    await expect(turn).resolves.toMatchObject({ resultText: 'answer to the first question\n\nanswer to the later words' })
  })

  it('a CLI that never reports its queue: the write is the delivery, and an older generation never answers it', async () => {
    getSessionByClaudeId.mockImplementation(async () => ({ process_status: 'running', status_reason: null, pid: 7 }))
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('later words', 'qm-mobile-l')
    delivered('qm-mobile-l', 2)
    result('answer to the first question', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    result('answer to the later words', 2)
    await expect(turn).resolves.toMatchObject({ resultText: 'answer to the first question\n\nanswer to the later words' })
  })

  it('goes to the lane in the order the messages were offered', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    const offered = ['order one', 'order two', 'order three']
    const pending = offered.map((text, i) => joiner.offer(text, `qm-mobile-o${i}`))
    await Promise.all(pending)
    expect(sendMessageToSession.mock.calls.slice(1).map((c) => c[1])).toEqual(offered)
    taken('qm-mobile-o0', 'qm-mobile-o1', 'qm-mobile-o2')
    result('all three', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'all three' })
  })

  it('takes at most MAX_JOINS_PER_TURN messages', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    const ids = Array.from({ length: MAX_JOINS_PER_TURN }, (_, i) => `qm-mobile-cap${i}`)
    await Promise.all(ids.map((id) => joiner.offer(id, id)))
    expect(joiner.offer('one too many', 'qm-mobile-over')).toBeNull()
    taken(...ids)
    result('done', 1)
    await turn
  })

  it('is refused once the turn is over', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    result('done', 1)
    await turn
    expect(joiner.offer('too late', 'qm-mobile-late')).toBeNull()
  })

  it('a send that fails is not waited for, and the answer the turn has stays', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    sendMessageToSession.mockImplementationOnce(async () => { throw new Error('queue write failed') })
    const offer = joiner.offer('lost words', 'qm-mobile-e')
    result('the answer', 1)
    await expect(offer).rejects.toThrow('queue write failed')
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
  })

  it('a message the CLI dropped unrun (parked) is not waited for', async () => {
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('never runs', 'qm-mobile-p')
    result('the answer', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    emit(EventNames.SESSION_BATCH_FAILED, { sessionId: SID, messageIds: ['qm-mobile-p'], error: 'discarded' })
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
  })

  it('a failed write whose row went back to the line is still waited for, and the retry counts', async () => {
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    getQueue.mockImplementation(async () => [{ id: 'qm-mobile-r', status: 'pending' }])
    await joiner.offer('try again', 'qm-mobile-r')
    delivered('qm-mobile-r', 1)
    emit(EventNames.SESSION_BATCH_FAILED, { sessionId: SID, messageIds: ['qm-mobile-r'], error: 'pipe closed' })
    result('the answer', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    getQueue.mockImplementation(async () => [])
    delivered('qm-mobile-r', 2)
    taken('qm-mobile-r')
    result('its answer', 2)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer\n\nits answer' })
  })

  it('a message a stop parked in the line is not waited for', async () => {
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    getQueue.mockImplementation(async () => [{ id: 'qm-mobile-s', status: 'pending' }])
    await joiner.offer('parked by a stop', 'qm-mobile-s')
    result('the answer', 1)
    await advance(LANE_TURN_TICK_MS)
    expect(done()).toBe(false)
    getQueue.mockImplementation(async () => [{ id: 'qm-mobile-s', status: 'parked' }])
    await advance(LANE_TURN_TICK_MS)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
  })

  it('a message the queue sent to the lane\'s new session is not waited for and not refused', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    sendMessageToSession.mockImplementationOnce(async (_sid: string, _t: string, o?: { messageId?: string }) =>
      ({ id: o?.messageId, sessionId: 'cccccccc-0000-0000-0000-000000000000' }))
    await expect(joiner.offer('moved along', 'qm-mobile-m')).resolves.toBeUndefined()
    result('the answer', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
  })

  it('a row off the line at one read and then written is still waited for', async () => {
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('in the write', 'qm-mobile-x')
    result('the answer', 1)
    await advance(LANE_TURN_TICK_MS) // off the line, its write not reported yet
    delivered('qm-mobile-x', 1)
    await advance(LANE_TURN_TICK_MS)
    expect(done()).toBe(false)
    taken('qm-mobile-x')
    result('its answer', 2)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer\n\nits answer' })
  })

  it('tells the caller once when the CLI is first written the message, and never for one withdrawn unrun', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    const wroteA = vi.fn()
    const wroteB = vi.fn()
    await joiner.offer('written', 'qm-mobile-wa', wroteA)
    await joiner.offer('withdrawn', 'qm-mobile-wb', wroteB)
    expect(wroteA).not.toHaveBeenCalled()
    delivered('qm-mobile-wa', 1)
    taken('qm-mobile-wa')
    expect(wroteA).toHaveBeenCalledTimes(1)
    emit(EventNames.SESSION_QUEUED_CANCELLED, { sessionId: SID, messageIds: ['qm-mobile-wb'] })
    result('the answer', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
    expect(wroteB).not.toHaveBeenCalled()
  })

  it('a cancel naming a message the CLI already has does not stop the wait for its answer', async () => {
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('already written', 'qm-mobile-y')
    delivered('qm-mobile-y', 1)
    emit(EventNames.SESSION_QUEUED_CANCELLED, { sessionId: SID, messageIds: ['qm-mobile-y'] })
    result('the answer', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    taken('qm-mobile-y')
    result('its answer', 2)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer\n\nits answer' })
  })

  it('a lane being moved to another session refuses the message, so it waits for the next turn', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    switchingFrom.mockImplementation(() => 'task-moving')
    await expect(joiner.offer('during the switch', 'qm-mobile-sw')).rejects.toThrow('moving')
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    result('the answer', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
  })

  it('a message withdrawn from the line before it was written is not waited for', async () => {
    const { turn, joiner, done } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('take me back', 'qm-mobile-w')
    result('the answer', 1)
    await yieldReal(10)
    expect(done()).toBe(false)
    // Its row is gone from the line and was never written to the CLI: one read
    // could fall between its row leaving the line and its write being reported.
    await advance(LANE_TURN_TICK_MS)
    expect(done()).toBe(false)
    await advance(LANE_TURN_TICK_MS)
    await expect(turn).resolves.toMatchObject({ resultText: 'the answer' })
  })

  it('a message still in the line is waited for at the tick', async () => {
    const { joiner, done } = await startTurn()
    delivered('qm-1', 1)
    getQueue.mockImplementation(async () => [{ id: 'qm-mobile-q', status: 'pending' }])
    await joiner.offer('still queued', 'qm-mobile-q')
    result('the answer', 1)
    await advance(LANE_TURN_TICK_MS)
    expect(done()).toBe(false)
    taken('qm-mobile-q')
    result('its answer', 2)
    await yieldReal(10)
    expect(done()).toBe(true)
  })

  it('a CLI that dies before answering it ends the turn with the answer it already gave', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('never answered', 'qm-mobile-f')
    delivered('qm-mobile-f', 1)
    result('the first answer', 1)
    await yieldReal(10)
    emit(EventNames.SESSION_ERROR, { sessionId: SID, error: 'gone', errorKind: 'process_exit' })
    await expect(turn).resolves.toMatchObject({ resultText: 'the first answer' })
  })

  it('a lane that goes silent while it still runs is drained, so the next turn cannot join that one', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('a slow one', 'qm-mobile-g')
    delivered('qm-mobile-g', 1)
    result('the first answer', 1)
    taken('qm-mobile-g') // the CLI runs it as a turn of its own, then goes quiet
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const r = await turn
    expect(r.resultText).toBe('the first answer')
    expect(r.laneStillRunning).toBeUndefined()
    expect(laneGate(SID)).toBeDefined()
  })

  it('a turn that stalled before its own answer keeps waiting for a message sent into it', async () => {
    const { turn, joiner } = await startTurn()
    delivered('qm-1', 1)
    await joiner.offer('also this', 'qm-mobile-k')
    delivered('qm-mobile-k', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const r = await turn
    expect(r.laneStillRunning).toBe(true)
    let late: string | null | undefined
    void r.lateResult!.then((t) => { late = t })
    result('the late answer', 1) // the CLI had not taken the message yet
    await yieldReal(10)
    expect(late).toBeUndefined()
    taken('qm-mobile-k')
    result('its late answer', 2)
    await expect(r.lateResult).resolves.toBe('the late answer\n\nits late answer')
    expect(laneGate(SID)).toBeUndefined()
  })

  it('on a lane its spawn just made, it is taken at once (the spawn carried the turn its message)', async () => {
    const { turn, joiner } = await startTurn(true)
    await expect(joiner.offer('right away', 'qm-mobile-h')).resolves.toBeUndefined()
    delivered('qm-mobile-h', 1)
    taken('qm-mobile-h')
    result('answered both', 1)
    await expect(turn).resolves.toMatchObject({ resultText: 'answered both' })
  })
})
