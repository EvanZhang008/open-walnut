/**
 * Pure (React-free) geometry for the "expand collapsed context" (unfold) control
 * in the session "Changed" view.
 *
 * Split out of SessionDiffView.tsx for the same reason diffPatch.ts was: the
 * old-side line-number arithmetic that decides WHICH hidden lines each unfold
 * button reveals is fiddly and off-by-one-prone, but it's pure
 * hunks→ranges math — so it can be unit-tested headlessly against the real
 * react-diff-view `parseDiff`/`expandFromRawCode`, with no DOM. The component
 * just maps these descriptors to <Decoration> rows + expandRange() calls.
 */
import { getCollapsedLinesCountBetween, type HunkData } from 'react-diff-view';

/** How many lines one directional ("↑ N" / "↓ N") unfold step reveals, and the
 *  gap size at/below which we collapse to a single "expand all" button. */
export const UNFOLD_CHUNK = 20;

/** Count the lines in the OLD source the same way react-diff-view slices it
 *  (split on '\n'), dropping a lone trailing empty so a file's terminal newline
 *  isn't offered as a phantom extra line. This is the ceiling expansion can reach. */
export function oldSourceLineCount(before: string | null | undefined): number {
  const src = before ?? '';
  if (!src) return 0;
  const arr = src.split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr.length;
}

/** One unfold control to render between/around hunks. `lines` = how many old-side
 *  lines are hidden in this gap. `all` reveals the whole gap; `up`/`down` (when
 *  present) reveal one UNFOLD_CHUNK slice nearest the adjacent hunk — `down` just
 *  below the hunk above, `up` just above the hunk below. Ranges are [start,end)
 *  on OLD-side line numbers, matching expandFromRawCode's contract. */
export interface ExpandGap {
  /** Where to render relative to the hunk list: before hunk index `hunkIndex`,
   *  or the trailing gap after the last hunk (`hunkIndex === hunks.length`). */
  hunkIndex: number;
  lines: number;
  all: readonly [number, number];
  down?: readonly [number, number];
  up?: readonly [number, number];
}

/**
 * Compute every collapsed-context gap for a set of (already-parsed) hunks given
 * the old-source line count. Returns one descriptor per gap that actually hides
 * ≥1 line: the leading gap (before hunk 0), each between-hunk gap, and the
 * trailing gap (after the last hunk, down to EOF).
 *
 * Direction semantics:
 *   - Leading / between gaps get `all` always.
 *   - `down` (reveal from the TOP of the gap, i.e. just below the previous hunk)
 *     is offered only when there IS a previous hunk and the gap is bigger than one
 *     chunk — at the very top of the file there's no "hunk above" to grow from.
 *   - `up` (reveal from the BOTTOM of the gap, i.e. just above the next hunk) is
 *     offered for leading/between gaps bigger than one chunk.
 *   - The trailing gap only has a hunk ABOVE it, so it offers `all` + `down`.
 *
 * Small gaps (≤ UNFOLD_CHUNK) omit `up`/`down` — the caller renders just "expand
 * all N", since one click reveals everything anyway.
 */
export function computeExpandGaps(hunks: HunkData[], oldLineCount: number): ExpandGap[] {
  const gaps: ExpandGap[] = [];
  if (oldLineCount <= 0 || hunks.length === 0) return gaps;

  hunks.forEach((hunk, i) => {
    const prev = i > 0 ? hunks[i - 1]! : null;
    const lo = prev ? prev.oldStart + prev.oldLines : 1; // first hidden old line
    const hi = hunk.oldStart;                            // exclusive upper bound
    const lines = getCollapsedLinesCountBetween(prev, hunk);
    if (lines <= 0) return;
    const big = lines > UNFOLD_CHUNK;
    gaps.push({
      hunkIndex: i,
      lines,
      all: [lo, hi],
      down: prev && big ? [lo, Math.min(lo + UNFOLD_CHUNK, hi)] : undefined,
      up: big ? [Math.max(hi - UNFOLD_CHUNK, lo), hi] : undefined,
    });
  });

  const last = hunks[hunks.length - 1]!;
  const lo = last.oldStart + last.oldLines;
  const tail = oldLineCount - lo + 1;
  if (tail > 0) {
    const big = tail > UNFOLD_CHUNK;
    gaps.push({
      hunkIndex: hunks.length,
      lines: tail,
      all: [lo, oldLineCount + 1],
      down: big ? [lo, Math.min(lo + UNFOLD_CHUNK, oldLineCount + 1)] : undefined,
    });
  }

  return gaps;
}
