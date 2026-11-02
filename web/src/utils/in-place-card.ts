/**
 * Where a comment's box opens: in place, right under the words it is about
 * (2026-11-02, the user, on a doc preview whose comment box sat in a column on
 * the right: "comment, need in place not in side bar, waste space", then "this is
 * the doc, but anywhere is same"). Every surface that opens a comment box on a
 * selection places it here, or anchors a menu placement on the selection, which
 * ends up in the same spot; tests/web/comment-in-place-guard.test.ts lists them.
 *
 * The box goes under the passage's last line, starting where that line's chosen
 * words start, kept inside the view; when the view has no room under it and has
 * room over the passage, it goes over the first line instead. Too tall for
 * either side (a long thread, the doc's end in a short view), it takes the side
 * with more room and scrolls inside that room (`maxHeight`), so its words and its
 * buttons both stay in sight; only with no usable room at all is it lifted over
 * some of the words. It never takes room of its own beside the text.
 */

export interface PassageRect { left: number; top: number; right: number; bottom: number }
export interface CardPosition { left: number; top: number; placement: 'below' | 'above'; maxHeight?: number }

/** Space between the passage and its box. */
export const IN_PLACE_GAP = 4;
/** Space kept to the view's edges. */
export const IN_PLACE_MARGIN = 8;
/** The least room a card scrolls in before it is lifted over its words instead. */
export const IN_PLACE_MIN_ROOM = 120;

/**
 * The box's top-left in the view's coordinates, for a passage drawn as `passage`
 * (its line boxes, first to last, in the same coordinates). Null with no lines.
 * `card.height` is the card's whole height (its content, not a height capped by
 * an earlier `maxHeight`), so a placement never feeds back into the next one.
 */
export function inPlaceCardPosition(
  passage: readonly PassageRect[],
  view: { width: number; height: number },
  card: { width: number; height: number },
): CardPosition | null {
  const first = passage[0];
  const last = passage[passage.length - 1];
  if (!first || !last) return null;
  // A line holds a box per inline element (code, bold, a link): the last line is
  // every box that shares the last one's line, and its words start at the leftmost.
  const onLastLine = passage.filter((r) => r.top < last.bottom - 1 && r.bottom > last.top + 1);
  const lineLeft = Math.min(...onLastLine.map((r) => r.left));
  const lineBottom = Math.max(...onLastLine.map((r) => r.bottom));
  const top = Math.min(...passage.filter((r) => r.top < first.bottom - 1 && r.bottom > first.top + 1).map((r) => r.top));
  const maxLeft = Math.max(IN_PLACE_MARGIN, view.width - card.width - IN_PLACE_MARGIN);
  const left = Math.min(Math.max(lineLeft, IN_PLACE_MARGIN), maxLeft);
  const below = lineBottom + IN_PLACE_GAP;
  const above = top - IN_PLACE_GAP - card.height;
  // A passage scrolled past the view's bottom keeps its card with it (not drawn).
  if (top >= view.height || below + card.height <= view.height) return { left, top: below, placement: 'below' };
  if (above >= 0) return { left, top: above, placement: 'above' };
  const roomBelow = view.height - below - IN_PLACE_MARGIN;
  const roomAbove = top - IN_PLACE_GAP - IN_PLACE_MARGIN;
  if (roomBelow >= IN_PLACE_MIN_ROOM && roomBelow >= roomAbove) return { left, top: below, placement: 'below', maxHeight: roomBelow };
  if (roomAbove >= IN_PLACE_MIN_ROOM) return { left, top: IN_PLACE_MARGIN, placement: 'above', maxHeight: roomAbove };
  const lifted = Math.max(IN_PLACE_MARGIN, view.height - card.height - IN_PLACE_MARGIN);
  return { left, top: Math.min(below, lifted), placement: 'below' };
}
