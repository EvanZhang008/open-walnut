/**
 * Where an outline row sits: the transcript position of the message it marks.
 *
 * The outline is a table of contents of the conversation, so it reads in the
 * conversation's own order, never in pin order. The one hard case is a pin whose
 * message is NOT in the loaded rows: the panel holds a TAIL window (the newest
 * HISTORY_TAIL_LIMIT rows), so a message that is not in it is almost always OLDER
 * than everything that is. It used to sort LAST, which put a two-day-old pin under a
 * pin made an hour ago (reported 2026-09-18: "this is not even sorted by position,
 * the activator one is really the later one"). It now slots in by its message's
 * timestamp, between the loaded rows that stamp before and after it, which for a
 * tail window means the top. Only a pin with no timestamp at all still sorts last.
 *
 * Pure so the rule is unit-testable without a panel.
 */
import type { SessionPinnedMessage } from '@/types/session';

export interface OutlineRowLike {
  msgId?: string;
  walnutMessageId?: string;
  timestamp?: string;
}

/** Slot of a message that is not loaded: half a step BEFORE the first loaded row
 *  stamped after it (rows without a stamp never stop the scan), so it interleaves
 *  with integer positions of loaded rows. No timestamp → last. */
export function unloadedSlot(loadedStamps: readonly number[], timestamp: string | undefined): number {
  const t = Date.parse(timestamp ?? '');
  if (Number.isNaN(t)) return Number.MAX_SAFE_INTEGER;
  let k = 0;
  // `!(stamp > t)` rather than `stamp <= t`: a NaN stamp (row without a time) must
  // be skipped, not treated as a boundary.
  while (k < loadedStamps.length && !(loadedStamps[k] > t)) k++;
  return k - 0.5;
}

export interface PlacedPin<P extends SessionPinnedMessage = SessionPinnedMessage> {
  pin: P;
  /** Transcript position: an integer index for a loaded message, a half step for an
   *  unloaded one placed by time, MAX_SAFE_INTEGER for one that cannot be placed. */
  at: number;
  loaded: boolean;
}

/** Every pin with its slot, sorted the way the outline reads. */
export function placePins<P extends SessionPinnedMessage>(
  pins: readonly P[],
  messages: readonly OutlineRowLike[],
): PlacedPin<P>[] {
  const indexOf = new Map<string, number>();
  const stamps: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i].msgId ?? messages[i].walnutMessageId;
    // First occurrence wins, the same rule every other id map in the panel uses.
    if (id && !indexOf.has(id)) indexOf.set(id, i);
    stamps.push(Date.parse(messages[i].timestamp ?? ''));
  }
  return pins
    .map((pin) => {
      const index = indexOf.get(pin.msgId);
      return index === undefined
        ? { pin, at: unloadedSlot(stamps, pin.timestamp), loaded: false }
        : { pin, at: index, loaded: true };
    })
    .sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      // Two unloaded pins in the same gap: their messages' own order is their
      // timestamps' order.
      if (!a.loaded) {
        const ta = Date.parse(a.pin.timestamp ?? '');
        const tb = Date.parse(b.pin.timestamp ?? '');
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
      }
      // Within ONE message: the whole-message pin heads the group, then its
      // passages in the order they were pinned. (Passage order inside the message
      // body would be truer, but it is only knowable while the row is rendered, and
      // the outline must read the same either way.)
      const aQuote = a.pin.quote ? 1 : 0;
      const bQuote = b.pin.quote ? 1 : 0;
      if (aQuote !== bQuote) return aQuote - bQuote;
      return a.pin.pinnedAt.localeCompare(b.pin.pinnedAt);
    });
}

/** The outline row's time: the clock for today's rows, the date as well for any
 *  other day. A bare "3:08 PM" on a row from two days ago read as this afternoon,
 *  which is what made the mis-ordering above look impossible. */
export function outlineTimeLabel(timestamp: string | undefined, now: Date = new Date()): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
