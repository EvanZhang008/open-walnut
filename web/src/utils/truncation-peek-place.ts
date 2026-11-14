/** Where a cut-off text's pill goes (utils/truncation-peek.ts), as plain numbers, so it is tested without a page. */

/** Hover intent before the first pill, so a pointer passing over a list does not flash one. */
export const PEEK_OPEN_MS = 90;
/** Room kept between the pill and the window's edges. */
export const PEEK_EDGE = 8;
/** Space around the text inside the pill (the text itself stays where it was). */
export const PEEK_PAD_X = 6;
export const PEEK_PAD_Y = 2;

export interface PeekBox { left: number; top: number; width: number; height: number }

/**
 * Where the pill goes: its text starts where the cut-off text starts and runs out to the
 * right. `natural` is the text's width on one line; `minWidth` the width the text had on the
 * page (a clamp keeps it). It stays one line, like the side bar's pill, so it covers no row
 * below, and wraps only past the window's width. It never leaves the window: when the room on
 * the right is too narrow it moves left, as far as it must.
 * `height` is filled in by the caller once the width is known (`placeVertically`).
 */
export function placePeek(text: { left: number; top: number }, natural: number, minWidth: number, viewport: { width: number; height: number }): PeekBox {
  const want = Math.min(Math.max(natural, minWidth) + PEEK_PAD_X * 2, viewport.width - PEEK_EDGE * 2);
  let left = text.left - PEEK_PAD_X;
  if (left + want > viewport.width - PEEK_EDGE) left = Math.max(PEEK_EDGE, viewport.width - PEEK_EDGE - want);
  if (left < PEEK_EDGE) left = PEEK_EDGE;
  return { left, top: text.top - PEEK_PAD_Y, width: want, height: 0 };
}

/** Moves a placed pill up so its bottom stays in the window, never above its top edge. */
export function placeVertically(box: PeekBox, height: number, viewportHeight: number): PeekBox {
  let top = box.top;
  if (top + height > viewportHeight - PEEK_EDGE) top = Math.max(PEEK_EDGE, viewportHeight - PEEK_EDGE - height);
  return { ...box, top, height };
}
