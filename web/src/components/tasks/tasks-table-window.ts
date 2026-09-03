/**
 * Windowing arithmetic for the tasks table.
 *
 * Split out of TasksPageTable.tsx so it can be unit-tested as plain logic: this is
 * where an off-by-one would hide, and the symptom would be a blank strip at the leading
 * edge during a fast flick, which is miserable to catch by eye and reads to a user as
 * "scrolling is broken".
 *
 * Tested in tests/web/tasks-table-window.test.ts.
 */

/**
 * Row/header/ghost heights, from web/src/styles/tasks-page.css. Every one is an explicit
 * `height` there, which is what makes a windowed render possible without measuring
 * anything: a fixed height per item kind means item N's scroll offset is arithmetic.
 * The test ratchets these against the CSS — change the CSS and it tells you to come here.
 */
export const ROW_H = 36;
export const GROUP_H = 32;
export const GHOST_H = 34;

/**
 * Below this many items the whole list renders, exactly as it always did.
 *
 * Two reasons for a threshold rather than always windowing. It is where the cost
 * actually is: measured on a real 2,923-task dataset, opening /tasks built 79,073 DOM
 * elements and blocked the main thread for 1.7s (three runs: 1735/1694/1685ms), while a
 * few hundred rows is imperceptible. And it keeps the blast radius small: several E2E
 * specs locate rows by `data-task-id` or by text and assume every row is in the DOM, and
 * their fixtures are far below this, so they keep the unwindowed path unchanged.
 */
export const WINDOW_MIN_ITEMS = 200;

/** Extra items rendered above/below the viewport, so a fast flick has cover. */
export const OVERSCAN = 12;

/**
 * Inclusive `[first, last]` item indices to render for a scroll position.
 *
 * `offsets` is a prefix sum with ONE EXTRA entry: `offsets[i]` is item i's top edge and
 * `offsets[n]` is the total height. Returns `[0, -1]` (an empty range) for an empty list.
 */
export function visibleRangeFor(
  offsets: number[],
  scrollTop: number,
  viewportH: number,
  overscan: number,
): [number, number] {
  const count = offsets.length - 1;
  if (count <= 0) return [0, -1];
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportH);
  // Binary search for the last item whose top edge is at or above `top`.
  let lo = 0; let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= top) lo = mid + 1; else hi = mid;
  }
  // Then walk forward while items still start before the viewport's bottom edge.
  let end = lo;
  while (end < count - 1 && offsets[end + 1] < bottom) end++;
  return [Math.max(0, lo - overscan), Math.min(count - 1, end + overscan)];
}

/** Prefix sums for a list of item heights: `[0, h0, h0+h1, …]`, length n+1. */
export function offsetsFor(heights: number[]): number[] {
  const o = new Array<number>(heights.length + 1);
  o[0] = 0;
  for (let i = 0; i < heights.length; i++) o[i + 1] = o[i] + heights[i];
  return o;
}
