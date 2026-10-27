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
export const REVIEW_CARD_W = 300;
/** Between two cards. */
export const REVIEW_GAP = 8;

export function reviewSidebarOn(a: { fullscreen: boolean; boxWidth: number; conversationMode: boolean; hasQuestions: boolean }): boolean {
  return a.fullscreen && a.conversationMode && a.hasQuestions && a.boxWidth >= REVIEW_MIN_BOX;
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

/** Positions as one comparable string (a re-measure that moved nothing is a no-op). */
export function anchorsSig(anchors: ReadonlyMap<string, number>): string {
  return [...anchors].map(([k, v]) => `${k}:${v}`).join('|');
}
