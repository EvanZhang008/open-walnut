/**
 * The divider under Tree Mode's sibling page (tree-sibling.ts; design 8): a
 * drag moves the sibling's share of the right column (1/3 by default, a double
 * click puts it back), the arrow keys move it too, and the knob on it swaps the
 * two questions. The share is kept with the panel's view once the drag ends.
 */
import { memo, useCallback, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { clampSiblingShare, SIBLING_SHARE_DEFAULT, SIBLING_SHARE_MAX, SIBLING_SHARE_MIN } from '@/utils/tree-sibling';

const KEY_STEP = 0.05;

export const TreeSiblingDivider = memo(function TreeSiblingDivider(p: {
  share: number;
  /** `commit`: the drag (or key) ended, keep it. */
  onShare: (share: number, commit: boolean) => void;
  onSwap: () => void;
  /** The page below (the panel's own timeline): the share runs from the sibling's top to its bottom. */
  pageRef: RefObject<HTMLElement | null>;
}) {
  const { onShare, pageRef, share } = p;
  const drag = useRef<{ id: number; last: number } | null>(null);
  const shareAt = useCallback((el: HTMLElement, y: number): number | null => {
    const top = el.parentElement?.getBoundingClientRect().top;
    const bottom = pageRef.current?.getBoundingClientRect().bottom;
    if (top === undefined || bottom === undefined || bottom - top < 40) return null;
    return clampSiblingShare((y - top) / (bottom - top));
  }, [pageRef]);
  const onDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tree-sibling-knob')) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, last: share };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [share]);
  const onMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    const s = shareAt(e.currentTarget, e.clientY);
    if (s === null) return;
    d.last = s;
    onShare(s, false);
  }, [shareAt, onShare]);
  const onUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onShare(d.last, true);
  }, [onShare]);
  const onKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const to = e.key === 'ArrowUp' ? share - KEY_STEP
      : e.key === 'ArrowDown' ? share + KEY_STEP
      : e.key === 'Home' ? SIBLING_SHARE_DEFAULT : null;
    if (to === null) return;
    e.preventDefault();
    onShare(clampSiblingShare(to), true);
  }, [onShare, share]);
  return (
    <div
      className="tree-sibling-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the sibling question"
      aria-valuemin={Math.round(SIBLING_SHARE_MIN * 100)}
      aria-valuemax={Math.round(SIBLING_SHARE_MAX * 100)}
      aria-valuenow={Math.round(share * 100)}
      title="Drag to resize (double click: one third)"
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('.tree-sibling-knob')) onShare(SIBLING_SHARE_DEFAULT, true); }}
      onKeyDown={onKey}
    >
      <button type="button" className="tree-sibling-knob" title="Swap the two questions" aria-label="Swap the two questions" onClick={p.onSwap}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 2.5v10M2.5 10 5 12.5 7.5 10M11 13.5v-10M8.5 6 11 3.5 13.5 6" />
        </svg>
      </button>
    </div>
  );
});
