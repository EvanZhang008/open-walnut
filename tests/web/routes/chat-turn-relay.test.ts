/**
 * chat-turn-relay — the REPLICA half in isolation: engine selection and the
 * degradation matrix.
 *
 * The one rule under test: a phone chatting through the cloud replica must get
 * the PRIMARY's configured engine (claude-code) when the relay is usable, and a
 * real answer from the local loop (marked as a fallback) when it is not. It must
 * never end up with "no engine".
 *
 * The bridge is mocked at the v1-control-relay seam, which is where the four
 * failure classes are already normalized (needs_upgrade / bridge_offline /
 * error) — so this file drives the exact vocabulary the real ladder produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-relay-unit', { CLOUD_MODE: true }))

// vi.mock factories are hoisted above the module scope, so the spies they close
// over have to be created in a hoisted block too.
const { callPrimaryControlMock, emitSseMock, bridgeRequestMock } = vi.hoisted(() => ({
  callPrimaryControlMock: vi.fn(),
  emitSseMock: vi.fn(),
  bridgeRequestMock: vi.fn(),
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

// The image staging lane's only seam. `image.save` itself is a daemon command
// covered against the REAL daemon in tests/e2e/daemon-bridge-image-save-e2e.ts;
// here we drive the replica's decision table around it.
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError: class extends Error {},
}))

import {
  relayChatTurnToPrimary,
  handleBridgeChatTurnFrame,
  resetChatTurnRelayState,
  FALLBACK_ENGINE_LABEL,
  CHAT_TURN_FRAME_KIND,
} from '../../../src/web/routes/chat-turn-relay.js'

const CONV = 'conv-relay-unit-1'
const TURN = 'turn-unit-1'

/** 1×1 PNG — small enough that compressForApi early-exits, so no sharp work. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngPayload() {
  return { data: TINY_PNG_BASE64, mediaType: 'image/png' }
}

beforeEach(() => {
  callPrimaryControlMock.mockReset()
  emitSseMock.mockReset()
  bridgeRequestMock.mockReset()
  resetChatTurnRelayState()
})

afterEach(() => {
  resetChatTurnRelayState()
})

/** The accept reply a healthy claude-code primary sends. */
function acceptedByClaudeCode() {
  return { ok: true, result: { accepted: true, turnId: TURN, engine: 'claude-code' } }
}

describe('engine selection: a healthy primary owns the turn', () => {
  it('relays and reports the primary\'s engine, not the replica\'s default', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())

    const outcome = await relayChatTurnToPrimary('general', CONV, 'hello', TURN)

    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') throw new Error('unreachable')
    // The whole point of the feature: the answer comes from Claude Code.
    expect(outcome.engine).toBe('claude-code')
    expect(callPrimaryControlMock).toHaveBeenCalledWith(
      'server.chat.turn',
      '__server__',
      { agentId: 'general', conversationId: CONV, text: 'hello', turnId: TURN },
      30_000,
    )
  })

  it('the accept resolves without waiting for the turn (frames arrive later)', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    const outcome = await relayChatTurnToPrimary('general', CONV, 'hi', TURN)
    if (outcome.kind !== 'accepted') throw new Error('expected accepted')

    // `settled` must still be pending — a chat turn takes minutes, and the
    // daemon's relay budget is 45s, so awaiting it inside the RPC is impossible.
    let settled = false
    void outcome.settled.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'message-end', data: { turnId: TURN, fullText: 'done' } })
    await outcome.settled
    expect(settled).toBe(true)
  })

  it('rejects a second concurrent turn on the same conversation', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    await relayChatTurnToPrimary('general', CONV, 'first', TURN)

    const second = await relayChatTurnToPrimary('general', CONV, 'second', 'turn-unit-2')
    expect(second.kind).toBe('turn_active')
    // No second RPC — the guard is local.
    expect(callPrimaryControlMock).toHaveBeenCalledTimes(1)
  })
})

