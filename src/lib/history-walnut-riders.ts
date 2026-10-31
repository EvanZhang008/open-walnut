/**
 * Walnut's own notices that ride IN FRONT OF a message: pure, render-agnostic.
 *
 * When Walnut has something the session should know in passing (its task moved,
 * the org changed, its default instructions changed, an App's state), it does not spend a turn
 * on it: the next message into the session carries the note first, in the same
 * queue row (`${notes}\n\n${body}`, src/core/session-message-queue.ts). The CLI
 * therefore stores ONE user line holding Walnut's notes AND the human's words,
 * and a surface that treats "this row holds an envelope" as "this row is not the
 * human's" drew the person's own words on the AI side, with no bubble.
 *
 * This splits those riders off the front, so the rest of the row goes back to
 * whatever path it takes without them. The stored text is never changed.
 *
 * A rider is recognized by a CLOSED list, the notes Walnut puts in front of a
 * message: a `notification` from Walnut whose outcome is in RIDER_NOTICE_OUTCOMES,
 * or an `app-state`. The list is closed because text after an arbitrary envelope
 * is not the person's (a trigger's own instructions, an older delivery's footer),
 * and it is pinned to the notes session-message-queue.ts actually prepends by
 * tests/web/walnut-riders-producers.test.ts, which also checks the iOS copy: a
 * note added there without its outcome here drew the person's words inside the
 * note's card (2026-10-29, the status push). It is a display grouping, not an
 * authorization: a person who pastes one gets a card, exactly as with every other
 * envelope (see history-session-envelope.ts).
 *
 * The split happens only when it can lose nothing, and returns `null` (render
 * the row exactly as before) otherwise:
 *  · the first rider starts at the first character, and each one is a complete
 *    tag the envelope parser reads as exactly one envelope;
 *  · each rider is followed by exactly one blank line, then the next rider or
 *    the body, which must hold something other than whitespace;
 *  · a tag that is cut off (no close of its own), or one outside the list,
 *    ends the run: before any rider it means no split at all; after one it is
 *    simply the body (a trigger delivery behind a place note stays the envelope
 *    it always was).
 */
import { parseSessionEnvelopes, type SessionEnvelope } from './history-session-envelope.js';

export interface RiderSplit {
  /** The riders, top-down in the order Walnut put them in front. */
  riders: SessionEnvelope[];
  /** Everything after them, verbatim: what the row holds without the riders. */
  body: string;
}

const TAG_HEAD = '<walnut-message ';
const TAG_CLOSE = '\n</walnut-message>';
/**
 * The outcomes of Walnut's notes that ride in front of a message, one per note
 * session-message-queue.ts prepends: place (`moved`), folder move (`folder-moved`),
 * restart (`restarted`), org digest (`org-update`), status push (`status`), wait
 * note (`waiting`), retired lead (`handed-over`), a request past its deadline held
 * for the next message (`timeout`, sessions/held-notices.ts), plus the changed
 * default instructions the queue's drain
 * puts first (`task-routing-policy`). iOS keeps the same list
 * (TimelineInboundMessage.riderOutcomes).
 */
export const RIDER_NOTICE_OUTCOMES: readonly string[] = [
  'moved', 'folder-moved', 'restarted', 'org-update', 'status', 'waiting', 'handed-over', 'timeout', 'task-routing-policy',
];
const RIDER_OUTCOMES = new Set(RIDER_NOTICE_OUTCOMES);
/** `name="value"`, first occurrence wins (same rule as the envelope parser). */
const ATTR = /([a-z][a-z0-9-]*)="([^"]*)"/g;

function headAttrs(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(head); m; m = ATTR.exec(head)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function isRider(attrs: Record<string, string>): boolean {
  if (attrs.kind === 'app-state') return true;
  return attrs.kind === 'notification' && attrs.from === 'Walnut' && RIDER_OUTCOMES.has(attrs.outcome ?? '');
}

/** Split Walnut's leading riders off a stored user message, or `null`. */
export function splitLeadingRiders(text: string): RiderSplit | null {
  if (!text || !text.startsWith(TAG_HEAD)) return null;
  const riders: SessionEnvelope[] = [];
  let pos = 0;
  while (text.startsWith(TAG_HEAD, pos)) {
    const headEnd = text.indexOf('\n', pos);
    if (headEnd < 0) break;
    const head = text.slice(pos, headEnd);
    if (!head.endsWith('>') || !isRider(headAttrs(head))) break;
    const closeAt = text.indexOf(TAG_CLOSE, headEnd);
    if (closeAt < 0) break;
    // The serializer escapes every tag out of a body, so a real rider's body
    // never holds one. A tag inside means this one never closed and the close
    // found belongs to a later envelope: stop rather than fold the text between.
    if (text.slice(headEnd, closeAt).includes('\n<walnut-message')) break;
    const end = closeAt + TAG_CLOSE.length;
    const segments = parseSessionEnvelopes(text.slice(pos, end));
    if (!segments || segments.length !== 1 || segments[0].kind !== 'envelope') break;
    if (!text.startsWith('\n\n', end)) break;
    riders.push(segments[0].envelope);
    pos = end + 2;
  }
  if (riders.length === 0) return null;
  const body = text.slice(pos);
  if (!body.trim()) return null;
  return { riders, body };
}

/** The row without its leading riders; the text itself when it has none. */
export function withoutLeadingRiders(text: string): string {
  return splitLeadingRiders(text)?.body ?? text;
}
