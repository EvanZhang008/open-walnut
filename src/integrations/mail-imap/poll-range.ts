/**
 * Which slice of a mailbox the next poll asks for, and where that leaves the cursor.
 *
 * This file exists because of one bug with a long tail. The poll used to fetch `1:*` on a cold
 * container and `${lastUid + 1}:*` on every page after it: ranges with no upper bound, which ask
 * the server to stream the WHOLE remaining mailbox. Taking `limit` messages and breaking out of
 * the loop does not stop that, because IMAP has no cancel and imapflow's generator only drains
 * what is already in flight (`lib/imap-flow.js`: the FETCH promise settles when the server
 * finishes, not when the consumer stops reading; its own docs warn against `1:*`). On a
 * 37,832-message INBOX the first poll therefore spent minutes inside a 12s budget, the account's
 * tick threw, its backoff doubled to half an hour, and the other 66 mailboxes never got a turn:
 * an account whose credentials were perfect showed an empty mailbox forever, with nothing in the
 * UI to say why. A deadline can only stop WAITING. It cannot make the request smaller.
 *
 * So: every range this planner emits is bounded at BOTH ends, and the cost of a page is the size
 * of the page rather than the size of the mailbox. Three consequences worth keeping:
 *
 * - A COLD container starts at the newest page, addressed by SEQUENCE number (`exists` is what
 *   SELECT just reported), because that is the only bound available before any UID is known. It
 *   is also the only order a human would call correct: `1:*` handed back the OLDEST messages in
 *   the box, so a fresh Gmail account's first page was mail from a decade ago.
 * - A QUIET container costs ZERO fetches. UIDNEXT says whether anything new exists, so there is
 *   nothing left to filter: the old code had to discard the newest message on every poll, forever,
 *   because `n:*` answers with it even when nothing is at or above `n`.
 * - The cursor carries a FLOOR as well as a ceiling, so history is filled in by walking the floor
 *   down one bounded page at a time, and it stops at the base's retention horizon rather than at
 *   UID 1: mail older than the cache keeps would be fetched only for the retention sweep to
 *   delete it again.
 */

/** How much a page may cost: `limit` messages up, `limit` UIDs down. */
export interface PollCursorState {
  /** Highest UID covered. 0 = nothing covered yet. */
  lastUid: number
  /**
   * Lowest UID still WANTED below what is covered. 0 means nothing below is wanted, either
   * because the floor reached the bottom of the mailbox or because it crossed the horizon.
   */
  floorUid: number
}

export type PollPlan =
  /** The newest `limit` messages by sequence number, for a container with no usable cursor. */
  | { mode: 'newest'; range: string; byUid: false; from: number }
  /** Everything new above the ceiling, capped so one influx cannot become an unbounded fetch. */
  | { mode: 'newer'; range: string; byUid: true; ceiling: number }
  /** One page of history below the floor. */
  | { mode: 'older'; range: string; byUid: true; floor: number }
  /** Nothing to ask for: an empty mailbox, or a caught-up one with no history left to want. */
  | { mode: 'idle' }

export interface PollShape {
  held?: PollCursorState
  limit: number
  /** Message count from SELECT. */
  exists: number
  /** UIDNEXT from SELECT. 0 when the server did not report one. */
  uidNext: number
}

/** The highest UID that can exist in the mailbox, or 0 when UIDNEXT was not reported. */
function ceilingOf(uidNext: number): number {
  return uidNext > 0 ? uidNext - 1 : 0
}

