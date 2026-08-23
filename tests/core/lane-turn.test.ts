/**
 * runLaneTurn — the background producers' "await one lane turn" primitive.
 *
 * Cron / heartbeat / triage cannot fire-and-forget the way the chat RPC does:
 * each needs the turn's TEXT (to record job status, to decide "all clear", to
 * persist a summary). This file pins the contract that makes that safe:
 *
 *   - DELIVERY — a freshly created lane already carries the message (created=true
 *     ⇒ never send it again); a reused lane gets an explicit send.
 *   - CORRELATION — only this session's results count, intermediate (teamActive)
 *     results are not turn-over, and the first real one wins.
 *   - DEGRADATION — session:error and a timeout resolve `null`; the promise never
 *     rejects, so a producer can decide for itself whether that's fatal.
 *   - HYGIENE — the bus subscription and the timer are always released.
 *
 * Real bus, mocked lane + send queue: nothing here can spawn a `claude`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const getOrCreateLaneSession = vi.hoisted(() => vi.fn())
const sendMessageToSession = vi.hoisted(() => vi.fn(async () => ({ id: 'qm-test' })))

vi.mock('../../src/core/sessions/personal-ai-lane.js', () => ({ getOrCreateLaneSession }))
vi.mock('../../src/core/session-message-queue.js', () => ({
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false, sendMessageToSession }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { runLaneTurn } from '../../src/core/sessions/lane-turn.js'

const SID = '11111111-2222-3333-4444-555555555555'

/** Subscriber names registered on the bus during a call (to assert cleanup). */
let subscribedNames: string[] = []
let subscribeSpy: ReturnType<typeof vi.spyOn>

function laneReturns(sessionId: string, created: boolean): void {
  getOrCreateLaneSession.mockResolvedValue({ sessionId, created })
}

function emitResult(data: Record<string, unknown>): void {
  bus.emit(EventNames.SESSION_RESULT, data as never, ['main-ai'], { source: 'test' })
}

/** Let the lane resolve + (for a reused lane) the send complete before emitting. */
async function settleSend(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 5))
}

beforeEach(() => {
  bus.clear()
  getOrCreateLaneSession.mockReset()
  sendMessageToSession.mockClear()
  sendMessageToSession.mockResolvedValue({ id: 'qm-test' } as never)
  subscribedNames = []
  const original = bus.subscribe.bind(bus)
  subscribeSpy = vi.spyOn(bus, 'subscribe').mockImplementation(((name: string, ...rest: unknown[]) => {
    subscribedNames.push(name)
    return (original as (...a: unknown[]) => void)(name, ...rest)
  }) as never)
})

afterEach(() => {
  subscribeSpy.mockRestore()
  bus.clear()
})

// ══════════════════════════════════════════════════════════════════
//  Delivery
// ══════════════════════════════════════════════════════════════════

describe('delivery', () => {
  it('does NOT send again when the lane was just created (the spawn carried the message)', async () => {
    laneReturns(SID, true)
    const turn = runLaneTurn('general', 'conv-a', 'cron work', { source: 'cron' })
    await settleSend()
    emitResult({ sessionId: SID, result: 'done' })

    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: 'done' })
    expect(getOrCreateLaneSession).toHaveBeenCalledWith('general', 'conv-a', { firstMessage: 'cron work' })
    expect(sendMessageToSession).not.toHaveBeenCalled()
  })

  it('sends into the existing lane when it was reused, tagged with the producer source', async () => {
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'heartbeat prompt', { source: 'heartbeat' })
    await settleSend()
    expect(sendMessageToSession).toHaveBeenCalledWith(SID, 'heartbeat prompt', { source: 'heartbeat' })

    emitResult({ sessionId: SID, result: 'ok' })
    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: 'ok' })
  })

  it('catches a result that arrives DURING the spawn (lost-wakeup race)', async () => {
    // A brand-new lane's session id is minted inside getOrCreateLaneSession, and
    // the spawn it emits can complete a cheap turn before that call even returns.
    // The subscription therefore has to exist first AND hold what it sees until
    // the id is known — otherwise this result is lost and the producer waits out
    // the full timeout.
    getOrCreateLaneSession.mockImplementation(async () => {
      emitResult({ sessionId: SID, result: 'answered during spawn' })
      return { sessionId: SID, created: true }
    })
    await expect(runLaneTurn('general', 'conv-a', 'x', { source: 'cron', timeoutMs: 200 }))
      .resolves.toEqual({ sessionId: SID, resultText: 'answered during spawn' })
  })

  it('does NOT adopt a pre-send result from a REUSED lane (it is an earlier turn)', async () => {
    // Same window, opposite conclusion: the lane already existed, so anything
    // emitted before our send answered a PREVIOUS message. Adopting it would
    // hand cron/heartbeat stale text.
    getOrCreateLaneSession.mockImplementation(async () => {
      emitResult({ sessionId: SID, result: 'previous turn' })
      return { sessionId: SID, created: false }
    })
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron', timeoutMs: 5_000 })
    await settleSend()
    emitResult({ sessionId: SID, result: 'our turn' })
    expect((await turn).resultText).toBe('our turn')
  })

  it('degrades to null when the send itself fails', async () => {
    laneReturns(SID, false)
    sendMessageToSession.mockRejectedValueOnce(new Error('queue write failed') as never)
    await expect(runLaneTurn('general', 'conv-a', 'x', { source: 'cron' }))
      .resolves.toEqual({ sessionId: SID, resultText: null })
  })
})

