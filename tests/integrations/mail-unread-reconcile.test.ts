/**
 * The rule that makes an ABSENCE from a provider's unread answer mean something.
 *
 * The bug being pinned here was reported from a real account: the folder badge said 4 unread while the
 * console listed 12, because eight of them had been read in another client and the cached rows had no
 * path back to the truth. Every case below is about the one question that fixes it without inventing
 * anything: when is the provider's answer complete enough that a message it did not name is read?
 */
import { describe, expect, it } from 'vitest'
import {
  foldersNeedingUnreadRefresh, reconcileUnread,
} from '../../src/integrations/mail/unread-reconcile.js'

const row = (messageId: string, sentAt: number) => ({ messageId, sentAt })

describe('reconcileUnread', () => {
  it('marks read the cached rows a complete answer did not name', () => {
    const result = reconcileUnread({
      answered: [row('a', 300), row('b', 200)],
      cached: [row('a', 300), row('b', 200), row('c', 100), row('d', 50)],
      limit: 50,
    })
    expect(result.basis).toBe('complete')
    expect(result.readNow).toEqual(['c', 'd'])
    expect(result.horizon).toBeUndefined()
  })

  it('treats an empty answer as "nothing is unread here", which is the phone-cleared inbox', () => {
    const result = reconcileUnread({
      answered: [],
      cached: [row('a', 300), row('b', 200)],
      limit: 50,
    })
    expect(result.basis).toBe('complete')
    expect(result.readNow).toEqual(['a', 'b'])
  })

  it('concludes nothing about rows at or below the oldest entry of a CAPPED answer', () => {
    // The answer filled its limit, so it may be a prefix: only the range above its tail is judged.
    const result = reconcileUnread({
      answered: [row('a', 500), row('b', 400), row('c', 300)],
      cached: [row('a', 500), row('stale', 450), row('b', 400), row('c', 300), row('old', 200)],
      limit: 3,
    })
    expect(result.basis).toBe('capped')
    expect(result.horizon).toBe(300)
    expect(result.readNow).toEqual(['stale'])
  })

  it('leaves a tie at the horizon alone: one of two messages in the same second proves nothing about the other', () => {
    const result = reconcileUnread({
      answered: [row('a', 500), row('b', 300)],
      cached: [row('a', 500), row('twin', 300), row('b', 300)],
      limit: 2,
    })
    expect(result.basis).toBe('capped')
    expect(result.readNow).toEqual([])
  })

  it('never reports a row the answer DID name, whatever the basis', () => {
    for (const limit of [2, 50]) {
      const result = reconcileUnread({
        answered: [row('a', 300), row('b', 200)],
        cached: [row('a', 300), row('b', 200)],
        limit,
      })
      expect(result.readNow).toEqual([])
    }
  })

  it('answers an empty plan for an empty cache without claiming a basis it cannot have', () => {
    expect(reconcileUnread({ answered: [], cached: [], limit: 50 }).readNow).toEqual([])
    expect(reconcileUnread({ answered: [row('a', 1)], cached: [], limit: 1 }).basis).toBe('capped')
  })

  it('does not divide by a zero limit: an unasked question caps nothing', () => {
    const result = reconcileUnread({ answered: [], cached: [row('a', 1)], limit: 0 })
    expect(result.basis).toBe('complete')
    expect(result.readNow).toEqual(['a'])
  })
})

describe('foldersNeedingUnreadRefresh', () => {
  const folder = (accountId: string, providerUnread: number, cachedUnread: number) => ({
    accountId, mailboxId: 'inbox', providerUnread, cachedUnread,
  })

  it('costs nothing when every badge agrees with the cache', () => {
    expect(foldersNeedingUnreadRefresh([folder('a', 4, 4), folder('b', 0, 0)])).toEqual([])
  })

  it('asks only the accounts that disagree', () => {
    const chosen = foldersNeedingUnreadRefresh([folder('gmail', 0, 0), folder('work', 4, 12)])
    expect(chosen.map((one) => one.accountId)).toEqual(['work'])
  })

  it('takes the biggest disagreement first and stops at the bound', () => {
    const chosen = foldersNeedingUnreadRefresh(
      [folder('a', 1, 2), folder('b', 4, 12), folder('c', 0, 5)],
      2,
    )
    expect(chosen.map((one) => one.accountId)).toEqual(['b', 'c'])
  })

  it('a bound of zero asks nobody', () => {
    expect(foldersNeedingUnreadRefresh([folder('a', 4, 12)], 0)).toEqual([])
  })

  it('a cache ahead of the badge counts as a disagreement too', () => {
    // The cache can be the fresher of the two: a read through Walnut moves the row immediately while
    // the badge still carries the provider's figure from the last poll.
    expect(foldersNeedingUnreadRefresh([folder('a', 5, 3)]).map((one) => one.accountId)).toEqual(['a'])
  })
})
