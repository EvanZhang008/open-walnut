/**
 * chat-send-once.ts on its own: which ids it takes, that an id is remembered only
 * once its turn started (a claim given back is forgotten at once), that a relay
 * that may have reached the primary keeps it UNSURE with its turnId, how long it
 * remembers, the cap, and that a repeat can wait for a claim's outcome.
 *
 * This is the unit test of the module the send-once change adds, so it cannot load
 * on a tree without it; every behavior it backs is also pinned through the route
 * (api-v1-chat-send-once*.test.ts), which fails on such a tree by what it does.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  chatMessageIdOf, priorChatSend, claimChatSend,
  _resetChatSendOnceForTesting, _CHAT_SEND_ONCE_LIMITS,
} from '../../../src/web/routes/chat-send-once.js'

beforeEach(() => _resetChatSendOnceForTesting())

describe('chat-send-once', () => {
  it('takes a client id of letters, digits and _.:- up to 128, and nothing else', () => {
    expect(chatMessageIdOf({ messageId: 'qm-mobile-1791666195.6099482' })).toBe('qm-mobile-1791666195.6099482')
    expect(chatMessageIdOf({ messageId: 'queued-97F75F7C-6BA2-4992-893E-A1CA59769CFD' }))
      .toBe('queued-97F75F7C-6BA2-4992-893E-A1CA59769CFD')
    expect(chatMessageIdOf({ messageId: 'a'.repeat(128) })).toBe('a'.repeat(128))
    for (const bad of ['a'.repeat(129), '', '-lead', '../x', 'a b', 'a/b', '<x>', '\u00e9t\u00e9', 7, null]) {
      expect(chatMessageIdOf({ messageId: bad })).toBeUndefined()
    }
    expect(chatMessageIdOf({})).toBeUndefined()
    expect(chatMessageIdOf(undefined)).toBeUndefined()
  })

  it('remembers a started send per agent and conversation, for the TTL', () => {
    claimChatSend('general', 'c1', 'm1', 't1', 1_000).started()
    const at = Date.now()
    expect(priorChatSend('general', 'c1', 'm1', at)).toEqual({ state: 'started', turnId: 't1' })
    expect(priorChatSend('general', 'c2', 'm1', at)).toBeUndefined()
    expect(priorChatSend('mentor', 'c1', 'm1', at)).toBeUndefined()
    // The clock starts when the turn started, not at the claim.
    expect(priorChatSend('general', 'c1', 'm1', at + _CHAT_SEND_ONCE_LIMITS.ttlMs - 1_000))
      .toEqual({ state: 'started', turnId: 't1' })
    expect(priorChatSend('general', 'c1', 'm1', at + _CHAT_SEND_ONCE_LIMITS.ttlMs + 1_000)).toBeUndefined()
    // Expired is gone, not just hidden.
    expect(priorChatSend('general', 'c1', 'm1', at)).toBeUndefined()
  })

  it('a claim whose turn never started is forgotten, so the next attempt is a new send', async () => {
    const claim = claimChatSend('general', 'c', 'm', 't-relay')
    const prior = priorChatSend('general', 'c', 'm')
    expect(prior?.state).toBe('claimed')
    claim.dropped()
    expect(priorChatSend('general', 'c', 'm')).toBeUndefined()
    // The waiter hears what became of it.
    await expect(prior && prior.state === 'claimed' ? prior.outcome : null).resolves.toBe('dropped')
    // Settled once: a late started() does not bring it back.
    claim.started()
    expect(priorChatSend('general', 'c', 'm')).toBeUndefined()
  })

  it('a waiter on a claim hears it started', async () => {
    const claim = claimChatSend('general', 'c', 'm', 't-1')
    const prior = priorChatSend('general', 'c', 'm')
    claim.started()
    await expect(prior && prior.state === 'claimed' ? prior.outcome : null).resolves.toBe('started')
    expect(priorChatSend('general', 'c', 'm')).toEqual({ state: 'started', turnId: 't-1' })
    // A drop after the start changes nothing: the turn ran.
    claim.dropped()
    expect(priorChatSend('general', 'c', 'm')).toEqual({ state: 'started', turnId: 't-1' })
  })

  it('a newer claim under the same id is not the older claim\'s to drop', () => {
    const older = claimChatSend('general', 'c', 'm', 't-old')
    older.dropped()
    const newer = claimChatSend('general', 'c', 'm', 't-new')
    older.dropped()
    expect(priorChatSend('general', 'c', 'm')).toMatchObject({ state: 'claimed', turnId: 't-new' })
    newer.started()
    expect(priorChatSend('general', 'c', 'm')).toEqual({ state: 'started', turnId: 't-new' })
  })

  it('keeps the newest records past the cap', () => {
    const { max } = _CHAT_SEND_ONCE_LIMITS
    for (let i = 0; i <= max; i++) claimChatSend('general', 'c', `m${i}`, `t${i}`).started()
    expect(priorChatSend('general', 'c', 'm0')).toBeUndefined()
    expect(priorChatSend('general', 'c', 'm1')).toEqual({ state: 'started', turnId: 't1' })
    expect(priorChatSend('general', 'c', `m${max}`)).toEqual({ state: 'started', turnId: `t${max}` })
  })

  it('a relay that may have reached the primary keeps the id unsure, with its turnId, for the TTL', async () => {
    const claim = claimChatSend('general', 'c', 'm', 't-unsure')
    const prior = priorChatSend('general', 'c', 'm')
    claim.unsure()
    await expect(prior && prior.state === 'claimed' ? prior.outcome : null).resolves.toBe('unsure')
    const at = Date.now()
    expect(priorChatSend('general', 'c', 'm', at)).toEqual({ state: 'unsure', turnId: 't-unsure' })
    // Settled once: a late drop (the POST's own clean-up) does not forget it.
    claim.dropped()
    expect(priorChatSend('general', 'c', 'm', at)).toEqual({ state: 'unsure', turnId: 't-unsure' })
    expect(priorChatSend('general', 'c', 'm', at + _CHAT_SEND_ONCE_LIMITS.ttlMs + 1_000)).toBeUndefined()
  })

  it('the retry of an unsure relay claims it again, and a start under the primary\'s turnId is remembered so', () => {
    claimChatSend('general', 'c', 'm', 't-first').unsure()
    const retry = claimChatSend('general', 'c', 'm', 't-first')
    expect(priorChatSend('general', 'c', 'm')).toMatchObject({ state: 'claimed', turnId: 't-first' })
    retry.started('t-on-the-primary')
    expect(priorChatSend('general', 'c', 'm')).toEqual({ state: 'started', turnId: 't-on-the-primary' })
  })
})