describe('image turns: bytes take the image lane, the RPC carries paths', () => {
  it('stages each image on the primary and relays only the returned paths', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    let n = 0
    bridgeRequestMock.mockImplementation(async () => ({
      ok: true, path: `/tmp/open-walnut/images/mobile/1700000000-abcd000${n++}.png`, size: 68,
    }))

    const outcome = await relayChatTurnToPrimary('general', CONV, 'what is this?', TURN, [pngPayload(), pngPayload()])
    expect(outcome.kind).toBe('accepted')

    // One image.save per picture, on the PRIMARY's daemon, with no path param
    // (the daemon generates the filename — no caller path crosses the bridge).
    const saves = bridgeRequestMock.mock.calls.filter((c) => c[1] === 'image.save')
    expect(saves).toHaveLength(2)
    expect(saves[0][0]).toBe('__local__')
    expect(Object.keys(saves[0][2] as object).sort()).toEqual(['data', 'mediaType'])

    // THE core assertion: the control RPC carries PATHS, never base64. Base64 in
    // a control frame is the 1009 oversized-frame kill that takes every
    // in-flight RPC on the shared bridge socket with it.
    const params = callPrimaryControlMock.mock.calls[0][2] as Record<string, unknown>
    expect(params.imagePaths).toEqual([
      '/tmp/open-walnut/images/mobile/1700000000-abcd0000.png',
      '/tmp/open-walnut/images/mobile/1700000000-abcd0001.png',
    ])
    expect(JSON.stringify(params)).not.toContain(TINY_PNG_BASE64.slice(0, 40))
  })

  it('a text-only turn sends no imagePaths key at all (old primaries see the old payload)', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    await relayChatTurnToPrimary('general', CONV, 'hello', TURN)

    expect(bridgeRequestMock).not.toHaveBeenCalled()
    expect(callPrimaryControlMock.mock.calls[0][2]).toEqual({
      agentId: 'general', conversationId: CONV, text: 'hello', turnId: TURN,
    })
  })

  it.each([
    ['the daemon predates image.save', { ok: false, error: 'unknown command: image.save' }],
    ['the daemon refuses the bytes', { ok: false, error: 'image.save: too large (EFBIG)' }],
    ['the reply carries no path', { ok: true, size: 12 }],
  ])('falls back when %s — and never relays a text-only version of the turn', async (_label, reply) => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    bridgeRequestMock.mockResolvedValue(reply)

    const outcome = await relayChatTurnToPrimary('general', CONV, 'what is this?', TURN, [pngPayload()])
    expect(outcome.kind).toBe('unavailable')
    // The turn must NOT have been relayed without its picture: answering a
    // "what is this?" with no image would be confidently wrong.
    expect(callPrimaryControlMock).not.toHaveBeenCalled()
  })

  it('a staging failure on image 2 of 3 aborts the whole turn, never a partial set', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    let call = 0
    bridgeRequestMock.mockImplementation(async () => {
      call += 1
      if (call === 2) return { ok: false, error: 'image.save failed: ENOSPC' }
      return { ok: true, path: `/tmp/open-walnut/images/mobile/1700000000-cafe000${call}.png`, size: 68 }
    })

    const outcome = await relayChatTurnToPrimary('general', CONV, 'compare these', TURN,
      [pngPayload(), pngPayload(), pngPayload()])
    expect(outcome.kind).toBe('unavailable')
    // Stops at the failure instead of pushing the third picture over the wire.
    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    expect(callPrimaryControlMock).not.toHaveBeenCalled()
  })

  it('a bridge that throws mid-staging degrades instead of rejecting', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    bridgeRequestMock.mockRejectedValue(new Error('No live bridge for host: __local__'))

    const outcome = await relayChatTurnToPrimary('general', CONV, 'look', TURN, [pngPayload()])
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind !== 'unavailable') throw new Error('unreachable')
    expect(outcome.reason).toContain('image staging')
  })

  it('refuses more images than one message may carry, without touching the bridge', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    const outcome = await relayChatTurnToPrimary('general', CONV, 'many', TURN,
      [pngPayload(), pngPayload(), pngPayload(), pngPayload(), pngPayload(), pngPayload()])
    expect(outcome.kind).toBe('unavailable')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('an image compression cannot rescue is refused locally, not on the wire', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    // sharp cannot read this, so compressForApi returns it unchanged (it degrades
    // rather than throwing) — and the post-compression cap is what stops it. That
    // ordering matters: a pre-compression-only check would reject compressible
    // photos, a post-only check would let this one onto the shared socket.
    const outcome = await relayChatTurnToPrimary('general', CONV, 'huge', TURN,
      [{ data: 'A'.repeat(14_000_004), mediaType: 'image/png' }])
    expect(outcome.kind).toBe('unavailable')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('a failed image turn leaves no in-flight slot behind (the local loop reruns it)', async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'image.save: too large (EFBIG)' })
    expect((await relayChatTurnToPrimary('general', CONV, 'pic', TURN, [pngPayload()])).kind)
      .toBe('unavailable')

    // Same conversation must still be relayable — a leaked slot would report
    // turn_active and surface as a phantom 409 on the phone's NEXT message.
    bridgeRequestMock.mockResolvedValue({ ok: true, path: '/tmp/open-walnut/images/mobile/1700000000-beef0001.png' })
    const retry = await relayChatTurnToPrimary('general', CONV, 'pic again', 'turn-unit-img-2', [pngPayload()])
    expect(retry.kind).toBe('accepted')
  })
})

