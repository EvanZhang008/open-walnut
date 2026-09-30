/**
 * chat-turn-relay, REPLICA half: a relayed turn that stalls while its lane keeps
 * running still delivers its late answer to the phone.
 *
 * Gate finding (2026-09-30): the primary's stall notice is an `error` frame, and
 * the replica treated every `error` as the end of the turn: it cleared the
 * in-flight entry and dropped every later frame for it, and `message-late` was
 * not even on the allowlist. A phone on the replica kept the notice with the
 * answer sitting on disk until a reload.
 *
 * The rules pinned here: an `error` with `laneStillRunning` releases the turn's
 * guard (the phone may send its next message) but starts a bounded watch for
 * that turn's `message-late` and `message-end`, which then reach the phone even
 * while a later turn is in flight; nothing else gets through; a plain `error`
 * starts no watch; a watch ends on its `message-end` or after 65 minutes.
 *
 * Same seams as chat-turn-relay.test.ts: the uplink at v1-control-relay, the
 * phone channel at sse-channels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-relay-late', { CLOUD_MODE: true }))

const { callPrimaryControlMock, emitSseMock } = vi.hoisted(() => ({
  callPrimaryControlMock: vi.fn(),
  emitSseMock: vi.fn(),
}))

vi.mock('../../../src/web/routes/v1-control-relay.js', () => ({
  callPrimaryControl: callPrimaryControlMock,
}))

vi.mock('../../../src/web/sse-channels.js', () => ({
  emitSse: emitSseMock,
  attachSse: () => {},
  sseConnCount: () => 0,
  closeAllSseChannels: () => {},
}))

import {
  relayChatTurnToPrimary,
  handleBridgeChatTurnFrame,
  resetChatTurnRelayState,
} from '../../../src/web/routes/chat-turn-relay.js'

const CONV = 'conv-relay-late-1'
const T1 = 'turn-late-1'
const T2 = 'turn-late-2'
const NOTICE = { message: 'The main AI has gone quiet on this turn.', turnId: T1, laneStillRunning: true }
const MIN = 60_000

function accept(turnId: string) {
  callPrimaryControlMock.mockResolvedValueOnce({ ok: true, result: { accepted: true, turnId, engine: 'claude-code' } })
}

const frame = (turnId: string, event: string, data: unknown): void =>
  handleBridgeChatTurnFrame({ conversationId: CONV, turnId, event, data })

/** What reached the phone channel: [event, data] per emit. */
const phone = (): Array<[string, unknown]> => emitSseMock.mock.calls.map((c) => [c[1] as string, c[2]])

/** Relay one turn; `settled` resolves when the replica stops holding its guard. */
async function startTurn(turnId: string): Promise<{ settled: Promise<void> }> {
  accept(turnId)
  const outcome = await relayChatTurnToPrimary('general', CONV, 'hello', turnId)
  if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`)
  return { settled: outcome.settled }
}

beforeEach(() => {
  callPrimaryControlMock.mockReset()
  emitSseMock.mockReset()
  resetChatTurnRelayState()
})

afterEach(() => {
  vi.useRealTimers()
  resetChatTurnRelayState()
})

describe('a relayed turn that stalls with its lane still running', () => {
  it('the notice releases the turn; the late message-late and message-end still reach the phone', async () => {
    const { settled } = await startTurn(T1)
    frame(T1, 'message-start', { turnId: T1 })
    frame(T1, 'error', NOTICE)
    await settled // the guard is released: the phone may send its next message

    frame(T1, 'message-late', { turnId: T1, fullText: 'the late answer' })
    frame(T1, 'message-end', { turnId: T1, fullText: 'the late answer' })
    expect(phone()).toEqual([
      ['message-start', { turnId: T1 }],
      ['error', { ...NOTICE, engine: 'claude-code' }],
      ['message-late', { turnId: T1, fullText: 'the late answer' }],
      ['message-end', { turnId: T1, fullText: 'the late answer', engine: 'claude-code' }],
    ])

    // The watch ended with its message-end: a repeat is dropped.
    emitSseMock.mockClear()
    frame(T1, 'message-end', { turnId: T1, fullText: 'again' })
    expect(phone()).toEqual([])
  })

  it('reaches the phone while the NEXT relayed turn is in flight, without touching that turn', async () => {
    const { settled: s1 } = await startTurn(T1)
    frame(T1, 'error', NOTICE)
    await s1
    const { settled: s2 } = await startTurn(T2) // not a 409: the stalled turn no longer holds the guard
    let s2Done = false
    void s2.then(() => { s2Done = true })
    frame(T2, 'message-start', { turnId: T2 })
    frame(T2, 'queued', { turnId: T2, position: 1 })

    emitSseMock.mockClear()
    frame(T1, 'message-late', { turnId: T1, fullText: 'late' })
    frame(T1, 'message-end', { turnId: T1, fullText: 'late' })
    frame(T2, 'message-start', { turnId: T2 })
    expect(phone().map(([e, d]) => `${e}:${(d as { turnId: string }).turnId}`)).toEqual([
      `message-late:${T1}`, `message-end:${T1}`, `message-start:${T2}`,
    ])
    await Promise.resolve()
    expect(s2Done).toBe(false)

    // A frame of the stalled turn that is not its answer is still dropped.
    emitSseMock.mockClear()
    frame(T1, 'text-delta', { delta: 'stray' })
    expect(phone()).toEqual([])

    frame(T2, 'message-end', { turnId: T2, fullText: 'second' })
    await s2
  })

  it('a plain error (no laneStillRunning) is final: later frames for that turn are dropped', async () => {
    const { settled } = await startTurn(T1)
    frame(T1, 'error', { message: 'The main AI stopped before it answered this turn.' })
    await settled
    emitSseMock.mockClear()
    frame(T1, 'message-late', { turnId: T1, fullText: 'x' })
    frame(T1, 'message-end', { turnId: T1, fullText: 'x' })
    expect(phone()).toEqual([])
  })

  it('a watch lapses after 65 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { settled } = await startTurn(T1)
    frame(T1, 'error', NOTICE)
    await settled
    vi.setSystemTime(Date.now() + 66 * MIN)
    emitSseMock.mockClear()
    frame(T1, 'message-end', { turnId: T1, fullText: 'too late' })
    expect(phone()).toEqual([])
  })

  it('a turn the replica never watched gets nothing through', () => {
    frame('turn-never-seen', 'message-end', { turnId: 'turn-never-seen', fullText: 'x' })
    frame('turn-never-seen', 'message-late', { turnId: 'turn-never-seen', fullText: 'x' })
    expect(phone()).toEqual([])
  })
})
