/**
 * Walnut's own notices that ride IN FRONT OF a message — pure, render-agnostic.
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
 * A rider is recognized by a CLOSED list, the four notes Walnut has ever put in
 * front of a message: a `notification` from Walnut whose outcome is `moved`,
 * `org-update` or `task-routing-policy` (changed default instructions; the name
 * is from when they were only the routing rules), or an `app-state`. It is a display
 * grouping, not an authorization: a person who pastes one gets a card, exactly
 * as with every other envelope (see history-session-envelope.ts).
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
const RIDER_OUTCOMES = new Set(['moved', 'org-update', 'task-routing-policy']);
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
