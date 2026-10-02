/**
 * Lane turns fail on SILENCE, not on duration, and every result is matched to
 * the turn that produced it.
 *
 * The 2026-09-26 phone incident, replayed here with the real constants
 * (LANE_TURN_STALL_MS = 15 min, LANE_TURN_TICK_MS = 30 s) under fake timers:
 * a 16.7-minute lane turn doing steady work was declared "did not answer" at the
 * old 10-minute wall clock, the agent queue moved on, the follow-up was sent
 * INTO the still-running turn, and that turn's one result was glued onto the
 * follow-up. Each scenario below pins one half of the fix:
 *
 *   1. a 16-minute turn with steady progress answers normally;
 *   2. a stalled stream fails, and when its CLI is still running the caller gets
 *      `laneStillRunning` + a late answer instead of a persisted error;
 *   3. a dead CLI fails fast (event or record probe);
 *   4. a follow-up never takes an earlier turn's result: correlation is by turn
 *      generation, and a lane holding a stalled turn gates the next send.
 *
 * Real bus and real progress registry; the lane is supplied through the
 * `target` option and the send queue + session record are stubbed, so nothing
 * here can spawn a CLI or read a real store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const sendMessageToSession = vi.hoisted(() => vi.fn())
const getSessionByClaudeId = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-message-queue.js', () => ({ sendMessageToSession }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import {
  runLaneTurn, LANE_TURN_STALL_MS, LANE_TURN_TICK_MS, LANE_LATE_ANSWER_MAX_MS, LANE_REDELIVER_AFTER_MS,
  _outstandingLateLanesForTesting, type LaneTurnResult, type LaneTurnTarget,
} from '../../src/core/sessions/lane-turn.js'
import { _resetLaneGatesForTesting } from '../../src/core/sessions/lane-turn-gate.js'
import { enqueueAgentTurn } from '../../src/web/agent-turn-queue.js'
import { createStallClock } from '../../src/core/sessions/lane-turn-liveness.js'
import { noteSessionProgress, _resetSessionProgressForTesting } from '../../src/core/sessions/session-progress.js'

const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
const MIN = 60_000

let nextId = 0
let processStatus: string | null = 'running'
let statusReason: string | null = null

function reusedLane(): LaneTurnTarget {
  return {
    resolve: async () => ({ sessionId: SID, created: false }),
    catchUp: async (_sid, message) => ({ message }),
  }
}

function emit(name: string, data: Record<string, unknown>): void {
  bus.emit(name, data as never, ['main-ai'], { source: 'test' })
}
const delivered = (messageId: string, turnGen?: number): void =>
  emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, count: 1, messageIds: [messageId], ...(turnGen !== undefined ? { turnGen } : {}) })
const result = (text: string, turnGen?: number): void =>
  emit(EventNames.SESSION_RESULT, { sessionId: SID, result: text, ...(turnGen !== undefined ? { turnGen } : {}) })

/** Yield to REAL I/O and microtasks (setImmediate is not faked). */
async function yieldReal(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

/** Wait until the stubbed queue has seen `n` sends. */
async function sends(n: number): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    if (sendMessageToSession.mock.calls.length >= n) return
    await yieldReal(1)
  }
  throw new Error(`expected ${n} sends, saw ${sendMessageToSession.mock.calls.length}`)
}

/** Advance fake time in tick-sized steps, letting the async tick handler run. */
async function advance(ms: number, step = LANE_TURN_TICK_MS, onStep?: () => void): Promise<void> {
  let left = ms
  while (left > 0) {
    const d = Math.min(step, left)
    await vi.advanceTimersByTimeAsync(d)
    await yieldReal()
    onStep?.()
    left -= d
  }
}

/** Resolve state of a promise without awaiting it forever. */
async function peek<T>(p: Promise<T>): Promise<{ done: boolean; value?: T }> {
  let out: { done: boolean; value?: T } = { done: false }
  p.then((value) => { out = { done: true, value } })
  await yieldReal()
  return out
}

