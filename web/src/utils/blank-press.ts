/**
 * A press in the blank space under an editor's last line puts the caret at the end, the way a
 * text box does (2026-11-10 review: a click below the last line in Source focused nothing, and
 * the next key went to the page, where "F" opened the task filter over the Files sheet).
 *
 * The editor itself only hears presses on its text; the space under a short file is its
 * scroller, its host or the file view around it.
 */

export interface PressBox { left: number; top: number; right: number; bottom: number }

/**
 * Is this press under the text and not on a scrollbar? `lastBottom`: the bottom of the last
 * line on screen (null: the end of the text is not drawn, so there is no blank space under
 * it); `client`: the scroller's box without its scrollbars, when the press is in a scroller.
 */
export function pressBelowText(y: number, x: number, lastBottom: number | null, client: PressBox | null): boolean {
  if (lastBottom == null || y <= lastBottom) return false;
  if (client && (x > client.right || y > client.bottom || x < client.left || y < client.top)) return false;
  return true;
}

/** A scroller's box less its scrollbars, in viewport coordinates. */
export function clientBoxOf(el: Element): PressBox {
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
}
