/**
 * The cards a Walnut writes about itself, handed to whoever carries them to the
 * Mac (stage 4d of docs/plan/walnut-companion-unified-replica.md).
 *
 * The cloud companion keeps its own cards in a file of its own (store.ts), and
 * git sync no longer carries that file. So every write the box's producers make
 * (a new card, a fold, a replace, a settled stamp, a removal) is reported here,
 * and the companion's sink (companion-cards.ts) sends it to the Mac over the
 * `server.notifications.cards` relay. The store reports on the companion only, so
 * on the Mac nothing reaches this module.
 *
 * A leaf on purpose, like origin.ts: store.ts imports it, and the store must
 * stay import-light (see the closure note in log-error-bridge.ts).
 */

import type { NotificationRecord } from './store.js';

/**
 * What happened to one card, as the Mac applies it (apply-companion-cards.ts):
 *
 *   add      first write wins: the Mac keeps a card it already has under the key
 *   upsert   one more occurrence: folded into the Mac's card when it is newer
 *   replace  the card replaces whatever the Mac has under the key (a reminder re-fired)
 *   state    the card settled (resolved, expired, recovered): stamped on the Mac's
 *            card when it still has one, never brought back when it does not
 *   remove   the box removed it; the Mac removes its copy of the box's card
 */
export type OwnCardMode = 'add' | 'upsert' | 'replace' | 'state' | 'remove';

export interface OwnCardChange {
  mode: OwnCardMode;
  /** The card's dedupKey, its identity on both boxes. */
  key: string;
  /** The card as it now stands; for a removal, the card the box removed. */
  record: NotificationRecord;
}

let sink: ((changes: OwnCardChange[]) => void) | null = null;
/**
 * Changes reported before the sink is in place (a card written early in boot, before
 * server.ts starts companion-cards.ts), handed to it when it arrives. Bounded: past
 * it the oldest go, as the outbox's own bound does.
 */
const early: OwnCardChange[] = [];
const MAX_EARLY = 500;

/** The companion's sink (companion-cards.ts); null removes it. */
export function setOwnCardSink(fn: ((changes: OwnCardChange[]) => void) | null): void {
  sink = fn;
  if (fn && early.length) deliver(early.splice(0));
}

function deliver(changes: OwnCardChange[]): void {
  try { sink?.(changes); } catch { /* the card stays in the box's store; the next change carries it */ }
}

/**
 * Report changes the store just wrote (the store calls this on the companion only).
 * Letters never go: a letter envelope mirrors the Mac's own inbox. Never throws: a
 * sink that fails never fails the write.
 */
export function reportOwnCards(changes: OwnCardChange[]): void {
  const out = changes.filter((c) => c.key && c.record.kind !== 'letter');
  if (out.length === 0) return;
  if (sink) { deliver(out); return; }
  early.push(...out);
  if (early.length > MAX_EARLY) early.splice(0, early.length - MAX_EARLY);
}

/** Tests only. */
export function _resetOwnCardsForTesting(): void {
  sink = null;
  early.length = 0;
}
