/**
 * The fullscreen review sidebar (2026-10-27, the user: "when in full screen it
 * default become the word like have a side bar on right like review show the
 * comments there"). Pure parts: when it shows, how its cards stack beside
 * their passages, and the short text a card shows.
 */

/** The narrowest history box that keeps the text readable beside the cards:
 *  a 300px column plus its gaps leaves at least ~520px of text (beside the
 *  question map's panel too). A split's chat column is usually narrower. */
export const REVIEW_MIN_BOX = 880;
/** The card column's default width; the reader drags it (clampReviewWidth). */
export const REVIEW_CARD_W = 300;
/** Between two cards. */
export const REVIEW_GAP = 8;
/** The least room a card's conversation keeps when the cards are crowded
 *  (a couple of lines, scrolling inside); below it a card shows its head alone. */
export const REVIEW_BODY_MIN = 48;
/** The conversation the card being typed in keeps at least (when it has that
 *  much): the last answer or two, not one clipped line. */
export const REVIEW_TYPING_BODY = 160;
/** A card's conversation at most (with 55vh, the `.thread-review-body` cap in thread-review.css). */
export const REVIEW_BODY_MAX = 420;

/** The card column's width as the reader drags its bar (2026-11-10, the user:
 *  the line between the text and the cards "can be drag"): at least this... */
export const REVIEW_W_MIN = 240;
/** ...and never so wide that the conversation keeps less than this. */
export const REVIEW_TEXT_MIN = 520;
/** One arrow key press on the bar. */
export const REVIEW_W_STEP = 16;
/** A press that moves this far is a drag, not a click (the click folds). */
export const REVIEW_DRAG_SLOP = 4;

/** The narrowest history box the sidebar shows in for a chosen column width:
 *  a narrower pick lowers it; a wider one does not raise it (the column is
 *  clamped to what fits, see fitReviewWidth). */
export function reviewMinBox(cardWidth: number = REVIEW_CARD_W): number {
  return REVIEW_MIN_BOX - REVIEW_CARD_W + Math.max(REVIEW_W_MIN, Math.min(cardWidth, REVIEW_CARD_W));
}

/** Whether the sidebar can show at all (it is then measured, cards or not). */
export function reviewSidebarOn(a: { fullscreen: boolean; boxWidth: number; conversationMode: boolean; hasQuestions: boolean; cardWidth?: number }): boolean {
  return a.fullscreen && a.conversationMode && a.hasQuestions && a.boxWidth >= reviewMinBox(a.cardWidth);
}

/** A stored column width that still reads as one (a hand-edited or older value
 *  falls back to the default). */
export function isReviewWidth(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= REVIEW_W_MIN && v <= 4000;
}

/**
 * The room the cards and the text share in the history box now: its width
 * less its side paddings, plus the column width those paddings hold (the
 * right padding carries the column while it is open).
 */
export function reviewRoomOf(a: { boxWidth: number; padLeft: number; padRight: number; cardWidth: number }): number {
  return a.boxWidth - a.padLeft - a.padRight + a.cardWidth;
}

/**
 * The column width to draw for the width the reader wants: at least
 * REVIEW_W_MIN, and at most what leaves REVIEW_TEXT_MIN of text in `room`
 * (reviewRoomOf; unknown room: no upper bound). A room too small for both
 * still gets the minimum column.
 */
export function clampReviewWidth(want: number, room?: number): number {
  const max = room === undefined || !Number.isFinite(room) ? Number.POSITIVE_INFINITY : room - REVIEW_TEXT_MIN;
  const w = Number.isFinite(want) ? want : REVIEW_CARD_W;
  return Math.round(Math.max(REVIEW_W_MIN, Math.min(w, max)));
}

/** One arrow key's width (left widens the column, the bar being its left edge). */
export function stepReviewWidth(current: number, key: 'ArrowLeft' | 'ArrowRight', room?: number): number {
  return clampReviewWidth(current + (key === 'ArrowLeft' ? REVIEW_W_STEP : -REVIEW_W_STEP), room);
}

/** A drag's width: the column's left edge follows the pointer (`dx` from the
 *  press, right is positive, so a drag left widens it). */
