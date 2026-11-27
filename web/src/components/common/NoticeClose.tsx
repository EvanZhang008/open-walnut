/**
 * The one × of every card and notice (2026-11-22, the user, of a card he could not get rid of: "why
 * there is no x so that i cna close"; the standing rule: every card or notice in front of him has a
 * visible close). NoticeCard draws it at the end of its title row; a banner, an ask card or a line
 * of its own puts this same button where its title row ends. The family's quiet icon square
 * (buttons.css), never a button of its own, drawing the one close icon of every dialog too (ICON_CLOSE:
 * an icon, so the ×'s glyph never joins the notice's text). tests/web/notice-close-guard.test.ts holds every card
 * and notice to it.
 */
import type { MouseEvent } from 'react';
import { ICON_CLOSE } from './Icons';
import '@/styles/notice-close.css';

export function NoticeClose({ onClose, label = 'Dismiss', testId, className, disabled = false }: {
  onClose: () => void;
  /** What it says to a screen reader (no hover title: a row's words keep the only tooltip): what closing does when that is not plain
   *  ("Hide this banner", "Hide: the request stays in the notification center"). */
  label?: string;
  testId?: string;
  className?: string;
  /** While the notice's own work runs (a switch, an install): it stays in the Tab order and says it
   *  is off (aria-disabled, the family's dimmed look), and a click does nothing. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      // WebKit leaves a button out of the Tab order unless it says so (the Mac app's web view).
      tabIndex={0}
      className={`btn btn-ghost btn-icon btn-sm wn-notice-close${className ? ` ${className}` : ''}`}
      aria-label={label}
      data-testid={testId}
      aria-disabled={disabled || undefined}
      onClick={(e: MouseEvent) => { e.stopPropagation(); if (!disabled) onClose(); }}
    >
      {ICON_CLOSE}
    </button>
  );
}
