/**
 * Push notifications know about Personal AI lanes.
 *
 * On the lane engine a Personal AI chat turn is answered by a `claude` session, so the
 * SESSION_RESULT / SESSION_ERROR that ends it IS the Personal AI talking. Pushed with
 * the generic session copy the user's phone would say "Session 3f2a1b0c finished"
 * for their own chat message — a session id they never saw and cannot act on.
 * This file pins the fork:
 *
 *   - lane record   → title 'Walnut', body = the reply / the Personal AI's error
 *   - no lane       → the existing generic session copy, byte-identical
 *   - record read throws → generic copy (the push must not be lost over a
 *     bookkeeping failure)
 *
 * Transport is stubbed at `fetch` (the Expo HTTP call), so nothing leaves the
 * process; `clientCount()` is forced to 0 because a push is skipped whenever a
 * WS client is connected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/** Session records the fake tracker will answer with, by session id. */
const records = new Map<string, { claudeSessionId: string; lane?: string }>()
/** When set, getSessionByClaudeId rejects — the failure-safety case. */
let recordReadError: Error | null = null

const getSessionByClaudeId = vi.hoisted(() => vi.fn())
const clientCount = vi.hoisted(() => vi.fn(() => 0))
const getConfig = vi.hoisted(() => vi.fn())

vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId }))
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { initPushNotifications } from '../../src/core/push-notification.js'
// Statically imported ONLY to warm the module cache: the handler reaches it via a
// dynamic import, and a cold resolve inside the first push added ~700ms of
// latency that made a time-bounded assertion flaky.
import '../../src/core/sessions/personal-ai-lane.js'

interface SentPush { title: string; body: string; data?: Record<string, unknown> }

/** Every Expo message the service tried to send, flattened across batches. */
let sent: SentPush[] = []
let fetchMock: ReturnType<typeof vi.fn>

/**
 * Emit an event to the push subscriber and let its async handler settle.
 *
 * The handler is fire-and-forget (bus.emit does not await it) and the lane branch
 * awaits two dynamic imports on top, so a fixed microtask flush is not enough.
 * Poll to quiescence: wait for the transport call, then keep waiting until the
 * call count stops moving. `expectSend: false` still gets a real window, so the
 * "nothing may be sent" assertions can genuinely fail.
 */
async function emitAndSettle(
  name: string,
  data: Record<string, unknown>,
  expectSend = true,
): Promise<void> {
  const before = fetchMock.mock.calls.length
  bus.emit(name, data as never, ['push-notifications'], { source: 'test' })
  const deadline = Date.now() + 5_000
  while (expectSend && fetchMock.mock.calls.length === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5))
  }
  let seen = -1
  while (seen !== fetchMock.mock.calls.length && Date.now() < deadline) {
    seen = fetchMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 15))
  }
}

beforeEach(() => {
  bus.clear()
  records.clear()
  recordReadError = null
  sent = []

  getSessionByClaudeId.mockReset()
  getSessionByClaudeId.mockImplementation(async (sessionId: string) => {
    if (recordReadError) throw recordReadError
    return records.get(sessionId) ?? null
  })
  clientCount.mockReturnValue(0)
  getConfig.mockResolvedValue({
    push_tokens: [{
      token: 'ExponentPushToken[test]',
      platform: 'ios',
      key_name: 'test',
      registered_at: new Date().toISOString(),
    }],
  })

  fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const messages = JSON.parse(init?.body ?? '[]') as SentPush[]
    sent.push(...messages)
    return {
      ok: true,
      json: async () => ({ data: messages.map(() => ({ status: 'ok' as const })) }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)

  initPushNotifications()
})

afterEach(async () => {
  bus.clear()
  // Drain to quiescence BEFORE the next test resets `sent`. The handler is
  // fire-and-forget, so a push still in flight here would otherwise land in the
  // next test's capture and fail it with a phantom extra message.
  let seen = -1
  while (seen !== fetchMock.mock.calls.length) {
    seen = fetchMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 15))
  }
  vi.unstubAllGlobals()
})