describe('degradation matrix: every failure falls back, none hangs', () => {
  it('bridge offline → unavailable (caller runs the local loop)', async () => {
    callPrimaryControlMock.mockResolvedValue({
      ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__' },
    })
    const outcome = await relayChatTurnToPrimary('general', CONV, 'hi', TURN)
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind !== 'unavailable') throw new Error('unreachable')
    expect(outcome.reason).toContain('bridge_offline')
  })

  it('an OLD primary that does not know the action → unavailable, not an error', async () => {
    // classifyRelayReply maps 'Unknown control action: …' to needs_upgrade.
    callPrimaryControlMock.mockResolvedValue({
      ok: false,
      failure: { kind: 'needs_upgrade', message: 'The primary box predates this mobile action' },
    })
    const outcome = await relayChatTurnToPrimary('general', CONV, 'hi', TURN)
    expect(outcome.kind).toBe('unavailable')
  })

  it('the relay module itself throwing → unavailable, never a rejected promise', async () => {
    callPrimaryControlMock.mockRejectedValue(new Error('dispatch exploded'))
    const outcome = await relayChatTurnToPrimary('general', CONV, 'hi', TURN)
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind !== 'unavailable') throw new Error('unreachable')
    expect(outcome.reason).toContain('dispatch exploded')
  })

  it('primary answers but refuses → unavailable (fallback), except turn_active', async () => {
    callPrimaryControlMock.mockResolvedValue({
      ok: true, result: { accepted: false, reason: 'bad_request', message: 'text is required' },
    })
    expect((await relayChatTurnToPrimary('general', CONV, 'hi', TURN)).kind).toBe('unavailable')

    callPrimaryControlMock.mockResolvedValue({
      ok: true, result: { accepted: false, reason: 'turn_active', message: 'A turn is already active' },
    })
    const busy = await relayChatTurnToPrimary('general', CONV, 'hi', 'turn-unit-3')
    // turn_active must NOT fall back: running a second turn locally would
    // produce two answers and two history writers for one user message.
    expect(busy.kind).toBe('turn_active')
  })

  it('every failure releases the in-flight slot so the next turn can relay', async () => {
    callPrimaryControlMock.mockResolvedValue({
      ok: false, failure: { kind: 'bridge_offline', message: 'down' },
    })
    await relayChatTurnToPrimary('general', CONV, 'hi', TURN)

    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    const retry = await relayChatTurnToPrimary('general', CONV, 'hi again', 'turn-unit-4')
    expect(retry.kind).toBe('accepted')
  })

  it('the fallback engine label is a distinct, stable marker', () => {
    // iOS ignores unknown fields, so this exists purely for observability —
    // but it must not silently collide with a real provider id.
    expect(FALLBACK_ENGINE_LABEL).toBe('walnut-agent-fallback')
    expect(FALLBACK_ENGINE_LABEL).not.toBe('walnut-agent')
    expect(FALLBACK_ENGINE_LABEL).not.toBe('claude-code')
  })
})

