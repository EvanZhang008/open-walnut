import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useThreadMapCollapsed } from '@/hooks/useThreadMapCollapsed';
import {
  MAP_PANEL_MIN_BOX, mapHasContent, mapPanelWidth, mapRows, mapShapeFor, type MapRowsInput, type ThreadMapShape,
} from '@/utils/thread-map';
import type { TreeRow } from '@/utils/thread-tree-rows';

export interface ThreadMapLayout {
  rows: TreeRow[];
  /** null: no map (no questions, or a timeline without a question store). */
  shape: ThreadMapShape | null;
  /** The panel's width in px (the gutter pads by it). */
  panelWidth: number;
  /** The scroll box's width in px. */
  boxWidth: number;
  /** The box could hold the panel. */
  roomy: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

const NO_ROWS: TreeRow[] = [];

/** The scroll box's gutter as the map sets it: the attribute + the panel width. */
function applyGutter(el: HTMLElement, shape: ThreadMapShape | null, width: number): void {
  if (shape) el.dataset.threadMap = shape; else delete el.dataset.threadMap;
  if (shape === 'panel') el.style.setProperty('--thread-map-w', `${width}px`);
  else el.style.removeProperty('--thread-map-w');
}

/** The first message row showing at the top of the box, and its offset there. */
function topRow(el: HTMLElement): { row: HTMLElement; top: number } | null {
  const viewTop = el.getBoundingClientRect().top + (parseFloat(getComputedStyle(el).paddingTop) || 0);
  for (const row of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const r = row.getBoundingClientRect();
    if (r.bottom > viewTop) return { row, top: r.top };
  }
  return null;
}

/**
 * Rows and shape of the question map for one timeline. The box is measured in a
 * layout effect (before paint, so the first frame already has the right shape)
 * and on every resize. `offsetWidth` rather than clientWidth: the gutter this
 * map adds can bring a scrollbar in, and a scrollbar-sensitive width would flip
 * the shape back and forth across the threshold.
 *
 * A shape change moves the text column by the gutter's width, which reflows
 * every message; the scroll box has no native scroll anchoring, so the passage
 * you were reading is held in place here (C26), unless the timeline follows its
 * bottom, where it stays at the bottom.
 */
export function useThreadMapLayout(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  input: MapRowsInput,
  isFollowingBottom?: () => boolean,
): ThreadMapLayout {
  const [collapsed, setCollapsed] = useThreadMapCollapsed();
  const { tree, index, pins, live, pending, drafts, currentKey, doneGroupsOpen } = input;
  const rows = useMemo(
    () => (enabled ? mapRows({ tree, index, pins, live, pending, drafts, currentKey, doneGroupsOpen }) : NO_ROWS),
    [enabled, tree, index, pins, live, pending, drafts, currentKey, doneGroupsOpen],
  );
  const visible = enabled && mapHasContent(rows);

  // Width only: the height changes on every push and pop, and state here
  // re-renders the whole timeline (the map measures its own height).
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!visible || !el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, visible]);

  // Unmeasured (width 0) reads as the rail: a rail never reserves a gutter, so
  // the first frame cannot flash a padding it then takes back.
  const shape = visible ? mapShapeFor(width, collapsed) : null;
  const panelWidth = mapPanelWidth(width);

  // Hold the reading position across a gutter change. The new gutter is already
  // in the DOM here, so the old one is put back for one measure, then removed.
  const last = useRef<{ shape: ThreadMapShape | null; width: number; measured: boolean }>({ shape: null, width: 0, measured: false });
  const followRef = useRef(isFollowingBottom);
  followRef.current = isFollowingBottom;
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { shape, width: panelWidth, measured: width > 0 };
    const el = containerRef.current;
    const gutterMoved = prev.shape !== shape || (shape === 'panel' && prev.width !== panelWidth);
    // The first map in a session (null to a shape) is the first Ask's own
    // landing, which places the page itself (C23); the first measure (the
    // unmeasured rail to the real shape) lands before the first paint, under
    // the timeline's own opening scroll.
    if (!el || !gutterMoved || prev.shape === null || shape === null || !prev.measured) return;
    // A hidden timeline (a team tab shows instead) has nothing to hold.
    if (el.clientHeight === 0) return;
    if (followRef.current?.()) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    applyGutter(el, prev.shape, prev.width);
    const before = topRow(el);
    applyGutter(el, shape, panelWidth);
    if (!before) return;
    const after = before.row.getBoundingClientRect().top;
    if (Math.abs(after - before.top) >= 1) el.scrollTop += after - before.top;
  }, [containerRef, shape, panelWidth, width]);

  return {
    rows,
    shape,
    panelWidth,
    boxWidth: width,
    roomy: width >= MAP_PANEL_MIN_BOX,
    setCollapsed,
  };
}