/** Interrupts sent to the lane (the Stop-button path, bus SESSION_INTERRUPT). */
let interrupts: string[] = []

beforeEach(() => {
  bus.clear()
  _resetLaneGatesForTesting()
  interrupts = []
  bus.subscribe('test-interrupts', (e) => {
    if (e.name === EventNames.SESSION_INTERRUPT) interrupts.push((e.data as { sessionId: string }).sessionId)
  }, { global: true, interest: [EventNames.SESSION_INTERRUPT] })
  _resetSessionProgressForTesting()
  nextId = 0
  processStatus = 'running'
  sendMessageToSession.mockReset()
  sendMessageToSession.mockImplementation(async () => ({ id: `qm-${++nextId}` }))
  getSessionByClaudeId.mockReset()
  statusReason = null
  getSessionByClaudeId.mockImplementation(async () => (processStatus ? { process_status: processStatus, status_reason: statusReason } : null))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  bus.clear()
})

describe('stall clock', () => {
  it('counts silence from the last progress and credits a suspended stretch', () => {
    const c = createStallClock(0, 30_000)
    expect(c.tick(30_000)).toBe(30_000)
    c.progress(40_000)
    expect(c.tick(60_000)).toBe(20_000)
    // The next tick lands 20 minutes late (the machine slept): only one normal
    // tick of that gap may count as silence.
    expect(c.tick(60_000 + 20 * MIN)).toBe(20_000 + 30_000)
  })
})

describe('a long turn with steady progress', () => {
  it('answers after 16 minutes: duration alone is never a failure', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'research this', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    // One stream line a minute (tool_progress heartbeats, deltas) for 16 minutes.
    await advance(16 * MIN, LANE_TURN_TICK_MS, () => noteSessionProgress(SID))
    expect((await peek(turn)).done).toBe(false)
    result('the answer after 16 minutes', 1)
    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: 'the answer after 16 minutes' })
  })

  it('does not count a system sleep as silence', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    noteSessionProgress(SID)
    // The Mac sleeps for 40 minutes: timers fire late, all at once, on wake.
    vi.setSystemTime(Date.now() + 40 * MIN)
    await advance(LANE_TURN_TICK_MS)
    expect((await peek(turn)).done).toBe(false)
    result('answered after wake', 1)
    expect((await turn).resultText).toBe('answered after wake')
  })
})

describe('a stalled stream', () => {
  it('fails after the stall window; a still-running CLI gets a late answer, never an error row', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 3)
    await advance(LANE_TURN_STALL_MS - 2 * LANE_TURN_TICK_MS)
    expect((await peek(turn)).done).toBe(false)
    await advance(3 * LANE_TURN_TICK_MS)
    const failed = await turn
    expect(failed.resultText).toBeNull()
    expect(failed.failure).toBe('stalled')
    expect(failed.laneStillRunning).toBe(true)
    expect(_outstandingLateLanesForTesting()).toEqual([SID])

    // The CLI recovers and answers THIS turn later.
    result('late but real', 3)
    await expect(failed.lateResult).resolves.toBe('late but real')
    expect(_outstandingLateLanesForTesting()).toEqual([])
  })

  it('a stall whose CLI is no longer running is a plain failure (no late watch)', async () => {
    processStatus = 'idle'
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const failed = await turn
    expect(failed).toEqual({ sessionId: SID, resultText: null, failure: 'stalled' })
    expect(_outstandingLateLanesForTesting()).toEqual([])
  })

  it('a late watch that goes silent again settles null, but the lane stays gated until the turn ends', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const failed = await turn
    expect(failed.laneStillRunning).toBe(true)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    await expect(failed.lateResult).resolves.toBeNull()
    // The CLI may still be in that turn: asked to stop, and the lane stays gated.
    expect(interrupts).toEqual([SID])
    expect(_outstandingLateLanesForTesting()).toEqual([SID])
    result('the interrupted turn ends', 1)
    expect(_outstandingLateLanesForTesting()).toEqual([])
  })
})

