/**
 * A fit of a task list's words that CSS cannot judge on its own (2026-11-22 UI audit at 820 px):
 * a search row's second line reads as words joined by "·" (styles/badge.css). In a narrow column
 * the words run onto a third line, and the word that starts it would open with a lone "·". That
 * word is marked `data-line-start` (its dot is hidden) and every word of a wrapped line gets
 * `--wrap-shift`, the hidden dot's room, which badge.css moves the line left by. The room stays
 * in the layout and the move is a relative one, so no word fits back on the line above once its
 * dot is gone (which would flip it back and forth).
 *
 * One observer pair per list, never one per row; a scan is coalesced to one frame, and each pass
 * reads every box before it writes any.
 */
const SEARCH_ROWS = '.todo-search-results .todo-item-content[data-search-meta]';
const LINE_ITEMS = ':scope > .todo-search-meta-row, :scope > .todo-item-title-row > :is(.badge, .task-tag-pills, .todo-item-limit-pill)';

interface Box { top: number; left: number; height: number; width: number }

/**
 * The line each item sits on, in reading order (by line, then from the left; the CSS `order` puts
 * the tier and project first): 0 for the row's first line of words, 1 for the next, and -1 for an
 * item not drawn. An item starts a new line when its middle sits more than half a line below the
 * one read before it. Middles, not tops: the items of one line differ in height.
 */
export function lineOf(boxes: Box[]): number[] {
  const mid = (b: Box) => b.top + b.height / 2;
  const order = boxes.map((_, i) => i).filter((i) => boxes[i].width > 0)
    .sort((a, b) => (Math.abs(mid(boxes[a]) - mid(boxes[b])) > 8 ? mid(boxes[a]) - mid(boxes[b]) : boxes[a].left - boxes[b].left));
  const lines = boxes.map(() => -1);
  let line = 0;
  order.forEach((i, k) => {
    if (k > 0 && mid(boxes[i]) > mid(boxes[order[k - 1]]) + 8) line += 1;
    lines[i] = line;
  });
  return lines;
}

/** The room the "·" before an item takes: its width, its margins and its box's gap. */
function dotRoom(el: HTMLElement): number {
  const dot = getComputedStyle(el, '::before');
  if (dot.content === 'none' || dot.content === 'normal') return 0;
  const n = (v: string) => parseFloat(v) || 0;
  return n(dot.width) + n(dot.marginLeft) + n(dot.marginRight) + n(getComputedStyle(el).columnGap);
}

/**
 * For each item, the room to move it left by (the dot room of its wrapped line's first item, 0 on
 * the first line) and whether it starts its wrapped line.
 */
export function wrapMarks(boxes: Box[], dotRooms: number[]): { start: boolean; shift: number }[] {
  const lines = lineOf(boxes);
  const firstOf = new Map<number, number>();
  lines.forEach((line, i) => {
    if (line <= 0) return;
    const at = firstOf.get(line);
    if (at === undefined || boxes[i].left < boxes[at].left) firstOf.set(line, i);
  });
  return lines.map((line, i) => {
    const first = line > 0 ? firstOf.get(line) : undefined;
    return { start: first === i, shift: first === undefined ? 0 : dotRooms[first] };
  });
}

export function scanMetaLineFit(root: ParentNode): void {
  const reads = [...root.querySelectorAll<HTMLElement>(SEARCH_ROWS)].map((row) => {
    const items = [...row.querySelectorAll<HTMLElement>(LINE_ITEMS)];
    return { items, marks: wrapMarks(items.map((el) => el.getBoundingClientRect()), items.map(dotRoom)) };
  });
  for (const { items, marks } of reads) {
    items.forEach((el, i) => {
      const { start, shift } = marks[i];
      if (start && shift > 0) { if (el.dataset.lineStart !== 'true') el.dataset.lineStart = 'true'; }
      else if (el.dataset.lineStart) delete el.dataset.lineStart;
      if (shift > 0) el.style.setProperty('--wrap-shift', `${shift}px`);
      else if (el.style.getPropertyValue('--wrap-shift')) el.style.removeProperty('--wrap-shift');
    });
  }
}

/** Keeps the marks current under `el` (the list's scroller); returns the stop function. */
export function observeMetaLineFit(el: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; scanMetaLineFit(el); });
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(el);
  // Rows and pills arriving (a search's server hits, a trigger pill drawn later) change the fit
  // without resizing the scroller. Attributes are not watched: the scan writes them.
  const mutate = new MutationObserver(schedule);
  mutate.observe(el, { childList: true, subtree: true, characterData: true });
  schedule();
  return () => { resize.disconnect(); mutate.disconnect(); if (frame) cancelAnimationFrame(frame); };
}
