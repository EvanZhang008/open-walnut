/**
 * The arrows of a task's ask pages (ask-pages.ts): "‹ 1/3 ›" on the card's last line, beside
 * Snooze. Left and Right page too while the focus is on the card but outside a box, and a
 * sideways swipe on a touch screen. The place is said to a screen reader by the block's own live
 * line (ActionNeeded.tsx), which stays while the pages change under it.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from '@/components/common/Icons';

/** `unsent`: pages he left whose send failed; the place says so until he goes back to them. */
export function AskPager({ index, count, unsent = 0, onGo }: { index: number; count: number; unsent?: number; onGo: (delta: number, from: 'prev' | 'next') => void }) {
  return (
    <span className="ask-pager" data-testid="action-pager">
      <button type="button" className="ask-pager-btn" data-testid="action-page-prev" aria-label="Previous decision" disabled={index <= 0} onClick={() => onGo(-1, 'prev')}>{ICON_CHEVRON_LEFT}</button>
      <span className="ask-pager-at" data-testid="action-page-at" aria-hidden="true">{index + 1}/{count}</span>
      {unsent > 0 && <span className="ask-pager-unsent" data-testid="action-page-unsent" aria-hidden="true">· {unsent} not sent</span>}
      <button type="button" className="ask-pager-btn" data-testid="action-page-next" aria-label="Next decision" disabled={index >= count - 1} onClick={() => onGo(1, 'next')}>{ICON_CHEVRON_RIGHT}</button>
    </span>
  );
}

/** A box, a menu or a list open in the card keeps its own arrows and its own drags. */
const OWN_KEYS = 'textarea, input, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="dialog"], [role="radiogroup"]';

/** Left / Right keys and a sideways swipe on the pages' holder. */
export function usePageGestures(count: number, go: (delta: number) => void) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (count < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if ((e.target as Element).closest?.(OWN_KEYS)) return;
    e.preventDefault();
    go(e.key === 'ArrowLeft' ? -1 : 1);
  };
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    // A finger only: a pen selects words, and a mouse drags to select.
    if (count < 2 || e.pointerType !== 'touch' || (e.target as Element).closest?.(OWN_KEYS)) { start.current = null; return; }
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    // A stroke that selected words is a selection, not a page turn.
    if (window.getSelection()?.toString()) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // A clear sideways stroke: a scroll or a tap never pages.
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };
  const onPointerCancel = () => { start.current = null; };
  return { onKeyDown, onPointerDown, onPointerUp, onPointerCancel };
}