describe('a dead CLI', () => {
  it('fails at once on session:error', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    emit(EventNames.SESSION_ERROR, { sessionId: SID, error: 'CLI exited 1' })
    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: null, failure: 'died' })
  })

  it('fails within about a minute when the death event was lost but the record says stopped', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    processStatus = 'stopped'
    await advance(2 * MIN + LANE_TURN_TICK_MS)
    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: null, failure: 'died' })
  })

  it('a remote lane in a tunnel flap (error / remote_unreachable) is not dead: the turn keeps waiting', async () => {
    // What a remote lane's record reads while its SSH tunnel is down: liveness
    // unknown, the CLI on the far host possibly mid-answer.
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    processStatus = 'error'
    statusReason = 'remote_unreachable'
    await advance(5 * MIN)
    expect((await peek(turn)).done).toBe(false)
    // The tunnel comes back and the answer with it.
    processStatus = 'running'
    statusReason = null
    result('answered across the flap', 1)
    expect((await turn).resultText).toBe('answered across the flap')
  })

  it('a delivery_failed error is connectivity, not death: the turn keeps waiting', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    emit(EventNames.SESSION_ERROR, { sessionId: SID, error: 'daemon down', errorKind: 'delivery_failed' })
    expect((await peek(turn)).done).toBe(false)
    delivered('qm-1', 2)
    result('redelivered and answered', 2)
    expect((await turn).resultText).toBe('redelivered and answered')
  })
})

describe('a message stranded in the queue (2026-10-02: a send that raced the lane spawn sat queued 82 minutes)', () => {
  /** Queue kicks sent on the bus (SESSION_SEND with no text: the queue holds it). */
  let kicks: Array<{ sessionId: string; message: string; source?: string }> = []
  beforeEach(() => {
    kicks = []
    bus.subscribe('test-kicks', (e) => {
      if (e.name !== EventNames.SESSION_SEND) return
      const d = e.data as { sessionId: string; message: string }
      kicks.push({ sessionId: d.sessionId, message: d.message, source: e.source })
    }, { global: true, interest: [EventNames.SESSION_SEND] })
  })

  it('an idle lane that never confirmed the delivery is kicked once the backstop window passes', async () => {
    processStatus = 'idle'
    statusReason = 'session_started'
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    await advance(LANE_REDELIVER_AFTER_MS - 2_000, 1_000)
    expect(kicks).toEqual([])
    await advance(3_000, 1_000)
    expect(kicks).toEqual([{ sessionId: SID, message: '', source: 'lane-redeliver' }])
    delivered('qm-1', 1)
    result('answered after the kick', 1)
    expect((await turn).resultText).toBe('answered after the kick')
  })

  it('kicks at most twice; the stall then reports a message that was never delivered', async () => {
    processStatus = 'idle'
    statusReason = 'session_started'
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    expect(kicks).toHaveLength(2)
    expect(await turn).toEqual({ sessionId: SID, resultText: null, failure: 'stalled', undelivered: true })
  })

  it('never kicks a lane running a turn (the kick would join it), awaiting its spawn, or already delivered', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    await advance(2 * MIN) // processStatus 'running'
    processStatus = 'idle'
    statusReason = 'awaiting_spawn'
    await advance(2 * MIN)
    expect(kicks).toEqual([])
    delivered('qm-1', 1)
    statusReason = 'session_started'
    await advance(2 * MIN)
    expect(kicks).toEqual([])
    result('ok', 1)
    expect((await turn).resultText).toBe('ok')
  })
})

