/**
 * The drain of a lane gate (core/sessions/lane-turn-gate.ts), over many windows.
 *
 * A give-up with the CLI alive drains the lane: it interrupts the CLI and keeps
 * the gate closed until THIS lane's turn provably ends. Ported from the gate's
 * round 3 review (2026-09-30), where these cases were the only ones that caught
 * five mutations of the gate: a second drain on a draining lane starting a second
 * watch, a busy window left in place (every later waiter refused at once), and
 * another session's result, a delivery_failed error or a team-active result
 * opening the gate. Also pinned: a lane whose record is gone ends its drain
 * (finding P3-R3-3), while a record that merely fails to READ keeps it going.
 *
 * Real bus, real gate; only the session record is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-turn-gate'))
const getSessionByClaudeId = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import {
  drainLaneGate, laneGate, closeLaneGate, _closedLaneGatesForTesting, _resetLaneGatesForTesting,
} from '../../src/core/sessions/lane-turn-gate.js'

const SID = 'bbbbbbbb-1111-2222-3333-444444444444'
const OTHER = 'cccccccc-0000-0000-0000-000000000000'
const TICK = 1_000
const WINDOW = 10_000

/** The stubbed record: null status = no record at all; readFails = the read throws. */
let status: string | null = 'running'
let reason: string | null = null
let readFails = false
let interrupts = 0

async function yieldReal(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}
/** Advance fake time one tick at a time, letting the async tick handler run. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= TICK) {
    await vi.advanceTimersByTimeAsync(Math.min(TICK, left))
    await yieldReal()
  }
}
/** A waiter's verdict so far: 'pending', 'free' or 'busy' ('no-gate' when the lane is free). */
async function peek(p: Promise<string> | undefined): Promise<string> {
  if (!p) return 'no-gate'
  let out = 'pending'
  void p.then((v) => { out = v })
  await yieldReal()
  return out
}
const drain = (): void => drainLaneGate({
  sessionId: SID, agentId: 'general', conversationId: 'conv-x', source: 'api-v1', why: 'stalled-again',
  tickMs: TICK, windowMs: WINDOW,
})
const emit = (name: string, data: Record<string, unknown>): void => {
  bus.emit(name, data as never, ['main-ai'], { source: 'test' })
}
const closed = (): boolean => _closedLaneGatesForTesting().includes(SID)

beforeEach(() => {
  bus.clear()
  _resetLaneGatesForTesting()
  interrupts = 0
  status = 'running'
  reason = null
  readFails = false
  bus.subscribe('count-interrupts', (e) => {
    if (e.name === EventNames.SESSION_INTERRUPT && (e.data as { sessionId?: string }).sessionId === SID) interrupts++
  }, { global: true, interest: [EventNames.SESSION_INTERRUPT] })
  getSessionByClaudeId.mockReset()
  getSessionByClaudeId.mockImplementation(async () => {
    if (readFails) throw new Error('store unreadable')
    return status ? { process_status: status, status_reason: reason } : null
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  _resetLaneGatesForTesting()
  bus.clear()
})

describe('draining a lane whose CLI does not end its turn', () => {
  it('ten windows: one watch, one interrupt per window, each window answered busy, then a result frees it', async () => {
    closeLaneGate(SID)
    drain()
    const timersAtStart = vi.getTimerCount()
    for (let w = 1; w <= 10; w++) {
      const waiter = laneGate(SID)
      // A fresh window: its waiter is not refused before the window ends.
      expect(await peek(waiter)).toBe('pending')
      drain() // a second give-up on the same lane must not start a second watch
      await advance(WINDOW + 2 * TICK)
      expect(await peek(waiter)).toBe('busy')
      expect(closed()).toBe(true)
      expect(vi.getTimerCount()).toBe(timersAtStart)
    }
    // 120 s of 10 s windows: the first interrupt plus one per elapsed window.
    expect(interrupts).toBe(1 + Math.floor((10 * (WINDOW + 2 * TICK)) / WINDOW))

    const last = laneGate(SID)
    expect(await peek(last)).toBe('pending')
    emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'finally' })
    await yieldReal()
    expect(await peek(last)).toBe('free')
    expect(laneGate(SID)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(timersAtStart - 1)
    const before = interrupts
    await advance(5 * WINDOW)
    expect(interrupts).toBe(before)
  })

  it('a waiter that arrives late in a window is answered busy at that window end', async () => {
    closeLaneGate(SID)
    drain()
    await advance(WINDOW - 2 * TICK)
    const late = laneGate(SID)
    await advance(3 * TICK)
    expect(await peek(late)).toBe('busy')
    expect(closed()).toBe(true)
  })

  it('only THIS lane ending opens the gate', async () => {
    closeLaneGate(SID)
    drain()
    const w = laneGate(SID)
    emit(EventNames.SESSION_RESULT, { sessionId: OTHER, result: 'another session finished' })
    await yieldReal()
    expect(await peek(w)).toBe('pending')
    emit(EventNames.SESSION_ERROR, { sessionId: SID, error: 'send failed', errorKind: 'delivery_failed' })
    await yieldReal()
    expect(await peek(w)).toBe('pending') // connectivity, not a turn outcome
    emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'lead paused, team still working', teamActive: true })
    await yieldReal()
    expect(await peek(w)).toBe('pending') // the team is still in the turn
    expect(closed()).toBe(true)
    emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'the turn really ended' })
    await yieldReal()
    expect(await peek(w)).toBe('free')
    expect(closed()).toBe(false)
  })

  it('a lane whose record is gone ends its drain: the gate opens, the watch and the interrupts stop', async () => {
    closeLaneGate(SID)
    drain()
    const w = laneGate(SID)
    const timersAtStart = vi.getTimerCount()
    status = null
    await advance(2 * TICK)
    expect(await peek(w)).toBe('free')
    expect(closed()).toBe(false)
    expect(vi.getTimerCount()).toBe(timersAtStart - 1)
    const reads = getSessionByClaudeId.mock.calls.length
    await advance(20 * WINDOW)
    expect(interrupts).toBe(1)
    expect(getSessionByClaudeId.mock.calls.length).toBe(reads)
  })

  it('a record that fails to read proves nothing: the drain goes on, then the turn\'s end opens it', async () => {
    closeLaneGate(SID)
    drain()
    readFails = true
    await advance(3 * WINDOW + 5 * TICK)
    expect(closed()).toBe(true)
    expect(interrupts).toBe(4)
    readFails = false
    status = 'idle'
    const w = laneGate(SID)
    await advance(2 * TICK)
    expect(await peek(w)).toBe('free')
    expect(closed()).toBe(false)
  })

  it('a remote lane in a tunnel flap is never dead: interrupted every window until it really stops', async () => {
    closeLaneGate(SID)
    drain()
    status = 'error'
    reason = 'remote_unreachable'
    await advance(5 * WINDOW + 5 * TICK)
    expect(closed()).toBe(true)
    expect(interrupts).toBe(6)
    status = 'stopped'
    reason = null
    await advance(2 * TICK)
    expect(laneGate(SID)).toBeUndefined()
  })
})
