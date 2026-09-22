/**
 * What a provider's unread list says about the messages it did NOT mention.
 *
 * The unread refresh used to be ingest-only, and that half is the easy half: a message the provider
 * reports as unread is upserted, flags and all. The hard half is the one a human notices. Read a mail
 * on the phone and it simply LEAVES the provider's unread answer, and an absence writes nothing, so
 * the cached row stays unread for ever. Nothing else corrects it either: a provider whose poll is a
 * newest-first walk with a watermark (the Outlook one) never re-lists a conversation that is already
 * below the line, so the only listing that could ever carry the new flag is this one. Measured on a
 * real account on 2026-09-21: the folder badge said 4 unread, the cache held 12 rows, and eight of
 * them had been read elsewhere hours earlier. IMAP does not have the illness, because its poll
 * re-fetches flags for the whole cached range, which is exactly the "re-read what you hold" this
 * file adds for the providers that cannot.
 *
 * So an absence has to mean something. It can only mean something when the answer is COMPLETE, and
 * these functions are about being honest regarding when that is.
 */

/** One cached row, as little of it as the decision needs. */
export interface CachedUnreadRow {
  messageId: string
  /** The row's sort key, which is also what bounds a capped answer. */
  sentAt: number
}

/** One envelope out of the provider's unread answer, as little of it as the decision needs. */
export interface AnsweredUnread {
  messageId: string
  sentAt: number
}

export interface UnreadReconcileInput {
  /** What the provider said is unread, in the mailbox that was asked about. */
  answered: readonly AnsweredUnread[]
  /** What the cache holds as unread in that same mailbox. */
  cached: readonly CachedUnreadRow[]
  /** The limit the answer was asked for. An answer that reached it may be a prefix of the truth. */
  limit: number
}

export interface UnreadReconcileResult {
  /** Cached rows to mark read: the provider knows this mailbox and does not count them. */
  readNow: string[]
  /**
   * Why the sweep stopped where it did, for the log line. `complete` = the answer named every unread
   * message, so every absence counts. `capped` = the answer filled its limit, so only the range above
   * its oldest entry can be judged. `no-answer` = nothing came back and nothing is concluded.
   */
  basis: 'complete' | 'capped' | 'no-answer'
  /** With `capped`, the instant below which absence proves nothing. Absent otherwise. */
  horizon?: number
}

/**
 * Which cached unread rows the provider's answer proves are read.
 *
 * Two cases, and the difference is the whole point:
 *
 * A COMPLETE answer (fewer entries than the limit asked for) names every unread message there is, so
 * any cached unread row it skipped is read. This is the ordinary case: a real inbox has single digits
 * of unread and the limit is a page.
 *
 * A CAPPED answer (exactly the limit) may be a prefix, so absence below its oldest entry means only
 * "not in the first page". Rows at or older than that instant are left alone; rows newer than it are
 * judged, because a newest-first answer that reached its limit still covered everything above its own
 * tail. The tie at the horizon itself is left alone: two messages can share a delivery second, and one
 * of them being the answer's last entry says nothing about the other.
 *
 * An EMPTY answer is treated as complete only when the limit allowed for more, which it always does
 * (a limit of zero is not a question). That is deliberate and it is the case that matters most: zero
 * unread is the state an inbox somebody just cleared on their phone is actually in.
 */
export function reconcileUnread(input: UnreadReconcileInput): UnreadReconcileResult {
  const { answered, cached, limit } = input
  if (cached.length === 0) return { readNow: [], basis: answered.length >= limit ? 'capped' : 'complete' }
  const unread = new Set(answered.map((one) => one.messageId))
  const capped = limit > 0 && answered.length >= limit
  if (capped) {
    // The oldest entry of the answer, which is where its knowledge stops.
    const horizon = answered.reduce((oldest, one) => Math.min(oldest, one.sentAt), Number.POSITIVE_INFINITY)
    return {
      readNow: cached.filter((row) => row.sentAt > horizon && !unread.has(row.messageId)).map((row) => row.messageId),
      basis: 'capped',
      horizon,
    }
  }
  return { readNow: cached.filter((row) => !unread.has(row.messageId)).map((row) => row.messageId), basis: 'complete' }
}

/** One (account, mailbox) of a smart list, with the two counts that decide whether to ask the provider. */
export interface UnreadRefreshCandidate {
  accountId: string
  mailboxId: string
  /** What the folder itself reports, refreshed by every poll. */
  providerUnread: number
  /** How many rows the cache holds as unread in that folder. */
  cachedUnread: number
}

/**
 * Which folders of a smart list are worth a provider call, newest disagreement first.
 *
 * A scope page ("All Inboxes") is the view a human actually keeps open, and it used to skip the
 * unread refresh entirely so that one query could not become N provider round trips. The objection is
 * right about the cost and wrong about the conclusion, because the folder badge already carries the
 * provider's own count on every poll: when it agrees with the cache there is nothing to correct, and
 * the call can be skipped on evidence rather than on principle. So an agreeing account costs nothing,
 * and only a disagreement buys a round trip.
 *
 * Bounded anyway (`max`), because "every account disagrees" is exactly the state a first run after
 * this code ships is in, and a page a human is waiting on is not the place to fix all of them at once.
 * The remainder is corrected by the next page, or by opening that account's own folder.
 */
export function foldersNeedingUnreadRefresh(
  candidates: readonly UnreadRefreshCandidate[],
  max = 2,
): UnreadRefreshCandidate[] {
  return candidates
    .filter((one) => one.cachedUnread !== one.providerUnread)
    // Biggest disagreement first: it is both the most wrong list and the one a human is most likely
    // to be looking at, and with `max` smaller than the candidate list something has to be chosen.
    .sort((a, b) => Math.abs(b.cachedUnread - b.providerUnread) - Math.abs(a.cachedUnread - a.providerUnread))
    .slice(0, Math.max(0, max))
}
