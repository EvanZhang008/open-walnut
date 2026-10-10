/**
 * Per-message text clipping for the slim transcript tail the phone reads.
 *
 * The tail exists to be SMALL: ~200 rows fetched over cellular, so a single
 * message has never been allowed to carry a whole research answer. Two things
 * changed with rich output mode, where a reply may be raw HTML the phone renders
 * as real DOM:
 *
 *  1. A blind `slice(0, 4000)` cuts wherever the 4000th character happens to
 *     fall — routinely mid-attribute (`…padding:8`) or inside a `<style>` body.
 *     Half a tag renders as an empty box and the rest of the attribute renders as
 *     visible prose; a cut `<style>` body renders CSS source as paragraph text.
 *     That is the same defect `splitPendingMarkup` was written for, so the cut is
 *     now made SAFE by dropping whatever construct the cut left unfinished.
 *  2. A card costs more characters than the same answer in prose (a `<style>`
 *     block plus markup plus an SVG runs a few KB), so HTML-bearing text gets a
 *     larger budget. Deliberately a separate constant rather than a raised
 *     TEXT_MAX: ordinary prose gains nothing from a bigger cap, and the payload
 *     ceiling for a tail of plain messages must not move.
 *
 * An element left open by the cut (`<div>…` with no `</div>`) is fine and stays:
 * every HTML parser closes open elements at end of document, so the visible part
 * still renders as the card it was. Only constructs that render as GARBAGE are
 * dropped.
 *
 * TWO budgets, by who reads the rows (2026-10-10). The 4K one was sized for the
 * TAIL that is swept to disk and pushed to the cloud companion under a frame cap.
 * The phone's LIVE reads (every read the primary builds for it, the companion's
 * bridge read, a host server answering alone) are never pushed, and they were
 * clipped by the same 4K anyway: a reply that streamed in whole snapped back to its first 4,000
 * characters plus "…" the moment the turn ended, with no way on the phone to read
 * the rest. A 5,000-character Chinese answer is an ordinary reply, so this was the
 * phone's normal behaviour for long answers. A live read clips at the phone's own
 * row bound instead (iOS `MarkdownParser.oversizedRowClipLimit` for prose, the live
 * render window `LiveMarkdownWindow.windowMax` for markup): text the phone would
 * cut itself is not worth sending, and anything shorter arrives whole. A live page
 * stays bounded by its rows (the ~100-row tail) and, over the bridge, by bytes
 * (`capRelayedPage`), so the larger per-row budget cannot grow it without limit.
 */

import { splitPendingMarkup } from '../stream/pending-markup.js';
import { cutEnd } from '../text-cut.js';

/** Budget for an ordinary prose message (unchanged behaviour). */
export const TRANSCRIPT_TEXT_MAX = 4_000;

/** Budget for a message that carries markup. Sized to hold a real rich answer
 *  (style block + a couple of cards + an inline SVG) rather than a fragment of
 *  one, while staying far below the point where 200 of them stop being a "slim"
 *  tail. */
export const TRANSCRIPT_RICH_TEXT_MAX = 12_000;

/** Prose budget for a LIVE read: the phone's own row clip (iOS
 *  `MarkdownParser.oversizedRowClipLimit`). */
export const TRANSCRIPT_LIVE_TEXT_MAX = 16_000;

/** Markup budget for a LIVE read: the window the phone already renders a
 *  streaming reply in (iOS `LiveMarkdownWindow.windowMax`). */
export const TRANSCRIPT_LIVE_RICH_TEXT_MAX = 48_000;

/** `tail`: the swept and pushed tail (the default). `live`: a read the phone makes
 *  right now, which is never pushed anywhere. */
export type TranscriptClipBudget = 'tail' | 'live';

/**
 * Does this text carry real markup (as opposed to a `<` that only looks like it)?
 *
 * A bare `<name>` is not enough: `Vec<u8>`, `Array<T>` and `if a < b` all match
 * that shape, and prose gains nothing from the larger budget. Real HTML always
 * brings one of three things with it — a closing tag, a start tag with an
 * attribute, or a self-closing `/>` — while none of the prose shapes do. Picking
 * the budget is all this decides, so a rare miss costs a few KB of headroom, not
 * correctness (the cut itself is made safe either way).
 */
function looksLikeMarkup(text: string): boolean {
  if (!text.includes('<')) return false;
  return /<\/[a-zA-Z]/.test(text)
    || /<[a-zA-Z][a-zA-Z0-9:-]*\s[^<>]*>/.test(text)
    || /<[a-zA-Z][a-zA-Z0-9:-]*\s*\/>/.test(text);
}

/**
 * Clip one transcript message to its budget, never leaving a half-written markup
 * construct behind. Returns the text unchanged when it fits.
 */
export function clipTranscriptText(text: string, budget: TranscriptClipBudget = 'tail'): string {
  const proseMax = budget === 'live' ? TRANSCRIPT_LIVE_TEXT_MAX : TRANSCRIPT_TEXT_MAX;
  // Fast path first: the overwhelming majority of rows are short, and this runs
  // for every row of every sweep.
  if (text.length <= proseMax) return text;
  const markupMax = budget === 'live' ? TRANSCRIPT_LIVE_RICH_TEXT_MAX : TRANSCRIPT_RICH_TEXT_MAX;
  const limit = looksLikeMarkup(text) ? markupMax : proseMax;
  if (text.length <= limit) return text;
  // Cut on a code-point boundary (core/text-cut.ts): a cut through an emoji leaves a
  // lone surrogate, and one row of the tail carrying one makes a strict client reject
  // the entire response. `splitPendingMarkup` only ever cuts at a `<`, so the safe
  // half it hands back stays boundary-safe too.
  const cut = text.slice(0, cutEnd(text, limit));
  const { safe } = splitPendingMarkup(cut);
  // `safe` is empty only when the whole cut is one unfinished construct (a
  // `<style>` body longer than the budget). Showing the raw cut would print CSS
  // as prose, so prefer the ellipsis alone — the row is a stub either way, and
  // the full text is one tap away in the console.
  return (safe.length > 0 ? safe : '') + '…';
}