// ══════════════════════════════════════════════════════════════════
//  Correlation
// ══════════════════════════════════════════════════════════════════

describe('correlation', () => {
  it('resolves with the matching session result text', async () => {
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'triage' })
    await settleSend()
    emitResult({ sessionId: SID, result: 'the answer' })
    expect((await turn).resultText).toBe('the answer')
  })

  it('treats a missing result field as empty text, not as a failure', async () => {
    // '' is a real (silent) turn — null is reserved for "the turn did not happen",
    // which is what makes cron/heartbeat throw. They must not be confused.
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron' })
    await settleSend()
    emitResult({ sessionId: SID })
    expect((await turn).resultText).toBe('')
  })

  it('skips an intermediate teamActive result and takes the following real one', async () => {
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron' })
    await settleSend()
    emitResult({ sessionId: SID, result: 'team is up, 5 reviewers working', teamActive: true })
    emitResult({ sessionId: SID, result: 'final answer' })
    expect((await turn).resultText).toBe('final answer')
  })

  it('ignores results from a different session', async () => {
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron' })
    await settleSend()
    emitResult({ sessionId: 'some-other-session', result: 'not mine' })
    bus.emit(EventNames.SESSION_ERROR, { error: 'not mine either', sessionId: 'other' } as never, ['main-ai'])
    emitResult({ sessionId: SID, result: 'mine' })
    expect((await turn).resultText).toBe('mine')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Degradation
// ══════════════════════════════════════════════════════════════════

describe('degradation', () => {
  it('resolves null on session:error — never rejects', async () => {
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron' })
    await settleSend()
    bus.emit(EventNames.SESSION_ERROR, { error: 'CLI died', sessionId: SID } as never, ['main-ai'])
    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: null })
  })

  it('resolves null on timeout, still reporting the session it waited on', async () => {
    laneReturns(SID, false)
    await expect(runLaneTurn('general', 'conv-a', 'x', { source: 'cron', timeoutMs: 50 }))
      .resolves.toEqual({ sessionId: SID, resultText: null })
  })
})

// ══════════════════════════════════════════════════════════════════
//  Hygiene
// ══════════════════════════════════════════════════════════════════

describe('subscription hygiene', () => {
  it('removes its bus subscription after resolving, and ignores later events', async () => {
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron' })
    await settleSend()
    const subName = subscribedNames.at(-1)!
    expect(bus.has(subName)).toBe(true)

    emitResult({ sessionId: SID, result: 'first' })
    expect((await turn).resultText).toBe('first')
    expect(bus.has(subName)).toBe(false)

    // A late result for the same session must be inert (no throw, no re-resolve).
    emitResult({ sessionId: SID, result: 'late' })
    expect((await turn).resultText).toBe('first')
  })

  it('removes its subscription after a timeout too', async () => {
    laneReturns(SID, false)
    await runLaneTurn('general', 'conv-a', 'x', { source: 'cron', timeoutMs: 30 })
    const subName = subscribedNames.at(-1)!
    expect(bus.has(subName)).toBe(false)
  })

  it('subscribes with an interest set so it is not woken by streaming events', async () => {
    // A bare global subscriber would be invoked on every session:text-delta of
    // every session in the process — the event-loop starvation class.
    laneReturns(SID, false)
    const turn = runLaneTurn('general', 'conv-a', 'x', { source: 'cron', timeoutMs: 40 })
    await settleSend()
    const opts = subscribeSpy.mock.calls.at(-1)?.[2] as { global?: boolean; interest?: string[] }
    expect(opts?.global).toBe(true)
    expect(opts?.interest).toEqual([EventNames.SESSION_RESULT, EventNames.SESSION_ERROR])
    await turn
  })
})
