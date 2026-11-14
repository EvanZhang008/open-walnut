/**
 * A task row that expands in place (2026-11-13, the user, of a floating pill over the next
 * pane: "THIS IS not the expand I want, I want the actually the task to expand to a full one").
 * The row itself grows: each of its cut-off texts wraps inside the row's own width, every box
 * between it and the list that clipped it to one line lets it grow, and the rows below move
 * down. Nothing floats over another pane. It is undone by removing the same attributes, so
 * nothing the page set itself is touched (styles/truncation-peek.css holds the rules).
 *
 * A row only grows downward from its own top, so the pointer stays on it while it opens. What
 * could move rows under the pointer is a row ABOVE it closing (the pointer went on down the
 * list): it closes in the same step the next row opens (truncation-peek.ts), and collapseRow
 * scrolls the list back by what it gave up, as far as the list can scroll.
 */

/** On a cut-off text of the row: it wraps instead of cutting. */
export const OPEN_ATTR = 'data-peek-open';
/** On a box that clipped the text to its height: it takes the height of what it holds. */
export const GROW_ATTR = 'data-peek-grow';
/** On a text that would not shrink in its flex line: it shrinks to the row's width and wraps. */
export const FIT_ATTR = 'data-peek-fit';
/** On the row while it is open. */
export const EXPANDED_ATTR = 'data-peek-expanded';

/** What expanding a row set: each element with the attribute it got. */
export type RowMarks = Array<[Element, string]>;

function isScroller(cs: CSSStyleDeclaration): boolean {
  return cs.overflowY === 'auto' || cs.overflowY === 'scroll';
}

/** The list `row` scrolls in, if any. */
export function listOf(row: Element): Element | null {
  for (let el = row.parentElement; el && el !== document.body; el = el.parentElement) {
    if (isScroller(getComputedStyle(el)) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/** Whether the point is inside `el`'s box. */
export function within(el: Element, p: { x: number; y: number }): boolean {
  const r = el.getBoundingClientRect();
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/**
 * Whether the pointer is in the list of `row`, below or on it: there, closing the row would move
 * what the pointer is on. A row in no scrolling list counts its own column.
 */
export function inListBelow(row: Element, p: { x: number; y: number }): boolean {
  const r = row.getBoundingClientRect();
  if (p.y < r.top) return false;
  const list = listOf(row);
  return list ? within(list, p) : p.x >= r.left && p.x <= r.right;
}

/** Opens `row` with `hosts` (its cut-off texts); returns what it set. */
export function expandRow(row: Element, hosts: HTMLElement[]): RowMarks {
  const marks: RowMarks = [];
  const mark = (el: Element, attr: string) => {
    if (el.hasAttribute(attr)) return;
    el.setAttribute(attr, '');
    marks.push([el, attr]);
  };
  mark(row, EXPANDED_ATTR);
  for (const h of hosts) mark(h, OPEN_ATTR);
  // Up to the list's scroller: a box that cut a text to its own height grows with it.
  for (const h of hosts) {
    for (let el = h.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (isScroller(cs)) break;
      if (cs.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1) mark(el, GROW_ATTR);
    }
  }
  // Measured once everything is open: a text that keeps its full width in a flex line
  // (flex: none) would run past the row.
  const rowRect = row.getBoundingClientRect();
  for (const h of hosts) {
    if (h.getBoundingClientRect().right > rowRect.right + 1 || h.scrollWidth > h.clientWidth + 1) mark(h, FIT_ATTR);
  }
  return marks;
}

/**
 * Closes a row expandRow opened. With `pointer`: when the row is above it, inside its list, the
 * rows under the pointer would move up by what the row gives back, so the list scrolls back by
 * as much when it can. Answers the list it scrolled, if it did.
 */
export function collapseRow(marks: RowMarks, row?: Element, pointer?: { x: number; y: number } | null): Element | null {
  // Out of its list, or with the pointer above it, nothing under the pointer moves.
  const watch = row && pointer && marks.length && row.getBoundingClientRect().bottom <= pointer.y && inListBelow(row, pointer)
    ? document.elementFromPoint(pointer.x, pointer.y) : null;
  const before = watch?.getBoundingClientRect().top;
  const rowHeight = row?.getBoundingClientRect().height ?? 0;
  for (const [el, a] of marks) el.removeAttribute(a);
  if (!row || !watch || before === undefined || row.contains(watch)) return null;
  // How far what the pointer is on really moved up (a list scrolled to its end gives some back
  // by itself, and Chromium's scroll anchoring may too). In a gap between rows the pointer is on
  // a box holding the row, which itself stays: what moves there is what follows the row, by
  // the height the row gave back.
  const shift = watch.contains(row)
    ? rowHeight - row.getBoundingClientRect().height
    : before - watch.getBoundingClientRect().top;
  const list = listOf(row);
  if (shift < 1 || !list) return null;
  // At the top of the list it cannot scroll back: it moves up as much as it can.
  const by = Math.min(shift, list.scrollTop);
  if (by < 1) return null;
  list.scrollTop -= by;
  return list;
}
