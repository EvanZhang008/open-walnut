/**
 * A divider between two of Tree Mode's pages (2026-11-11, the user: the parent
 * and the child page are "equal also can adjustable"): a drag moves divider
 * `index` within the column (tree-split-state.ts moveBound keeps every page wide
 * enough), a double click puts the pages back to equal, and the arrow keys move
 * it too. It sits on the right edge of page `index + 1` (its grid column), over
 * its border. The places are kept for the user once the drag ends.
 */
import { memo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { defaultBounds } from '@/utils/tree-split-state';

const KEY_STEP = 0.05;

export const TreeSplitDivider = memo(function TreeSplitDivider(p: {
  /** Which divider, left to right (0 = the one right of the first page). */
  index: number;
  /** How many pages sit side by side. */
  panes: number;
  /** Its place, as a share of the column's width. */
  share: number;
  /** `commit`: the drag (or key) ended, keep it. `width`: the column's, for the minimum page width. */
  onShare: (index: number, share: number, width: number, commit: boolean) => void;
}) {
  const { onShare, share, index, panes } = p;
  const drag = useRef<{ id: number; last: number } | null>(null);
  /** The share under the pointer: the column is the divider's parent. */
  const shareAt = useLeanCallback((el: HTMLElement, x: number): { share: number; width: number } | null => {
    const r = el.parentElement?.getBoundingClientRect();
    if (!r || r.width < 80) return null;
    return { share: (x - r.left) / r.width, width: r.width };
  }, []);
  const widthOf = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? 0;
  const onDown = useLeanCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, last: share };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.dataset.dragging = 'true';
  }, [share]);
  const onMove = useLeanCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    const at = shareAt(e.currentTarget, e.clientX);
    if (at === null) return;
    d.last = at.share;
    onShare(index, at.share, at.width, false);
  }, [shareAt, onShare, index]);
  const onUp = useLeanCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    delete e.currentTarget.dataset.dragging;
    // The release point counts too: a quick flick may end before a move arrives.
    const at = e.type === 'pointerup' ? shareAt(e.currentTarget, e.clientX) : null;
    onShare(index, at?.share ?? d.last, at?.width ?? widthOf(e.currentTarget), true);
  }, [onShare, shareAt, index]);
  const onKey = useLeanCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const to = e.key === 'ArrowLeft' ? share - KEY_STEP
      : e.key === 'ArrowRight' ? share + KEY_STEP
      : e.key === 'Home' ? defaultBounds(panes)[index] : null;
    if (to === null || to === undefined) return;
    e.preventDefault();
    onShare(index, to, widthOf(e.currentTarget), true);
  }, [onShare, share, index, panes]);
  const reset = useLeanCallback((e: { currentTarget: HTMLElement }) => {
    onShare(index, defaultBounds(panes)[index] ?? share, widthOf(e.currentTarget), true);
  }, [onShare, index, panes, share]);
  return (
    <div
      className="tree-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={panes > 2 ? `Resize pages ${index + 1} and ${index + 2}` : 'Resize the two pages'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      title="Drag to resize (double click: equal)"
      tabIndex={0}
      style={{ gridColumn: index + 1 }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={reset}
      onKeyDown={onKey}
    />
  );
});