export function planPoll({ held, limit, exists, uidNext }: PollShape): PollPlan {
  const page = Math.max(1, Math.floor(limit))
  const top = ceilingOf(uidNext)
  // FAR BEHIND is the same answer as cold, and telling them apart is not worth trying.
  //
  // A ceiling thousands of UIDs under the mailbox's top can mean a long outage, a container whose
  // cursor was written by an older build, or a mailbox that just grew by a lot. Climbing from the
  // ceiling treats all of them as "catch up in UID order", which is oldest-first: the real Gmail
  // INBOX this was found on climbed 1,000 UIDs a tick from 2012 forward while the retention sweep
  // deleted every row it fetched, so the human's actual recent mail stayed invisible for an hour
  // of steady work. The newest page is what somebody is waiting for, and the floor walk then fills
  // the gap downward and stops at the horizon, so nothing is skipped and nothing old is refetched.
  // Deliberately NOT gated on the mailbox being bigger than a page: a container holding four
  // messages under a UIDNEXT of 40,000 (an inbox somebody archives from) is the worst case for
  // climbing, since every page is empty, and the best case for the newest page, which is `1:4`.
  const farBehind = !!held && top > 0 && top - held.lastUid > page
  if (!held || farBehind) {
    if (exists <= 0) return { mode: 'idle' }
    const from = Math.max(1, exists - page + 1)
    return { mode: 'newest', range: `${from}:${exists}`, byUid: false, from }
  }
  // New mail FIRST: fresh arrivals are what a human is waiting for, and history can wait a tick.
  // A server that reports no UIDNEXT gets a bounded probe instead of a guess, which is the same
  // cost as any other page.
  const capped = held.lastUid + page
  const ceiling = top > 0 ? Math.min(top, capped) : capped
  if (ceiling > held.lastUid && (top === 0 || top > held.lastUid)) {
    return { mode: 'newer', range: `${held.lastUid + 1}:${ceiling}`, byUid: true, ceiling }
  }
  if (held.floorUid > 1) {
    const floor = Math.max(1, held.floorUid - page)
    return { mode: 'older', range: `${floor}:${held.floorUid - 1}`, byUid: true, floor }
  }
  return { mode: 'idle' }
}

export interface PageFacts {
  /** Lowest UID the page carried. 0 when it carried none. */
  lowest: number
  /** Highest UID the page carried. 0 when it carried none. */
  highest: number
  /** The page's oldest message arrival time in ms. 0 when unknown or the page was empty. */
  oldestAt: number
}

/**
 * Where the page leaves the cursor.
 *
 * The floor advances by what the REQUEST covered, never by what came back. A UID range that
 * answers with nothing has still been checked, and treating an empty page as "no progress" is how
 * a mailbox with deleted messages backfills the same gap forever.
 */
export function advanceCursor(input: {
  plan: PollPlan
  held?: PollCursorState
  page: PageFacts
  /** Nothing older than this instant is kept by the cache. 0 = no horizon known. */
  since: number
}): PollCursorState {
  const { plan, held, page, since } = input
  const past = since > 0 && page.oldestAt > 0 && page.oldestAt < since
  const lastUid = held?.lastUid ?? 0
  const floorUid = held?.floorUid ?? 0
  switch (plan.mode) {
    case 'newest': {
      // `from === 1` means the page covered the whole mailbox, so there is no history below it
      // whatever the UIDs happen to be. Without this line a box of 51 messages numbered 900-950
      // would spend eighteen pages walking a floor of 900 down to 1 through UIDs that never existed.
      const bottom = plan.from === 1 || past ? 0 : page.lowest
      return { lastUid: Math.max(lastUid, page.highest), floorUid: bottom > 1 ? bottom : 0 }
    }
    case 'newer':
      return { lastUid: Math.max(lastUid, plan.ceiling, page.highest), floorUid }
    case 'older': {
      const bottom = past ? 0 : plan.floor
      return { lastUid: Math.max(lastUid, page.highest), floorUid: bottom > 1 ? bottom : 0 }
    }
    default:
      return { lastUid, floorUid }
  }
}

/**
 * Is there anything left for the base to ask about?
 *
 * Answered from the CURSOR, not from how full the page was. A bounded history page on a mailbox
 * with gaps can come back with two messages and still have thousands behind it, and the old
 * `messages.length >= limit` test read that as "done".
 */
export function hasMore(next: PollCursorState, uidNext: number, pageFilled: boolean): boolean {
  const top = ceilingOf(uidNext)
  const newerLeft = top > 0 ? top > next.lastUid : pageFilled
  return newerLeft || next.floorUid > 0
}
