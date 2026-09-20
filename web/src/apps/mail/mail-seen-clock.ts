/**
 * When the SERVER started counting a read flip this console made.
 *
 * `pendingSeen` exists because a mailbox's unread count lands wholesale and the provider's figure
 * lags, so a landing that predates a flip has to have that flip taken off it (`pendingSeenDeltas`).
 * The bug that made this file necessary is the other half of that: once `POST /messages/:a/:m/read`
 * has answered, the server's own count already includes the flip, so every later landing was having
 * it subtracted a SECOND time and the sidebar badge read one unread low until a page read happened to
 * confirm the row (measured: flip, refresh, badge 1 where the truth was 2; a second refresh healed it).
 *
 * A COUNTER rather than a timestamp: the question is only ever "was this flip counted before that
 * request went out", two clocks are not needed for it, and `Date.now()` can tie inside one tick.
 *
 * The overlay itself is deliberately NOT retired on the answer (see `setMailMessageRead`): it still
 * keeps a read row on an unread page and it is still what a rollback finds. This only decides whether
 * a server number has already had the flip applied to it.
 */
import { onMailStoreReset } from './mail-store';

let clock = 0;
const counted = new Map<string, number>();

/** The reading a request should carry: taken BEFORE it is sent, compared when its answer lands. */
export function mailCountsClock(): number {
  return clock;
}

/** The server has answered this flip, so every request issued from now on includes it. */
export function noteFlipCounted(pair: string): void {
  clock += 1;
  counted.set(pair, clock);
}

/** A rolled-back or forgotten flip is not a counted one. */
export function forgetFlipCounted(pair: string): void {
  counted.delete(pair);
}

/**
 * Was this flip already counted when a request taken at `since` went out?
 *
 * `<=` because the reading is taken before the request is sent: a flip counted at exactly that value
 * was counted first.
 */
export function flipCountedBy(pair: string, since: number): boolean {
  const at = counted.get(pair);
  return at !== undefined && at <= since;
}

// Module state the snapshot does not hold, so a reset has to clear it (same rule as `wantedSeen`).
onMailStoreReset(() => { counted.clear(); clock = 0; });
