/**
 * A message for the running turn through the cloud companion (chat-join-relay.ts).
 *
 * The replica asks the primary; the primary decides with the same synchronous
 * offer its own route makes. Pinned: an older primary's refusal (it knows no join)
 * reads as "not taken", so the phone keeps the message for after the turn; a
 * primary that took it, or already had it, reads as taken under the turn the
 * replica's stream follows; the primary refuses a message it cannot put into the
 * turn and never starts a turn of its own for one, and answers a retry once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async () => ({ ...createMockConstants('walnut-chat-join-relay'), CLOUD_MODE: true }))

const callPrimaryControl = vi.hoisted(() => vi.fn())
const offerJoinToRunningTurn = vi.hoisted(() => vi.fn())
const followedRelayTurnId = vi.hoisted(() => vi.fn())
vi.mock('../../../src/web/routes/v1-control-relay.js', () => ({ callPrimaryControl }))
vi.mock('../../../src/web/routes/api-v1.js', () => ({ offerJoinToRunningTurn }))
vi.mock('../../../src/web/routes/chat-turn-relay.js', () => ({ followedRelayTurnId }))

import { relayChatJoinToPrimary, handlePrimaryChatJoin } from '../../../src/web/routes/chat-join-relay.js'
import { _resetChatSendOnceForTesting, claimChatSend, priorChatSend } from '../../../src/web/routes/chat-send-once.js'
import { _resetJoinsForTesting } from '../../../src/web/routes/api-v1-join.js'

beforeEach(() => {
  callPrimaryControl.mockReset()
  offerJoinToRunningTurn.mockReset()
  followedRelayTurnId.mockReset()
  followedRelayTurnId.mockReturnValue('replica-turn')
  _resetChatSendOnceForTesting()
  _resetJoinsForTesting()
})

describe('replica: relayChatJoinToPrimary', () => {
  it('asks the primary with join under a turn id of its own, and a join reads as taken under the followed turn', async () => {
    callPrimaryControl.mockResolvedValue({ ok: true, result: { accepted: true, turnId: 'primary-turn', joined: true, sessionId: 'lane-9' } })
    const offer = await relayChatJoinToPrimary('general', 'c1', 'replica-turn', 'also this', 'qm-mobile-1')
    expect(offer).toMatchObject({ turnId: 'replica-turn', laneSessionId: 'lane-9', joined: true })
    await expect(offer!.sent).resolves.toBeUndefined()
    const params = callPrimaryControl.mock.calls[0][2] as Record<string, unknown>
    expect(params).toMatchObject({ agentId: 'general', conversationId: 'c1', text: 'also this', messageId: 'qm-mobile-1', join: true })
    // Never the running turn's id: an older primary would answer it as a replay of that turn.
    expect(params.turnId).not.toBe('replica-turn')
  })

  it('an older primary refuses (its turn runs): not taken', async () => {
    callPrimaryControl.mockResolvedValue({ ok: true, result: { accepted: false, turnId: 'x', reason: 'turn_active' } })
    expect(await relayChatJoinToPrimary('general', 'c1', 'replica-turn', 'also this', 'qm-mobile-2')).toBeNull()
  })

  it('a primary out of reach: not taken', async () => {
    callPrimaryControl.mockResolvedValue({ ok: false, failure: { kind: 'bridge_offline', message: 'down' } })
    expect(await relayChatJoinToPrimary('general', 'c1', 'replica-turn', 'also this', 'qm-mobile-3')).toBeNull()
  })

  it('no relayed turn followed here: the primary is not asked', async () => {
    followedRelayTurnId.mockReturnValue(undefined)
    expect(await relayChatJoinToPrimary('general', 'c1', 'replica-turn', 'also this', 'qm-mobile-4')).toBeNull()
    expect(callPrimaryControl).not.toHaveBeenCalled()
  })

  it('a message the primary already had (a retry) is taken', async () => {
    callPrimaryControl.mockResolvedValue({ ok: true, result: { accepted: true, turnId: 'primary-turn', duplicate: true, joined: true } })
    expect(await relayChatJoinToPrimary('general', 'c1', 'replica-turn', 'also this', 'qm-mobile-5')).toMatchObject({ joined: true })
  })

  it('a message the primary runs as a turn of its own reads as that turn, not as joined', async () => {
    callPrimaryControl.mockResolvedValue({ ok: true, result: { accepted: true, turnId: 'primary-new-turn' } })
    expect(await relayChatJoinToPrimary('general', 'c1', 'replica-turn', 'also this', 'qm-mobile-5b'))
      .toMatchObject({ joined: false, turnId: 'primary-new-turn' })
  })
})

describe('primary: handlePrimaryChatJoin', () => {
  it('puts the message into the running turn and claims its id', async () => {
    offerJoinToRunningTurn.mockReturnValue({ turnId: 'primary-turn', laneSessionId: 'lane-9', sent: Promise.resolve(), joined: true })
    const out = await handlePrimaryChatJoin('general', 'c1', 'also this', 'relay-turn', 'qm-mobile-6', false)
    expect(out).toEqual({ accepted: true, turnId: 'primary-turn', joined: true, sessionId: 'lane-9' })
    expect(priorChatSend('general', 'c1', 'qm-mobile-6')).toEqual({ state: 'started', turnId: 'primary-turn' })
    // A retry is answered once, never offered again.
    offerJoinToRunningTurn.mockClear()
    const again = await handlePrimaryChatJoin('general', 'c1', 'also this', 'relay-turn-2', 'qm-mobile-6', false)
    expect(again).toMatchObject({ accepted: true, turnId: 'primary-turn', duplicate: true, joined: true, sessionId: 'lane-9' })
    expect(offerJoinToRunningTurn).not.toHaveBeenCalled()
  })

  it('a retry of a message that ran as a turn of its own says so, not joined', async () => {
    claimChatSend('general', 'c1', 'qm-mobile-11', 'its-own-turn').started()
    const out = await handlePrimaryChatJoin('general', 'c1', 'again', 'relay-turn', 'qm-mobile-11', false)
    expect(out).toEqual({ accepted: true, turnId: 'its-own-turn', duplicate: true })
  })

  it('refuses, and starts nothing, when the turn cannot take it', async () => {
    offerJoinToRunningTurn.mockReturnValue(null)
    expect(await handlePrimaryChatJoin('general', 'c1', 'also this', 'relay-turn', 'qm-mobile-7', false))
      .toMatchObject({ accepted: false, reason: 'turn_active' })
  })

  it('refuses a message with no id or with pictures', async () => {
    expect(await handlePrimaryChatJoin('general', 'c1', 'also this', 'relay-turn', undefined, false))
      .toMatchObject({ accepted: false, reason: 'turn_active' })
    expect(await handlePrimaryChatJoin('general', 'c1', 'look', 'relay-turn', 'qm-mobile-8', true))
      .toMatchObject({ accepted: false, reason: 'turn_active' })
    expect(offerJoinToRunningTurn).not.toHaveBeenCalled()
  })

  it('a send into the turn that fails gives the id back', async () => {
    offerJoinToRunningTurn.mockImplementation(() => ({ turnId: 'primary-turn', laneSessionId: 'lane-9', sent: Promise.reject(new Error('queue write failed')) }))
    expect(await handlePrimaryChatJoin('general', 'c1', 'also this', 'relay-turn', 'qm-mobile-9', false))
      .toMatchObject({ accepted: false, reason: 'turn_active' })
    expect(priorChatSend('general', 'c1', 'qm-mobile-9')).toBeUndefined()
  })

  it('a message whose first attempt is still in the air is refused, not sent twice', async () => {
    claimChatSend('general', 'c1', 'qm-mobile-10', 'other-turn')
    expect(await handlePrimaryChatJoin('general', 'c1', 'also this', 'relay-turn', 'qm-mobile-10', false))
      .toMatchObject({ accepted: false, reason: 'turn_active' })
    expect(offerJoinToRunningTurn).not.toHaveBeenCalled()
  })
})
