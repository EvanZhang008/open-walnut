/**
 * Old layer surfaces a WebKit session column keeps while replies stream in.
 *
 * WebKit (the Mac app's WKWebView, Safari) keeps the last surface it drew for a composited
 * layer after the page stops drawing it: the code blocks and tables of a reply that scroll out
 * of view as later replies stream in keep one surface each (1 to 6 MB), held by the window
 * server and no longer by the GPU process. They go only when the column closes. Measured in
 * the Mac app's engine at 1200x800 (graphics-leak round 4): 19 surfaces, 60 MB after 12 long
 * replies. None went in 15 idle minutes, and hiding the window, blur and focus released none.
 *
 * Taking the content of the rows that just left the view out of the layout for one frame makes
 * WebKit build their layers again, which drops the old surfaces: done after each reply, 0 to 3
 * surfaces (at most 6.7 MB) through 12 replies against 19 to 21 (54 to 73 MB) without, and no
 * leaked layer after the page is left. Each row keeps its height while its content is out,
 * so nothing moves: not the rows on screen, not the scroll position, not the scrollbar. The
 * rows are more than OFFSCREEN_MARGIN_PX above the view, so the reader never sees them go.
 * Cost per reply, measured: 10 to 19 ms to measure and mark the rows, 6 to 19 ms to put them
 * back, and the two frames it spans stay at 13 to 41 ms.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { isMacDesktopWebKit } from '@/utils/webkit-engine';
import { isTimelineRow, selectionInside } from './timeline-rows';

/** The mark on a row whose content is out for the frame (globals.css). */
const RELEASE_ATTR = 'data-layer-release';
/** The row's own height while its content is out. */
const RELEASE_HEIGHT_VAR = '--layer-release-h';
/** After a reply settles: the absorption pass and the window's trim run first. */
const SETTLE_DELAY_MS = 1500;
/** A row this far above the view is never painted on screen. */
const OFFSCREEN_MARGIN_PX = 200;
/** Rows one pass takes at most, the nearest to the view first; the rest wait for the next reply. */
const MAX_ROWS_PER_PASS = 16;

export interface RowEdges { top: number; bottom: number; height: number }

/**
 * Which rows to release, given each row's edges and the view's top edge (all in the same
 * coordinates): rows with a box of their own, wholly above the view by more than the margin,
 * the nearest `limit` of them. A row with no box (display:contents, a zero-height card layer
 * whose cards sit on screen) is never one.
 */
export function rowsToRelease(rows: readonly RowEdges[], viewTop: number, limit: number = MAX_ROWS_PER_PASS): number[] {
  const above = viewTop - OFFSCREEN_MARGIN_PX;
  const picked: number[] = [];
  rows.forEach((r, i) => { if (r.height >= 1 && r.bottom < above) picked.push(i); });
  return picked.slice(-limit);
}

/**
 * A row left as it is: it holds the keyboard focus or the selection (taking its content out would
 * move the focus to the page or drop the selection), or a rich HTML block (its frame reports its
 * height, and a frame taken out of the layout could report a wrong one).
 */
export function keepsRowAsIs(row: HTMLElement): boolean {
  if (typeof document === 'undefined') return true;
  const active = document.activeElement;
  if (active && active !== document.body && row.contains(active)) return true;
  if (selectionInside(row)) return true;
  return !!row.querySelector('iframe');
}

/**
 * After each reply settles, while the reader follows the live end: take the content of the
 * rows that left the view out for one frame, so WebKit drops their old layer surfaces. Each row
 * once: a row released stays released until the reader leaves the live end (scrolling back
 * draws it again), so a pass never repeats the rows near the view.
 */
export function useReleaseOffscreenLayers(
  containerRef: RefObject<HTMLElement | null>,
  isStreaming: boolean,
  isAtBottom: RefObject<boolean>,
): void {
  const wasStreaming = useRef(isStreaming);
  const released = useRef(new WeakSet<HTMLElement>());
  useEffect(() => {
    const box = containerRef.current;
    if (!box || !isMacDesktopWebKit()) return;
    const onScroll = () => { if (!isAtBottom.current) released.current = new WeakSet(); };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
    // Again on each stream change: the box may be drawn after the first render.
  }, [containerRef, isAtBottom, isStreaming]);
  useEffect(() => {
    const settled = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    if (!settled || !isMacDesktopWebKit()) return;
    let frame = 0;
    let held: HTMLElement[] = [];
    let fromBottom = 0;
    const putBack = () => {
      if (held.length === 0) return;
      for (const row of held) { row.removeAttribute(RELEASE_ATTR); row.style.removeProperty(RELEASE_HEIGHT_VAR); }
      held = [];
      // A row laid out again can come back a few pixels off its streamed height (a table gains its
      // scrollbar): hold the reader's distance from the live end, as the follow paths do, never
      // under a selection and only when it moved.
      const box = containerRef.current;
      if (!box || !isAtBottom.current || selectionInside(box)) return;
      const target = box.scrollHeight - box.clientHeight - fromBottom;
      if (Math.abs(box.scrollTop - target) > 0.5) box.scrollTop = target;
    };
    const timer = window.setTimeout(() => {
      const box = containerRef.current;
      if (!box || document.hidden) return;
      if (!isAtBottom.current) { released.current = new WeakSet(); return; }
      const rows = Array.from(box.children).filter((el): el is HTMLElement => isTimelineRow(el) && !released.current.has(el));
      const view = box.getBoundingClientRect();
      // Read every edge first, then write: one layout for the whole pass.
      const edges = rows.map((row) => row.getBoundingClientRect());
      const picked = rowsToRelease(edges, view.top).filter((i) => !keepsRowAsIs(rows[i]!));
      if (picked.length === 0) return;
      fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
      for (const i of picked) rows[i]!.style.setProperty(RELEASE_HEIGHT_VAR, `${edges[i]!.height}px`);
      for (const i of picked) { rows[i]!.setAttribute(RELEASE_ATTR, ''); released.current.add(rows[i]!); }
      held = picked.map((i) => rows[i]!);
      // One frame drawn without their content takes their layers down; the next puts it back.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(putBack); });
    }, SETTLE_DELAY_MS);
    return () => { window.clearTimeout(timer); cancelAnimationFrame(frame); putBack(); };
  }, [isStreaming, containerRef, isAtBottom]);
}
