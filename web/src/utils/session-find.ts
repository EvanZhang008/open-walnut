/**
 * Cmd+F across a session's WHOLE history, the rows the chat does not show
 * included (components/common/PageFind.tsx owns the bar).
 *
 * The page find walks what the chat has rendered and the reader can see: the
 * newest turns, minus whatever sits in a closed fold. The server answers which
 * rows of the whole transcript hold the query (GET /api/sessions/:id/find); the
 * rows of that answer not visible on the page are the "hidden" matches, above
 * the rendered turns or folded between them. The find numbers every match in
 * the transcript's own order, hidden or not, by each row's position in the
 * chat's rows. Stepping onto a hidden one asks the chat to show that row (load
 * it, render it, open its fold); once it is visible the page find takes it over.
 */

/** What a mounted chat tells the find bar about its own rows. */
export interface SessionFindBridge {
  sessionId: string;
  /** false while the chat shows a filtered view (a question's page) whose rows
   *  are not the transcript in order: the bar then searches the page alone. */
  enabled(): boolean;
  /**
   * Where this row sits among the chat's rows (its index), a negative number
   * for a row older than everything held (not loaded yet), null for a row this
   * chat cannot show.
   */
  positionOf(id: string, timestamp: string): number | null;
  /** Show this row: load older history first when it is not held, render it,
   *  open its fold. Quiet: no scroll and no flash, the find bar scrolls to its
   *  match. `onMissing` when the row is not in the transcript even after the
   *  load; `stillWanted` false once the bar moved on or closed, and a load still
   *  running then shows nothing. */
  reveal(id: string, onMissing: () => void, stillWanted: () => boolean): void;
  /** Open the folded message cards of this row (its words can sit in a card's
   *  body); false when it has none still closed. */
  openFolds(id: string): boolean;
}

const bridges = new WeakMap<Element, SessionFindBridge>();

/** Called by the chat for its scroll container; returns the unregister. */
export function registerSessionFind(root: Element, bridge: SessionFindBridge): () => void {
  bridges.set(root, bridge);
  return () => { if (bridges.get(root) === bridge) bridges.delete(root); };
}

export function sessionFindOf(root: Element | null | undefined): SessionFindBridge | null {
  const b = root ? bridges.get(root) : undefined;
  return b && b.enabled() ? b : null;
}

/** A row holding the query that the page does not show, at its position (a
 *  half step past it: the row's hidden words after its visible ones). */
export interface HiddenRow { id: string; count: number; pos: number }

/**
 * Every match in transcript order: the hidden rows (sorted by `pos`) and the
 * page find's matches, each page match at the position of the row holding it
 * (`pagePos`, non-decreasing: document order is transcript order).
 */
export interface FindLayout {
  hidden: readonly HiddenRow[];
  pagePos: readonly number[];
}

/** One place in that order: a page match by its page index, or occurrence
 *  `occurrence` of hidden row `row`. */
export type FindStop =
  | { kind: 'page'; index: number }
  | { kind: 'hidden'; row: number; occurrence: number };

export function hiddenTotal(rows: ReadonlyArray<HiddenRow>): number {
  let n = 0;
  for (const r of rows) n += r.count;
  return n;
}

/** How many of the sorted `values` are below `p`. */
function countBelow(values: readonly number[], p: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Hidden occurrences in rows before position `p`. */
export function hiddenBefore(rows: ReadonlyArray<HiddenRow>, p: number): number {
  let n = 0;
  for (const r of rows) {
    if (r.pos >= p) break;
    n += r.count;
  }
  return n;
}

/** 0-based place of page match `i` in the whole order. */
export function placeOfPage(layout: FindLayout, i: number): number {
  return hiddenBefore(layout.hidden, layout.pagePos[i]!) + i;
}

/** 0-based place of a hidden occurrence in the whole order. */
export function placeOfHidden(layout: FindLayout, row: number, occurrence: number): number {
  let before = 0;
  for (let r = 0; r < row; r++) before += layout.hidden[r]!.count;
  return before + countBelow(layout.pagePos, layout.hidden[row]!.pos) + occurrence;
}

export function totalOf(layout: FindLayout): number {
  return hiddenTotal(layout.hidden) + layout.pagePos.length;
}

/** The stop at 0-based place `c`. */
export function stopAt(layout: FindLayout, c: number): FindStop {
  let hiddenSoFar = 0;
  for (let r = 0; r < layout.hidden.length; r++) {
    const row = layout.hidden[r]!;
    const start = hiddenSoFar + countBelow(layout.pagePos, row.pos);
    if (c < start) return { kind: 'page', index: c - hiddenSoFar };
    if (c < start + row.count) return { kind: 'hidden', row: r, occurrence: c - start };
    hiddenSoFar += row.count;
  }
  return { kind: 'page', index: c - hiddenSoFar };
}

/**
 * One next (dir 1) or previous (-1) from place `c` (null: nothing chosen yet),
 * wrapping at both ends. From nothing chosen the page find picks from the view
 * itself (`null` back) unless the page has no match.
 */
export function stepFind(layout: FindLayout, c: number | null, dir: 1 | -1): FindStop | null {
  const total = totalOf(layout);
  if (!total) return null;
  if (c === null) {
    if (layout.pagePos.length) return null;
    return stopAt(layout, dir === 1 ? 0 : total - 1);
  }
  return stopAt(layout, (c + dir + total) % total);
}
