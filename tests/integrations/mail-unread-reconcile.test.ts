/**
 * The rule that makes an ABSENCE from a provider's unread answer mean something.
 *
 * The bug being pinned here was reported from a real account: the folder badge said 4 unread while the
 * console listed 12, because eight of them had been read in another client and the cached rows had no
 * path back to the truth. Every case below is about the one question that fixes it without inventing
 * anything: when is the provider's answer complete enough that a message it did not name is read?
 */
import { describe, expect, it } from 'vitest'
import { reconcileUnread } from '../../src/integrations/mail/unread-reconcile.js'

const row = (messageId: string, sentAt: number) => ({ messageId, sentAt })

describe('reconcileUnread', () => {
  it('marks read the cached rows a complete answer did not name', () => {
    const result = reconcileUnread({
      answered: [row('a', 300), row('b', 200)],
      cached: [row('a', 300), row('b', 200), row('c', 100), row('d', 50)],
      limit: 50,
      providerUnread: 2,
    })
    expect(result.basis).toBe('complete')
    expect(result.readNow).toEqual(['c', 'd'])
    expect(result.horizon).toBeUndefined()
  })

  /**
   * The provider contract says a short answer proves nothing: "`limit` is a page size; a provider may
   * answer fewer". So the answer's own length can never establish completeness, and without the folder's
   * count to check it against, every answer is a prefix.
   */
  it('treats an answer with no folder count to check it against as a prefix', () => {
    const result = reconcileUnread({
      answered: [row('a', 300), row('b', 200)],
      cached: [row('a', 300), row('b', 200), row('c', 100), row('d', 50)],
      limit: 50,
    })
    expect(result.basis).toBe('no-badge')
    expect(result.horizon).toBe(200)
    expect(result.readNow).toEqual([])
  })

  it('clears the cache on an empty answer ONLY when the folder badge agrees it is empty', () => {
    // The phone-cleared inbox: the provider names nothing and the folder itself counts nothing.
    const result = reconcileUnread({
      answered: [],
      cached: [row('a', 300), row('b', 200)],
      limit: 50,
      providerUnread: 0,
    })
    expect(result.basis).toBe('complete')
    expect(result.readNow).toEqual(['a', 'b'])
  })

  /**
   * The dangerous case, and the reason the badge is consulted at all.
   *
   * The provider contract spells it out: an empty array means "nothing to add", NEVER "nothing is
   * unread", so that a provider can answer for the one mailbox its api can filter and return `[]` for
   * every other without lying. The Outlook provider does exactly that: the Inbox only. Reading `[]` as
   * "this folder is clear" marks a whole folder read on the strength of a provider declining to answer,
   * and a mail wrongly marked read is hidden, which is worse than one shown as stale.
   */
  it('concludes nothing when an empty answer contradicts a folder that counts unread', () => {
    const result = reconcileUnread({
      answered: [],
      cached: [row('a', 300), row('b', 200)],
      limit: 50,
      providerUnread: 2,
    })
    expect(result.basis).toBe('no-answer')
    expect(result.readNow).toEqual([])
  })

  it('concludes nothing from an empty answer when no badge was passed at all', () => {
    const result = reconcileUnread({ answered: [], cached: [row('a', 300)], limit: 50 })
    expect(result.basis).toBe('no-answer')
    expect(result.readNow).toEqual([])
  })

  it('concludes nothing about rows at or below the oldest entry of a CAPPED answer', () => {
    const result = reconcileUnread({
      answered: [row('a', 500), row('b', 400), row('c', 300)],
      cached: [row('a', 500), row('stale', 450), row('b', 400), row('c', 300), row('old', 200)],
      limit: 3,
      providerUnread: 3,
    })
    expect(result.basis).toBe('capped')
    expect(result.horizon).toBe(300)
    expect(result.readNow).toEqual(['stale'])
  })

  /**
   * The caller drops envelopes belonging to another mailbox before asking, so the cap has to be judged on
   * what the PROVIDER handed back. One foreign envelope in a full page used to turn "this is page one of
   * many" into "this is everything", and then every cached row below the page was marked read.
   */
  it('judges the cap on what the provider returned, not on what survived the mailbox filter', () => {
    const result = reconcileUnread({
      answered: [row('a', 500), row('b', 400)],
      cached: [row('a', 500), row('b', 400), row('below', 100)],
      limit: 3,
      returned: 3,
      providerUnread: 2,
    })
    expect(result.basis).toBe('capped')
    expect(result.readNow).toEqual([])
  })

  it('leaves a tie at the horizon alone: one of two messages in the same second proves nothing about the other', () => {
    const result = reconcileUnread({
      answered: [row('a', 500), row('b', 300)],
      cached: [row('a', 500), row('twin', 300), row('b', 300)],
      limit: 2,
      providerUnread: 2,
    })
    expect(result.basis).toBe('capped')
    expect(result.readNow).toEqual([])
  })

  /**
   * The provider call takes up to 8 seconds, and a poll can ingest a newly delivered mail inside that
   * window. That mail is not in the snapshot being judged, so its absence from the answer says nothing
   * about it: without this bound, opening an unread list marked fresh mail as read.
   */
  it('never judges a row that arrived after the snapshot it is being judged against', () => {
    const result = reconcileUnread({
      answered: [row('a', 1_000), row('b', 900)],
      cached: [row('a', 1_000), row('b', 900), row('arrived-mid-call', 1_500), row('older-stale', 800)],
      limit: 50,
      providerUnread: 2,
      snapshotAt: 1_200,
    })
    expect(result.basis).toBe('complete')
    expect(result.readNow).toEqual(['older-stale'])
  })

  it('never reports a row the answer DID name, whatever the basis', () => {
    for (const limit of [2, 50]) {
      const result = reconcileUnread({
        answered: [row('a', 300), row('b', 200)],
        cached: [row('a', 300), row('b', 200)],
        limit,
        providerUnread: 2,
      })
      expect(result.readNow).toEqual([])
    }
  })

  it('answers an empty plan for an empty cache without claiming a basis it cannot have', () => {
    expect(reconcileUnread({ answered: [], cached: [], limit: 50 }).readNow).toEqual([])
    expect(reconcileUnread({ answered: [row('a', 1)], cached: [], limit: 1 }).readNow).toEqual([])
  })

  /**
   * A limit of zero is not a question anyone asked, so it cannot license a conclusion. It used to read as
   * "not capped", which meant an unasked question cleared the whole cache.
   */
  it('does not conclude anything from a zero limit', () => {
    const result = reconcileUnread({ answered: [], cached: [row('a', 1)], limit: 0 })
    expect(result.basis).toBe('no-answer')
    expect(result.readNow).toEqual([])
  })

  it('treats an answer shorter than the badge as a prefix, not as the whole truth', () => {
    const result = reconcileUnread({
      answered: [row('a', 500)],
      cached: [row('a', 500), row('newer-stale', 600), row('older', 200)],
      limit: 50,
      providerUnread: 3,
    })
    expect(result.basis).toBe('short-of-badge')
    expect(result.horizon).toBe(500)
    expect(result.readNow).toEqual(['newer-stale'])
  })

  it('takes an answer that matches or exceeds the badge as complete', () => {
    for (const providerUnread of [1, 2]) {
      const result = reconcileUnread({
        answered: [row('a', 300), row('b', 200)],
        cached: [row('a', 300), row('b', 200), row('c', 100)],
        limit: 50,
        providerUnread,
      })
      expect(result.basis).toBe('complete')
      expect(result.readNow).toEqual(['c'])
    }
  })

  it('a capped answer stays capped even when the badge agrees with its length', () => {
    // Both reasons to distrust the answer point the same way, and the more specific label wins.
    const result = reconcileUnread({
      answered: [row('a', 500), row('b', 400)],
      cached: [row('a', 500), row('stale', 450), row('b', 400), row('old', 300)],
      limit: 2,
      providerUnread: 2,
    })
    expect(result.basis).toBe('capped')
    expect(result.readNow).toEqual(['stale'])
  })
})