export function dragReviewWidth(start: number, dx: number, room?: number): number {
  return clampReviewWidth(start - dx, room);
}

/**
 * What the history box reserves on its right: the card column (`open`), the
 * folded bar alone (`collapsed`), or nothing. An empty sidebar holds no room:
 * with no card on screen (every asked passage in turns not loaded) there is
 * nothing to show or hide (2026-10-31: a tall blank column beside the text).
 */
export type ReviewGutter = 'open' | 'collapsed' | null;

export function reviewGutterOf(a: { available: boolean; collapsed: boolean; cards: number }): ReviewGutter {
  if (!a.available || a.cards === 0) return null;
  return a.collapsed ? 'collapsed' : 'open';
}

export interface ReviewStackItem {
  key: string;
  /** The passage's top, in the layer's coordinates. */
  anchor: number;
  height: number;
}

/**
 * Each card's top: at its passage, pushed down below the card before it so none
 * overlap (`gap` between). A selected card sits exactly at its passage and the
 * cards above it move up to make room, never above 0; when there is no room
 * left above, the rest flows down again.
 */
export function stackReviewCards(items: readonly ReviewStackItem[], gap: number, selected?: string | null): Map<string, number> {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.anchor - b.it.anchor || a.i - b.i).map((x) => x.it);
  const tops = order.map((it) => Math.max(0, it.anchor));
  for (let i = 1; i < order.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + order[i - 1].height + gap);
  const s = selected ? order.findIndex((it) => it.key === selected) : -1;
  if (s > 0 && tops[s] > order[s].anchor) {
    tops[s] = Math.max(0, order[s].anchor);
    for (let i = s - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - gap - order[i].height);
    tops[0] = Math.max(0, tops[0]);
    for (let i = 1; i < order.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + order[i - 1].height + gap);
    // Below the selection the natural flow comes back (nothing above pushes it now).
    for (let i = s + 1; i < order.length; i++) tops[i] = Math.max(Math.max(0, order[i].anchor), tops[i - 1] + order[i - 1].height + gap);
  }
  return new Map(order.map((it, i) => [it.key, Math.round(tops[i])]));
}

/**
 * Moves one card up to `to` (never down) and the cards above it as far as they
 * must so none overlap, never above 0; when the ones above run out of room, the
 * card stops lower. Cards below it keep their place.
 */
export function liftReviewCard(
  tops: ReadonlyMap<string, number>, heights: ReadonlyMap<string, number>, key: string, to: number, gap: number,
): Map<string, number> {
  const out = new Map(tops);
  const at = tops.get(key);
  if (at === undefined || to >= at) return out;
  const above = [...tops].filter(([k, t]) => k !== key && t < at).sort((a, b) => b[1] - a[1]);
  // How high it can go: each card above packed onto the next, the first at 0.
  let room = 0;
  for (const [k] of above) room += (heights.get(k) ?? 0) + gap;
  const top = Math.round(Math.max(to, room));
  out.set(key, top);
  let next = top;
  for (const [k, t] of above) {
    const h = heights.get(k) ?? 0;
    const moved = Math.min(t, next - gap - h);
    out.set(k, Math.round(moved));
    next = moved;
  }
  return out;
}

/** Markdown to a short plain line: code blocks become `[code]`, marks go, white
 *  space collapses; cut at `max` characters with an ellipsis. */
export function plainExcerpt(text: string, max: number): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  // At a word's end when one is near, else mid-word.
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A person's own message as a review card shows it (2026-11-10, the user, of
 *  the blue bubbles in the side cards: "too much, put it inside the input
 *  bar"): one plain line after "You:", its attachments counted. The card's CSS
 *  clamps it to two lines; the whole of it is the line's tooltip. */
export function askedLine(text: string, attachments = 0, max = 2000): string {
  const words = plainExcerpt(text, max);
  if (attachments <= 0) return words;
  const count = `[${attachments} attachment${attachments === 1 ? '' : 's'}]`;
  return words ? `${words} ${count}` : count;
}

/** Positions as one comparable string (a re-measure that moved nothing is a no-op). */
export function anchorsSig(anchors: ReadonlyMap<string, number>): string {
  return [...anchors].map(([k, v]) => `${k}:${v}`).join('|');
}
