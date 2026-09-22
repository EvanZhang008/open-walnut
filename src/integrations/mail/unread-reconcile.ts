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
  /**
   * How many envelopes the provider actually handed back, BEFORE the caller dropped the ones belonging
   * to another mailbox. The cap has to be judged on this rather than on `answered.length`, or one
   * foreign envelope in a full page turns "this is page one of many" into "this is everything".
   * Defaults to `answered.length` when the caller filtered nothing.
   */
  returned?: number
  /**
   * The folder's OWN unread count, as the provider reports it on every poll. The second opinion without
   * which NOTHING is ever treated as complete: see the header. Absent when the caller has no folder row
   * to read it from, and then the answer is only ever a prefix.
   */
  providerUnread?: number
  /**
   * When the provider was asked, as a message timestamp. A row that arrived AFTER this instant was not
   * in the snapshot being judged, so its absence from the answer proves nothing about it. Without this
   * the 8 second provider call is a window in which a newly delivered mail is marked read by an answer
   * that predates it. Absent means "judge everything", which is only safe in a test.
   */
  snapshotAt?: number
}

export interface UnreadReconcileResult {
  /** Cached rows to mark read: the provider knows this mailbox and does not count them. */
  readNow: string[]
  /**
   * Why the sweep stopped where it did, for the log line.
   *  - `complete`: the folder's badge agrees with the answer's length, so every absence counts.
   *  - `capped`: the answer filled the limit it was given, so only the range above its oldest entry can
   *    be judged.
   *  - `short-of-badge`: the answer named fewer than the folder itself counts, so it is a prefix too.
   *  - `no-badge`: there was no folder count to check the answer against, so it is treated as a prefix.
   *  - `no-answer`: the answer named nothing and the badge does not agree that the folder is clear, so
   *    nothing at all is concluded.
   */
  basis: 'complete' | 'capped' | 'short-of-badge' | 'no-badge' | 'no-answer'
  /** For every prefix basis, the instant below which absence proves nothing. Absent with `complete`. */
  horizon?: number
}

/**
 * Which cached unread rows the provider's answer proves are read.
 *
 * The provider contract (`MailProviderSpec.listUnread` in types.ts) is deliberately weak, and every rule
 * here exists because of one of its sentences:
 *
 *  - "an empty array means nothing to add, NEVER nothing is unread". A provider is allowed to answer `[]`
 *    for a folder it cannot filter, and a real one does: the Outlook provider answers the unread question
 *    for the Inbox only. Reading that as "this folder is clear" marks a whole folder read on the strength
 *    of a provider declining to answer, and a mail wrongly marked read is HIDDEN, which is worse than the
 *    staleness this file exists to fix.
 *  - "`limit` is a page size; a provider may answer fewer". So a short answer does not prove completeness
 *    either, and the answer's own length can never establish it.
 *
 * What CAN establish it is a second opinion, and the folder's own badge is one that costs nothing because
 * every poll refreshes it. So: an answer is COMPLETE only when the badge agrees with its length, and every
 * other answer is a PREFIX, judged only above its oldest entry (a newest-first page still covers everything
 * above its own tail). With no badge to check against, nothing is ever complete. The tie at the horizon is
 * left alone: two messages can share a delivery second, and one of them being the answer's last entry says
 * nothing about the other.
 *
 * A stale badge costs one round of partial correction and the next poll finishes the job, which is the
 * right way round for a rule that writes read flags.
 *
 * One more bound, and it is about time rather than about the answer: a mail delivered WHILE the provider
 * was being asked is not in the snapshot being judged, so its absence means nothing. `snapshotAt` keeps
 * the sweep off it. Without that, opening an unread list was an 8 second window in which an arriving mail
 * could be marked read by an answer older than the mail.
 */
export function reconcileUnread(input: UnreadReconcileInput): UnreadReconcileResult {
  const { answered, cached, limit, providerUnread } = input
  const returned = input.returned ?? answered.length
  const snapshotAt = input.snapshotAt ?? Number.POSITIVE_INFINITY
  // Rows the answer could have covered at all. A row newer than the snapshot is not one of them.
  const judgeable = cached.filter((row) => row.sentAt <= snapshotAt)
  // Nothing cached is nothing to reconcile. The basis is the one that claims least, because the caller
  // logs it and "complete" over an empty sweep reads as a conclusion nobody drew.
  if (cached.length === 0) return { readNow: [], basis: 'no-answer' }
  if (answered.length === 0) {
    // The one absence that is allowed to mean something on its own: the folder itself says it is clear.
    if (providerUnread !== 0) return { readNow: [], basis: 'no-answer' }
    return { readNow: judgeable.map((row) => row.messageId), basis: 'complete' }
  }
  const unread = new Set(answered.map((one) => one.messageId))
  const capped = limit > 0 && returned >= limit
  const complete = !capped && typeof providerUnread === 'number' && answered.length >= providerUnread
  if (complete) {
    return { readNow: judgeable.filter((row) => !unread.has(row.messageId)).map((row) => row.messageId), basis: 'complete' }
  }
  // The oldest entry of the answer, which is where its knowledge stops.
  const horizon = answered.reduce((oldest, one) => Math.min(oldest, one.sentAt), Number.POSITIVE_INFINITY)
  return {
    readNow: judgeable.filter((row) => row.sentAt > horizon && !unread.has(row.messageId)).map((row) => row.messageId),
    basis: capped ? 'capped' : (providerUnread === undefined ? 'no-badge' : 'short-of-badge'),
    horizon,
  }
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