describe('result correlation', () => {
  it('a result that closes an EARLIER turn is never taken by a follow-up', async () => {
    // T1 is delivered as turn 1. The follow-up T2 is sent while turn 1 still
    // runs, so the queue holds it until turn 1 ends (no delivery event yet).
    const t1 = runLaneTurn('general', 'conv-a', 'first', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    const t2 = runLaneTurn('general', 'conv-a', 'follow-up', { source: 'api-v1', target: reusedLane() })
    await sends(2)
    result('answer to the first', 1)
    expect((await t1).resultText).toBe('answer to the first')
    expect((await peek(t2)).done).toBe(false)
    delivered('qm-2', 2)
    expect((await peek(t2)).done).toBe(false)
    result('answer to the follow-up', 2)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })

  it('the previous turn\'s result arriving AFTER the follow-up\'s delivery is still not the follow-up\'s', async () => {
    // T1 runs as turn 1. The follow-up T2 is delivered as turn 2 while turn 1 is
    // still finishing, and turn 1's result lands only then. By arrival order it is
    // "the first result after T2 was delivered"; by generation it closes turn 1.
    const t1 = runLaneTurn('general', 'conv-a', 'first', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    const onQueued = vi.fn()
    const t2 = runLaneTurn('general', 'conv-a', 'follow-up', { source: 'api-v1', target: reusedLane(), onQueued })
    await sends(2)
    expect(onQueued).not.toHaveBeenCalled() // nothing stalled: no wait to announce
    delivered('qm-2', 2)
    result('answer to the first', 1)
    expect((await t1).resultText).toBe('answer to the first')
    expect((await peek(t2)).done).toBe(false)
    result('answer to the follow-up', 2)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })

  it('adopts its own result even when the CLI answered before the delivery event', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    result('stale, turn 4', 4)
    result('fast answer', 5)
    delivered('qm-1', 5)
    expect((await turn).resultText).toBe('fast answer')
  })

  it('a send that JOINS a running turn is answered by that turn', async () => {
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 7) // mid-turn: no generation bump
    result('the running turn, now covering our message too', 7)
    expect((await turn).resultText).toBe('the running turn, now covering our message too')
  })

  it('the incident: a stalled turn gates the follow-up, and the late answer goes to the turn that asked', async () => {
    const t1 = runLaneTurn('general', 'conv-a', 'long question', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const r1: LaneTurnResult = await t1
    expect(r1.laneStillRunning).toBe(true)

    // The follow-up arrives while turn 1 is still running: it must WAIT, not
    // join turn 1 (whose single result would then be claimed twice), and say it
    // is waiting (the phone shows "Waiting for another task").
    const onQueued = vi.fn()
    const t2 = runLaneTurn('general', 'conv-a', 'follow-up', { source: 'api-v1', target: reusedLane(), onQueued })
    await yieldReal(20)
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    expect(onQueued).toHaveBeenCalledTimes(1)

    result('answer to the long question', 1)
    await expect(r1.lateResult).resolves.toBe('answer to the long question')
    await sends(2)
    expect(sendMessageToSession.mock.calls[1]?.[1]).toBe('follow-up')
    delivered('qm-2', 2)
    result('answer to the follow-up', 2)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })
})

describe('giving up on a late answer while the CLI may still be in that turn (gate finding N1)', () => {
  /** Turn 1 on the lane, run to its stall notice. */
  async function stalledFirst(): Promise<LaneTurnResult> {
    const t1 = runLaneTurn('general', 'conv-a', 'long question', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const r1 = await t1
    expect(r1.laneStillRunning).toBe(true)
    return r1
  }
  const followUp = () => runLaneTurn('general', 'conv-a', 'follow-up', { source: 'api-v1', target: reusedLane() })

  it('silent again: the CLI is interrupted, the follow-up waits for the turn to END, then gets its own answer', async () => {
    const r1 = await stalledFirst()
    const t2 = followUp()
    await yieldReal(20)
    // Silent for a second window: the late watch gives up. The CLI is still in
    // turn 1, so a send now would join it (a mid-turn delivery keeps generation 1)
    // and turn 1's one result would be the follow-up's answer.
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    await expect(r1.lateResult).resolves.toBeNull()
    expect(interrupts).toEqual([SID])
    await yieldReal(20)
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    expect((await peek(t2)).done).toBe(false)

    result('turn 1, cut short by the interrupt', 1)
    await sends(2)
    expect(sendMessageToSession.mock.calls[1]?.[1]).toBe('follow-up')
    delivered('qm-2', 2)
    result('answer to the follow-up', 2)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })

  it('the 60-minute cap drains the same way: a turn busy for an hour is interrupted before anything else is sent', async () => {
    const r1 = await stalledFirst()
    const t2 = followUp()
    // Steady output for the whole cap: never a second stall, never an answer.
    await advance(LANE_LATE_ANSWER_MAX_MS + 2 * LANE_TURN_TICK_MS, 5 * MIN, () => noteSessionProgress(SID))
    await expect(r1.lateResult).resolves.toBeNull()
    expect(interrupts).toEqual([SID])
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    emit(EventNames.SESSION_ERROR, { sessionId: SID, error: 'CLI exited after the interrupt' })
    await sends(2)
    delivered('qm-2', 1) // a respawned CLI starts counting again
    result('answer to the follow-up', 1)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })

  it('a give-up whose record already reads idle frees the lane at once, without an interrupt', async () => {
    const r1 = await stalledFirst()
    processStatus = 'idle' // the turn ended, its result was lost
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    await expect(r1.lateResult).resolves.toBeNull()
    expect(interrupts).toEqual([])
    expect(_outstandingLateLanesForTesting()).toEqual([])
  })

  it('while draining, a tunnel flap is not a death; the record reading idle is an end', async () => {
    const r1 = await stalledFirst()
    const t2 = followUp()
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    await expect(r1.lateResult).resolves.toBeNull()
    processStatus = 'error'
    statusReason = 'remote_unreachable'
    await advance(5 * MIN)
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    processStatus = 'idle'
    statusReason = null
    await advance(2 * LANE_TURN_TICK_MS)
    await sends(2)
    delivered('qm-2', 2)
    result('answer to the follow-up', 2)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })

  it('a turn that does not end within a window after the interrupt: the follow-up fails busy and is never sent', async () => {
    const r1 = await stalledFirst()
    const t2 = followUp()
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    await expect(r1.lateResult).resolves.toBeNull()
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS) // the CLI ignores the interrupt
    expect(await t2).toEqual({ sessionId: SID, resultText: null, failure: 'busy' })
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    expect(interrupts).toEqual([SID, SID]) // asked again
    expect(_outstandingLateLanesForTesting()).toEqual([SID])

    // The turn finally ends: the next message goes through normally.
    result('turn 1 finally ends', 1)
    const t3 = runLaneTurn('general', 'conv-a', 'third', { source: 'api-v1', target: reusedLane() })
    await sends(2)
    delivered('qm-2', 2)
    result('answer to the third', 2)
    expect((await t3).resultText).toBe('answer to the third')
  })
})

describe('the wait at the gate does not hold the agent\'s turn queue (gate finding N2)', () => {
  it('another conversation of the same agent runs while the follow-up waits, and the follow-up still gets its answer', async () => {
    const t1 = runLaneTurn('general', 'conv-a', 'long question', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const r1 = await t1
    expect(r1.laneStillRunning).toBe(true)

    // The follow-up runs inside the agent's queue, as the REST and chat turns do.
    const t2 = enqueueAgentTurn('general', 'follow-up', () =>
      runLaneTurn('general', 'conv-a', 'follow-up', { source: 'api-v1', target: reusedLane() }))
    await yieldReal(20)
    const other = enqueueAgentTurn('general', 'other-conversation', async () => 'the other conversation ran')
    await expect(other).resolves.toBe('the other conversation ran') // not held behind the wait
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)

    result('answer to the long question', 1)
    await expect(r1.lateResult).resolves.toBe('answer to the long question')
    await sends(2)
    delivered('qm-2', 2)
    result('answer to the follow-up', 2)
    expect((await t2).resultText).toBe('answer to the follow-up')
  })
})