describe('SESSION_RESULT', () => {
  it('a LANE session pushes as the Personal AI, carrying the reply text', async () => {
    records.set('lane-sid', { claudeSessionId: 'lane-sid', lane: 'chat:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_RESULT, {
      sessionId: 'lane-sid',
      result: 'Your week is planned — 3 tasks moved to tomorrow.',
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Walnut')
    expect(sent[0].body).toBe('Your week is planned — 3 tasks moved to tomorrow.')
    // The generic copy must NOT leak a raw session id into a chat reply.
    expect(sent[0].body).not.toContain('finished')
    // Routing hints so a tap can open the right conversation.
    expect(sent[0].data).toMatchObject({
      type: 'session_result', agentId: 'general', conversationId: 'conv-abc',
    })
  })

  it('a lane result with no text still pushes (a silent turn is not a failure)', async () => {
    records.set('lane-sid', { claudeSessionId: 'lane-sid', lane: 'chat:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_RESULT, { sessionId: 'lane-sid' })
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Walnut')
    expect(sent[0].body).toBe('New response')
  })

  it('truncates a long lane reply to the file-wide body budget', async () => {
    records.set('lane-sid', { claudeSessionId: 'lane-sid', lane: 'chat:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_RESULT, { sessionId: 'lane-sid', result: 'x'.repeat(5000) })
    // 150 at the case (same as every other agent-text push), never the raw 5000.
    expect(sent[0].body.length).toBe(150)
  })

  it('a NON-lane session keeps the generic copy byte-identical', async () => {
    records.set('plain-sid', { claudeSessionId: 'plain-sid' })
    await emitAndSettle(EventNames.SESSION_RESULT, { sessionId: 'plain-sid', result: 'coding done' })

    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Session Complete')
    expect(sent[0].body).toBe('Session plain-si finished')
    expect(sent[0].data).toMatchObject({ type: 'session_result', sessionId: 'plain-sid' })
    expect(sent[0].data).not.toHaveProperty('agentId')
  })

  it('a lane in a FOREIGN namespace is not treated as a Personal AI chat', async () => {
    // parseLaneKey only claims 'chat:' — a future lane kind must fall through to
    // the generic path rather than impersonate the Personal AI.
    records.set('other-sid', { claudeSessionId: 'other-sid', lane: 'notes:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_RESULT, { sessionId: 'other-sid', result: 'x' })
    expect(sent[0].title).toBe('Session Complete')
  })

  it('falls back to the generic copy when the record read THROWS', async () => {
    recordReadError = new Error('sqlite is unavailable')
    await emitAndSettle(EventNames.SESSION_RESULT, { sessionId: 'lane-sid', result: 'x' })
    // Degraded, not dropped: the user still gets told the session ended.
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Session Complete')
  })
})

describe('SESSION_ERROR', () => {
  it('a LANE error is reported as the main AI failing', async () => {
    records.set('lane-sid', { claudeSessionId: 'lane-sid', lane: 'chat:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_ERROR, { sessionId: 'lane-sid', error: 'CLI exited with code 1' })

    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Walnut')
    expect(sent[0].body).toBe('The main AI hit an error: CLI exited with code 1')
    expect(sent[0].data).toMatchObject({
      type: 'session_error', agentId: 'general', conversationId: 'conv-abc',
    })
  })

  it('a NON-lane error keeps the generic copy', async () => {
    records.set('plain-sid', { claudeSessionId: 'plain-sid' })
    await emitAndSettle(EventNames.SESSION_ERROR, { sessionId: 'plain-sid', error: 'boom' })
    expect(sent[0].title).toBe('Session Error')
    expect(sent[0].body).toBe('boom')
  })

  it('falls back to the generic copy when the record read THROWS', async () => {
    recordReadError = new Error('sqlite is unavailable')
    await emitAndSettle(EventNames.SESSION_ERROR, { sessionId: 'lane-sid', error: 'boom' })
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Session Error')
  })

  it('still drops delivery_failed for a lane (the SSH-outage spam guard)', async () => {
    // The lane fork sits AFTER the errorKind guard — an SSH outage must not
    // become one push per retry just because the session is the Personal AI's.
    records.set('lane-sid', { claudeSessionId: 'lane-sid', lane: 'chat:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_ERROR, {
      sessionId: 'lane-sid', error: 'ssh down', errorKind: 'delivery_failed',
    }, false)
    expect(sent).toHaveLength(0)
  })
})

describe('non-blocking / failure-safe', () => {
  it('skips entirely while a WS client is connected (unchanged for lanes)', async () => {
    clientCount.mockReturnValue(1)
    records.set('lane-sid', { claudeSessionId: 'lane-sid', lane: 'chat:general:conv-abc' })
    await emitAndSettle(EventNames.SESSION_RESULT, { sessionId: 'lane-sid', result: 'x' }, false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a result with no sessionId does not attempt a lane lookup', async () => {
    await emitAndSettle(EventNames.SESSION_RESULT, { result: 'x' })
    expect(getSessionByClaudeId).not.toHaveBeenCalled()
    expect(sent[0].title).toBe('Session Complete')
  })
})
