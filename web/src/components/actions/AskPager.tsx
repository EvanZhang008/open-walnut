/**
 * The arrows of a task's ask pages (ask-pages.ts): "‹ 1/3 ›" on the card's last line, beside
 * Snooze. Left and Right page too while the focus is on the card but outside a box, and a
 * sideways swipe on a touch screen. The place is said to a screen reader by the block's own live
 * line (ActionNeeded.tsx), which stays while the pages change under it.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

const Chevron = ({ back }: { back?: boolean }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={back ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'} />
  </svg>
);

export function AskPager({ index, count, onGo }: { index: number; count: number; onGo: (delta: number, from: 'prev' | 'next') => void }) {
  return (
    <span className="ask-pager" data-testid="action-pager">
      <button type="button" className="ask-pager-btn" data-testid="action-page-prev" aria-label="Previous decision" disabled={index <= 0} onClick={() => onGo(-1, 'prev')}><Chevron back /></button>
      <span className="ask-pager-at" data-testid="action-page-at" aria-hidden="true">{index + 1}/{count}</span>
      <button type="button" className="ask-pager-btn" data-testid="action-page-next" aria-label="Next decision" disabled={index >= count - 1} onClick={() => onGo(1, 'next')}><Chevron /></button>
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
    if (count < 2 || e.pointerType === 'mouse' || (e.target as Element).closest?.(OWN_KEYS)) { start.current = null; return; }
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // A clear sideways stroke: a scroll or a tap never pages.
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };
  const onPointerCancel = () => { start.current = null; };
  return { onKeyDown, onPointerDown, onPointerUp, onPointerCancel };
}
