/**
 * Error cards the user dismissed while their cause was still there.
 *
 * Dismissing a card used to delete the record and nothing else, so the same
 * standing cause raised a brand new card on its next occurrence (every 60 s for
 * a polled failure, after every restart for a reconcile one) and the user's
 * "I've seen this" lasted a minute. The store now keeps a small tombstone per
 * dismissed, still failing card: a repeat of that card is absorbed silently,
 * and the condition's own recovery signal ends the tombstone, so the NEXT
 * failure after a real success is news again.
 *
 * Bounded: a tombstone nothing recovers (no key, or a key whose tracker never
 * fires) lapses after a hold, the same window the keyless sweep gives a card,
 * so a real problem days later is never hidden for good.
 */
import { conditionKeysOf } from './route-condition.js';

export interface DismissedCondition {
  dedupKey: string;
  /** The keys whose recovery ends this dismissal: recoveryKey, condition keys, causeKey. */
  keys: string[];
  /** When the user dismissed it (epoch ms). */
  at: number;
}

/** A tombstone with a recovery key: its condition's success ends it, or this hold. */
export const DISMISS_HOLD_KEYED_MS = 7 * 24 * 60 * 60 * 1000;
/** A tombstone with no key can only lapse: as long as a keyless card lives. */
export const DISMISS_HOLD_KEYLESS_MS = 48 * 60 * 60 * 1000;

export function dismissalOf(rec: {
  dedupKey: string;
  recoveryKey?: string;
  causeKey?: string;
}, now: number): DismissedCondition {
  const keys = new Set(conditionKeysOf(rec));
  if (rec.causeKey) keys.add(rec.causeKey);
  return { dedupKey: rec.dedupKey, keys: [...keys], at: now };
}

/** The tombstones still in force; the lapsed ones are dropped. */
export function liveDismissals(list: DismissedCondition[] | undefined, now: number): DismissedCondition[] {
  if (!Array.isArray(list)) return [];
  return list.filter((d) => {
    if (!d || typeof d.dedupKey !== 'string' || typeof d.at !== 'number') return false;
    const hold = Array.isArray(d.keys) && d.keys.length > 0 ? DISMISS_HOLD_KEYED_MS : DISMISS_HOLD_KEYLESS_MS;
    return now - d.at < hold;
  });
}

/**
 * Drop the tombstones a recovery of `keys` ends. Returns the survivors. A
 * recovery observed before the dismissal (`asOf`, a late-applied signal) does
 * not end it: the user dismissed a failure that was still there after it.
 */
export function endDismissals(
  list: DismissedCondition[],
  keys: ReadonlySet<string>,
  asOf?: number,
): DismissedCondition[] {
  return list.filter((d) => !(d.keys.some((k) => keys.has(k)) && (asOf === undefined || d.at <= asOf)));
}

/** Every key a live tombstone waits on: the boot seeding arms their trackers too. */
export function dismissalKeys(list: DismissedCondition[] | undefined, now: number): string[] {
  return [...new Set(liveDismissals(list, now).flatMap((d) => d.keys))];
}