describe('downlink frames: fan-out, engine stamping, and the injection gate', () => {
  beforeEach(async () => {
    callPrimaryControlMock.mockResolvedValue(acceptedByClaudeCode())
    await relayChatTurnToPrimary('general', CONV, 'hi', TURN)
    emitSseMock.mockReset()
  })

  it('forwards a delta onto the conversation channel verbatim', () => {
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'text-delta', data: { delta: 'Hel' } })
    expect(emitSseMock).toHaveBeenCalledWith(CONV, 'text-delta', { delta: 'Hel' }, { reset: false })
  })

  it('message-start resets the replay ring, exactly like the local path', () => {
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'message-start', data: { turnId: TURN } })
    expect(emitSseMock).toHaveBeenCalledWith(CONV, 'message-start', { turnId: TURN }, { reset: true })
  })

  it('stamps the answering engine on the terminal frame', () => {
    handleBridgeChatTurnFrame({
      conversationId: CONV, turnId: TURN, event: 'message-end', data: { turnId: TURN, fullText: 'answer' },
    })
    expect(emitSseMock).toHaveBeenCalledWith(
      CONV, 'message-end',
      { turnId: TURN, fullText: 'answer', engine: 'claude-code' },
      { reset: false },
    )
  })

  it('drops an unknown event name (SSE injection attempt)', () => {
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'evil-event', data: { x: 1 } })
    expect(emitSseMock).not.toHaveBeenCalled()
  })

  it('drops frames for an untracked conversation and for a stale turnId', () => {
    handleBridgeChatTurnFrame({ conversationId: 'conv-other', turnId: TURN, event: 'text-delta', data: { delta: 'x' } })
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: 'turn-stale', event: 'text-delta', data: { delta: 'x' } })
    expect(emitSseMock).not.toHaveBeenCalled()
  })

  it('ignores frames after the turn already ended (late duplicate)', () => {
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'message-end', data: { turnId: TURN } })
    emitSseMock.mockReset()
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'text-delta', data: { delta: 'late' } })
    expect(emitSseMock).not.toHaveBeenCalled()
  })

  it('an `error` frame also ends the turn (composer must unlock)', async () => {
    const outcome = await relayChatTurnToPrimary('general', 'conv-err', 'hi', 'turn-err')
    if (outcome.kind !== 'accepted') throw new Error('expected accepted')
    handleBridgeChatTurnFrame({
      conversationId: 'conv-err', turnId: 'turn-err', event: 'error', data: { message: 'boom' },
    })
    await outcome.settled // resolves — no hang
    expect(emitSseMock).toHaveBeenCalledWith(
      'conv-err', 'error', { message: 'boom', engine: 'claude-code' }, { reset: false },
    )
  })

  it('a keepalive frame proves liveness but is NEVER fanned out to the phone', () => {
    // A relayed turn can sit in the primary's per-agent queue for minutes and a
    // long tool call is silent too, so the primary sends proof-of-life. It must
    // not reach the SSE stream — it is not part of the frozen v1 contract.
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: '__keepalive', data: null })
    expect(emitSseMock).not.toHaveBeenCalled()

    // And the turn is still live afterwards (the keepalive didn't settle it).
    handleBridgeChatTurnFrame({ conversationId: CONV, turnId: TURN, event: 'text-delta', data: { delta: 'x' } })
    expect(emitSseMock).toHaveBeenCalledWith(CONV, 'text-delta', { delta: 'x' }, { reset: false })
  })

  it('the frame kind is a dedicated lane, not one of the feed kinds', () => {
    // events-v1 routes by this kind BEFORE its own three-kind allowlist; a
    // collision would make chat frames fan out on the shared events channel.
    expect(CHAT_TURN_FRAME_KIND).toBe('chat-turn-frame')
    expect(['session-upsert', 'task-upsert', 'task-delete', 'projection-upsert', 'transcript-upsert'])
      .not.toContain(CHAT_TURN_FRAME_KIND)
  })
})
