/**
 * An open project in the task list draws its first rows only, then a "Show more" row.
 * A project with a thousand tasks drew a thousand rows (and ~10 DOM nodes each) the
 * moment it opened, and WebKit painted blank strips while scrolling through them
 * (2026-09-23, "it kind of flashes to white when I scroll").
 */
export const LIST_BATCH = 30;
/** A few extra rows cost less than a "Show more" row that reveals two tasks. */
export const LIST_BATCH_SLACK = 10;
/** The batch key of the "In one list" view; no project name can hold a NUL. */
export const FLAT_BATCH_KEY = '\u0000flat';

/** One list's batch for this visit: how many rows it draws, and the rows a locate or a
 *  focus reached past them, which stay drawn after focus moves on. */
export interface ListBatchState {
  limit: number;
  kept: ReadonlySet<string>;
}

export const FRESH_BATCH: ListBatchState = { limit: LIST_BATCH, kept: new Set() };

export interface ListBatchCut<T> {
  /** The first rows, drawn in order above the "Show more" row. */
  head: T[];
  /** Kept rows far past the head, drawn on their own below the "Show more" row. */
  tail: T[];
  /** Counted rows drawn nowhere; 0 means the whole list is drawn (in `head`). */
  hidden: number;
}

/**
 * Cut a list to `limit` counted rows. Rows `counts` rejects (members of a folded folder,
 * drawn but not seen) ride along free. A kept row just past the cut extends it; one far
 * past is drawn alone after the "Show more" row, so locating row 2,000 of a project does
 * not draw the 1,970 before it.
 */
export function cutListBatch<T extends { id: string }>(
  rows: T[],
  limit: number,
  isKept: (id: string) => boolean,
  counts: (row: T) => boolean,
): ListBatchCut<T> {
  let total = 0;
  for (const row of rows) if (counts(row)) total++;
  if (total <= limit + LIST_BATCH_SLACK) return { head: rows, tail: [], hidden: 0 };
  let cut = rows.length;
  let seen = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!counts(rows[i])) continue;
    if (seen === limit) { cut = i; break; }
    seen++;
  }
  const reach = cut + LIST_BATCH;
  const far: number[] = [];
  for (let i = cut; i < rows.length; i++) {
    if (!isKept(rows[i].id)) continue;
    if (i < reach) cut = i + 1;
    else far.push(i);
  }
  while (cut < rows.length && !counts(rows[cut])) cut++;
  const tailAt = far.filter((i) => i >= cut);
  let hidden = 0;
  for (let i = cut; i < rows.length; i++) if (counts(rows[i])) hidden++;
  for (const i of tailAt) if (counts(rows[i])) hidden--;
  if (hidden <= LIST_BATCH_SLACK) return { head: rows, tail: [], hidden: 0 };
  return { head: rows.slice(0, cut), tail: tailAt.map((i) => rows[i]), hidden };
}

/** Is `id` past the first `limit` counted rows (so a focus on it should keep it drawn)? */
export function isPastBatch<T extends { id: string }>(
  rows: T[],
  limit: number,
  id: string,
  counts: (row: T) => boolean,
): boolean {
  let seen = 0;
  for (const row of rows) {
    if (row.id === id) return seen >= limit;
    if (counts(row)) seen++;
  }
  return false;
}
