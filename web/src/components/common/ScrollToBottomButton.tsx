/**
 * The one button that takes a scrolled view back to its end: a frosted-glass circle with a down
 * arrow, centred at the bottom of its scroller (styles/scroll-jump.css). A session's timeline, a
 * letter's thread and every other scroller that offers a jump to the latest render this, never a
 * button of their own (tests/web/scroll-jump-button-guard.test.ts fails on a second one).
 *
 * Rendered inside the scroller (a flex column) it rides sticky at the bottom; `seated` is for a
 * place that positions it itself. `badge` is a small count of rows that arrived below.
 */
import { forwardRef, type ReactNode } from 'react';
import '@/styles/scroll-jump.css';

const ARROW_DOWN = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3v9.5M3.75 8.25L8 12.5l4.25-4.25" />
  </svg>
);

export interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
  /** The accessible name; the button shows only the arrow. */
  label?: string;
  /** A small count beside the arrow (rows that arrived below), or nothing. */
  badge?: ReactNode;
  /** The place positions the button itself (an absolute seat), instead of sticky in its scroller. */
  seated?: boolean;
  testId?: string;
}

export const ScrollToBottomButton = forwardRef<HTMLButtonElement, ScrollToBottomButtonProps>(function ScrollToBottomButton(
  { visible, onClick, label = 'Scroll to bottom', badge, seated, testId },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`scroll-to-bottom-btn wn-glass-frost${visible ? ' visible' : ''}${seated ? ' is-seated' : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
      tabIndex={visible ? 0 : -1}
      aria-hidden={visible ? undefined : true}
      data-testid={testId}
    >
      {ARROW_DOWN}
      {badge != null && badge !== false && <span className="scroll-to-bottom-badge" aria-hidden="true">{badge}</span>}
    </button>
  );
});
