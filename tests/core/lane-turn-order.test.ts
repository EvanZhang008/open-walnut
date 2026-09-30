/**
 * Turns waiting at ONE lane gate reach the lane in the order they were queued.
 *
 * Gate finding P2-R3-1 (2026-09-30): after the N2 change (a turn waiting at its
 * lane's gate gives the agent's slot up, core/turn-slot.ts), waiters took the slot
 * back with an unshift, so three follow-ups queued behind a stalled turn as phone,
 * triage, cron were sent to the lane as phone, cron, triage. Real lane-turn, real
 * gate, real agent queue; only the send and the session record are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-turn-order'))

const sendMessageToSession = vi.hoisted(() => vi.fn())
const getSessionByClaudeId = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-message-queue.js', () => ({ sendMessageToSession }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import {
  runLaneTurn, LANE_TURN_STALL_MS, LANE_TURN_TICK_MS, type LaneTurnTarget,
} from '../../src/core/sessions/lane-turn.js'
import { _resetLaneGatesForTesting } from '../../src/core/sessions/lane-turn-gate.js'
import { enqueueAgentTurn } from '../../src/web/agent-turn-queue.js'
import { _resetSessionProgressForTesting } from '../../src/core/sessions/session-progress.js'

const SID = 'aaaaaaaa-1111-2222-3333-444444444444'

let nextId = 0

function reusedLane(): LaneTurnTarget {
  return {
    resolve: async () => ({ sessionId: SID, created: false }),
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
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= LANE_TURN_TICK_MS) {
    await vi.advanceTimersByTimeAsync(Math.min(LANE_TURN_TICK_MS, left))
    await yieldReal()
  }
}

beforeEach(() => {
  bus.clear()
  _resetLaneGatesForTesting()
  _resetSessionProgressForTesting()
  nextId = 0
  sendMessageToSession.mockReset()
  sendMessageToSession.mockImplementation(async () => ({ id: `qm-${++nextId}` }))
  getSessionByClaudeId.mockReset()
  getSessionByClaudeId.mockImplementation(async () => ({ process_status: 'running', status_reason: null }))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  _resetLaneGatesForTesting()
  bus.clear()
})

describe('turns waiting at one lane gate', () => {
  it('three follow-ups queued behind a stalled turn are sent in the order they were queued', async () => {
    const t1 = runLaneTurn('general', 'conv-a', 'long question', { source: 'api-v1', target: reusedLane() })
    await sends(1)
    delivered('qm-1', 1)
    await advance(LANE_TURN_STALL_MS + 2 * LANE_TURN_TICK_MS)
    const r1 = await t1
    expect(r1.laneStillRunning).toBe(true)

    const queued = ['phone follow-up (first)', 'triage (second)', 'cron (third)']
    const turns = queued.map((m) =>
      enqueueAgentTurn('general', m, () => runLaneTurn('general', 'conv-a', m, { source: 'api-v1', target: reusedLane() })))
    await yieldReal(30)
    expect(sendMessageToSession).toHaveBeenCalledTimes(1) // all three wait at the gate

    result('answer to the long question', 1)
    await expect(r1.lateResult).resolves.toBe('answer to the long question')
    const sent: string[] = []
    for (let i = 2; i <= 4; i++) {
      await sends(i)
      sent.push(String(sendMessageToSession.mock.calls[i - 1]?.[1]))
      delivered(`qm-${i}`, i)
      result(`answer ${i}`, i)
      await yieldReal(10)
    }
    const answers = await Promise.all(turns)
    expect(sent).toEqual(queued)
    expect(answers.map((a) => a.resultText)).toEqual(['answer 2', 'answer 3', 'answer 4'])
  })
})
