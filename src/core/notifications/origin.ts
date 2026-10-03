/**
 * Which Walnut is writing the error card, and how the card says so.
 *
 * notifications.json rides the data sync, so a card the cloud companion writes
 * is read on the Mac (and the other way round). Two things follow, both keyed
 * off the one constant here: the store stamps `origin` on the record and scopes
 * recovery to it (store.ts), and both publish paths append ORIGIN_NOTE to the
 * card's sentence so a reader on the Mac is not told a Mac plugin is broken when
 * the companion is the one that could not load it (2026-10-03).
 *
 * A leaf on purpose: the log-error bridge imports it, and that bridge must stay
 * import-light (see the closure note in log-error-bridge.ts).
 */

import { CLOUD_MODE } from '../../constants.js';

/** Which Walnut wrote an error card. Absent = the primary (the Mac). */
export type NotificationOrigin = 'replica';

/** The `origin` this process stamps on the error cards it writes. */
export const WRITER_ORIGIN: NotificationOrigin | undefined = CLOUD_MODE ? 'replica' : undefined;

/** The sentence a card written here carries so a reader elsewhere knows where it happened. */
export const ORIGIN_NOTE = WRITER_ORIGIN === 'replica' ? 'This happened on the cloud companion.' : '';

/** `message` with ORIGIN_NOTE appended on a replica; unchanged on the primary. */
export function withOriginNote(message: string): string {
  if (!ORIGIN_NOTE) return message;
  const trimmed = message.trim();
  return trimmed ? `${trimmed} ${ORIGIN_NOTE}` : ORIGIN_NOTE;
}
