/**
 * The divider between Tree Mode's two pages (2026-11-11, the user: the parent
 * and the child page are "equal also can adjustable"): a drag moves the left
 * page's share of the column (half by default, kept for the user, inside
 * clampLeftShare's bounds), a double click puts it back to half, and the arrow
 * keys move it too. It sits on the left page's right edge, over its border.
 */
import { memo, useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { clampLeftShare, LEFT_SHARE_DEFAULT, LEFT_SHARE_MAX, LEFT_SHARE_MIN } from '@/utils/tree-split-state';

const KEY_STEP = 0.05;

export const TreeSplitDivider = memo(function TreeSplitDivider(p: {
  share: number;
  /** `commit`: the drag (or key) ended, keep it. */
  onShare: (share: number, commit: boolean) => void;
}) {
  const { onShare, share } = p;
  const drag = useRef<{ id: number; last: number } | null>(null);
  /** The share under the pointer: the column is the divider's parent. */
  const shareAt = useCallback((el: HTMLElement, x: number): number | null => {
    const r = el.parentElement?.getBoundingClientRect();
    if (!r || r.width < 80) return null;
    return clampLeftShare((x - r.left) / r.width, r.width);
  }, []);
  const widthOf = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width;
  const onDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, last: share };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.dataset.dragging = 'true';
  }, [share]);
  const onMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    const s = shareAt(e.currentTarget, e.clientX);
    if (s === null) return;
    d.last = s;
    onShare(s, false);
  }, [shareAt, onShare]);
  const onUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    delete e.currentTarget.dataset.dragging;
    // The release point counts too: a quick flick may end before a move arrives.
    const s = e.type === 'pointerup' ? shareAt(e.currentTarget, e.clientX) : null;
    onShare(s ?? d.last, true);
  }, [onShare, shareAt]);
  const onKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const to = e.key === 'ArrowLeft' ? share - KEY_STEP
      : e.key === 'ArrowRight' ? share + KEY_STEP
      : e.key === 'Home' ? LEFT_SHARE_DEFAULT : null;
    if (to === null) return;
    e.preventDefault();
    onShare(clampLeftShare(to, widthOf(e.currentTarget)), true);
  }, [onShare, share]);
  return (
    <div
      className="tree-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the two pages"
      aria-valuemin={Math.round(LEFT_SHARE_MIN * 100)}
      aria-valuemax={Math.round(LEFT_SHARE_MAX * 100)}
      aria-valuenow={Math.round(share * 100)}
      title="Drag to resize (double click: equal)"
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => onShare(LEFT_SHARE_DEFAULT, true)}
      onKeyDown={onKey}
    />
  );
});
