/**
 * The assertion that would have caught the split-brain: a token relayed in from a
 * replica must make the PRIMARY's next letter attempt a send.
 *
 * End to end on the primary side, no Apple key and no network:
 *   replica's relay frame → `server.push.*` control action → the real config
 *   store → a real letter event on the bus → the letter-push subscriber →
 *   a stubbed APNs sender, which must be called with exactly that one token.
 *
 * Everything except the APNs transport is real (real config.yaml in a temp dir,
 * real event bus, real control-action dispatch), because every layer in that
 * chain existed and worked before — the missing link was that the token never
 * reached this box's store, and no test asserted the two halves live together.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-push-primary-e2e'))

const sendApns = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, sent: 1, failed: 0, deadTokens: [] as string[],
})))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({
    configured: true, environment: 'production', topic: 'test.topic',
  })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import {
  initLetterPush,
  pushLetter,
  resetLetterPushForTests,
  resetLetterPushWarningsForTests,
} from '../../src/core/push/letter-push.js'
import { registerPushToken } from '../../src/core/push/registry.js'
import { WALNUT_HOME } from '../../src/constants.js'

const TOKEN = 'c'.repeat(64)

const LETTER = {
  letterId: 'lt-m9x2k1-a4f7',
  subject: 'Sync freeze root cause found',
  type: 'review',
  textPreview: 'The 22h stall was an orphaned rebase lock.',
  kind: 'new' as const,
}

/** The exact frame routes/push.ts puts on the bridge for a phone registration. */
async function relayRegister(overrides: Record<string, unknown> = {}) {
  return await handleSessionControlRelay('server.push.register', '__server__', {
    token: TOKEN, platform: 'ios', environment: 'production', keyName: 'iPhone',
    ...overrides,
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  sendApns.mockClear()
  resetLetterPushForTests()
  resetLetterPushWarningsForTests()
  bus.unsubscribe('letter-push')
})

afterEach(async () => {
  bus.unsubscribe('letter-push')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a relayed registration makes the primary push', () => {
  it('control action → config store → letter event → attempted send to 1 token', async () => {
    // 0. Before any registration, a letter attempts nothing. This is the exact
    //    state prod was stuck in: the letter arrived, no push was possible.
    initLetterPush()
    const before = await pushLetter(LETTER)
    expect(before).toMatchObject({ attempted: false, sent: 0 })
    expect(before.reason).toBe('no device registered for push')
    expect(sendApns).not.toHaveBeenCalled()

    // 1. The replica relays the phone's registration in.
    const relayed = await relayRegister()
    expect(relayed).toMatchObject({
      ok: true,
      result: { ok: true, kind: 'apns', mode: 'always', deliverable: true },
    })

    // 2. A real letter event on the primary's bus, shaped exactly like the
    //    human-inbox store's emit (destinations ['*'], source 'human-inbox').
    bus.emit(EventNames.HUMAN_INBOX_LETTER, {
      letterId: LETTER.letterId,
      subject: LETTER.subject,
      type: LETTER.type,
      textPreview: LETTER.textPreview,
      senderSessionId: 'sess-abc',
      kind: LETTER.kind,
    }, ['*'], { source: 'human-inbox' })

    // 3. The sender is reached, with that one relayed token.
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    const [targets, payload] = sendApns.mock.calls[0] as unknown as [
      Array<{ token: string; environment?: string }>, Record<string, unknown>,
    ]
    expect(targets).toEqual([{ token: TOKEN, environment: 'production' }])
    // The deep link the phone reads on tap must survive the whole chain.
    expect(payload).toMatchObject({ type: 'human_inbox_letter', letterId: LETTER.letterId })
  })

  it('status over the relay reports the token the primary now holds', async () => {
    await relayRegister()
    const status = await handleSessionControlRelay('server.push.status', '__server__', { keyName: 'iPhone' })
    expect(status).toMatchObject({
      ok: true,
      result: { registered: true, count: 1, thisDevice: { mode: 'always', kind: 'apns' } },
    })
  })

  it('a relayed re-registration stays one row and one push target', async () => {
    await relayRegister()
    await relayRegister()
    await relayRegister({ mode: 'always' })
    const out = await pushLetter(LETTER)
    expect(out).toMatchObject({ attempted: true, sent: 1, failed: 0, suppressed: 0 })
    expect(sendApns).toHaveBeenCalledTimes(1)
    const [targets] = sendApns.mock.calls[0] as unknown as [Array<{ token: string }>]
    expect(targets).toHaveLength(1)
  })

  it('a relayed unregister stops the pushes again', async () => {
    await relayRegister()
    const gone = await handleSessionControlRelay('server.push.unregister', '__server__', { token: TOKEN })
    expect(gone).toMatchObject({ ok: true, result: { ok: true, removed: 1 } })
    const out = await pushLetter(LETTER)
    expect(out).toMatchObject({ attempted: false, sent: 0 })
    expect(out.reason).toBe('no device registered for push')
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('a relayed preference change is what the sender then obeys', async () => {
    await relayRegister()
    // when-inactive + a fresh foreground lease = this phone stays quiet.
    await handleSessionControlRelay('server.push.preferences', '__server__', {
      keyName: 'iPhone', mode: 'when-inactive',
    })
    await handleSessionControlRelay('server.push.active', '__server__', {
      keyName: 'iPhone', active: true,
    })
    const quiet = await pushLetter(LETTER)
    expect(quiet).toMatchObject({ attempted: false, sent: 0, suppressed: 1 })
    expect(sendApns).not.toHaveBeenCalled()

    // Releasing the lease (backgrounded) lets the very next letter through.
    await handleSessionControlRelay('server.push.active', '__server__', {
      keyName: 'iPhone', active: false,
    })
    const buzzed = await pushLetter(LETTER)
    expect(buzzed).toMatchObject({ attempted: true, sent: 1 })
  })

  it('a relayed device revoke stops that phone\'s letters', async () => {
    await relayRegister()
    const revoked = await handleSessionControlRelay('server.push.revoke-device', '__server__', {
      keyName: 'iPhone',
    })
    expect(revoked).toMatchObject({ ok: true, result: { removed: 1 } })
    const out = await pushLetter(LETTER)
    expect(out).toMatchObject({ attempted: false, sent: 0 })
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('a relayed revoke leaves a same-name phone paired to the PRIMARY alone', async () => {
    // Two boxes, two name spaces: revoking the replica's "iPhone" must not
    // unregister the Mac's own "iPhone".
    await registerPushToken({
      token: 'd'.repeat(64), platform: 'ios', environment: 'production',
      keyName: 'iPhone', origin: 'local',
    })
    await relayRegister()
    await handleSessionControlRelay('server.push.revoke-device', '__server__', { keyName: 'iPhone' })
    const out = await pushLetter(LETTER)
    expect(out).toMatchObject({ attempted: true, sent: 1 })
    const [targets] = sendApns.mock.calls[0] as unknown as [Array<{ token: string }>]
    expect(targets).toEqual([{ token: 'd'.repeat(64), environment: 'production' }])
  })

  it('propagates device_not_registered across the relay — the client\'s self-heal signal', async () => {
    // No registration at all: the phone believes it uploaded, this box disagrees.
    const reply = await handleSessionControlRelay('server.push.preferences', '__server__', {
      keyName: 'iPhone', mode: 'when-inactive',
    })
    expect(reply).toMatchObject({
      ok: false, errorKind: 'not_found', errorCode: 'device_not_registered',
    })
  })

  it('a bad token relayed in is refused with the primary\'s own status', async () => {
    const bad = await handleSessionControlRelay('server.push.register', '__server__', {
      token: 'not-a-token', platform: 'ios', keyName: 'iPhone',
    })
    expect(bad).toMatchObject({ ok: false, errorKind: 'bad_request' })
    const out = await pushLetter(LETTER)
    expect(out.reason).toBe('no device registered for push')
  })
})
