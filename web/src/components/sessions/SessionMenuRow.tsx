/**
 * One row of the session menu, and the drawn icons of its view rows: the desktop session menu
 * (SessionMenuOpen) and the phone's top-bar menu (PhoneSessionHeaderRows) draw the same rows with
 * this one component, so a row is one drawn icon and one line of words on both (standard.md,
 * Big menus; 2026-11-26: the phone's copy of this row drew its words with no icon).
 */
import type { MouseEvent, ReactNode } from 'react';

const svg = (children: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const BOARD_ICON = svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16M15 4v16" /></>);
export const THREADS_ICON = svg(<><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>);
export const PLAN_ICON = svg(<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />);
export const WEB_ICON = svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" /></>);
export const APPS_ICON = svg(<><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 8v8M8 12h8" /></>);
/** Fork: a branch leaving the line. */
export const FORK_ICON = svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-12 3-12 8" /></>);
export const BACKGROUND_TASKS_ICON = svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M12.5 15H17" /></>);

export function SessionMenuRow({ icon, label, active, disabled, why, onClick, testId, trailing, className, role }: {
  icon: ReactNode; label: string; active?: boolean; disabled?: boolean; why?: string;
  onClick: (e: MouseEvent) => void; testId?: string; trailing?: ReactNode;
  /** A surface's own row class (the phone's 44 px row). */
  className?: string;
  role?: 'menuitem';
}) {
  return (
    <button
      type="button"
      role={role}
      className={`task-kebab-item${active ? ' task-kebab-item-active' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={active || undefined}
      disabled={disabled}
      title={disabled ? why : undefined}
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
    >
      <span className="task-kebab-icon">{icon}</span>
      <span>{label}</span>
      {disabled && why && <span className="task-kebab-row-why">{why}</span>}
      {trailing}
    </button>
  );
}
