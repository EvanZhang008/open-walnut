/**
 * KebabGroup — one collapsed row of the session ⋮ menu that opens its rows in place
 * (2026-10-27, the user's pick of the menu redesign, "group by object"): Dates, Move &
 * team, Views, Copy & open, Debug, Details. The menu had grown to 27 rows; each group keeps its
 * rows one click away, the way the Status and Start / Due rows already open.
 *
 * Every group's content is a short, fixed list (no async rows), so it expands inline;
 * the menu's own placement scrolls it when the window is short.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CHEVRON_GLYPH } from '@/components/common/Icons';
import '@/styles/session-kebab-groups.css';

export function KebabGroup({ label, hint, icon, badge, testId, children }: {
  label: string;
  /** What the group holds, shown on the closed row ("code · web · notes"). */
  hint?: string;
  icon: ReactNode;
  /** A count that must be seen without opening the group (work still running). */
  badge?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // In a menu short enough to scroll, a group near the foot opens below the fold:
  // bring its rows into view so the click visibly did something.
  useEffect(() => {
    if (open) bodyRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  return (
    <div className={`task-kebab-group${open ? ' open' : ''}`} data-testid={testId}>
      <button
        type="button"
        className="task-kebab-item task-kebab-group-toggle"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <span className="task-kebab-icon">{icon}</span>
        {/* The hint shows only on the closed row; the open rows say it themselves. */}
        <span className={`task-kebab-group-label${!open && hint ? ' with-hint' : ''}`}>{label}</span>
        {!open && hint && <span className="task-kebab-group-hint" aria-hidden="true">{hint}</span>}
        {/* Open, the row inside carries the same count. */}
        {!open && badge}
        <span className={`task-kebab-status-caret${open ? ' open' : ''}`} aria-hidden="true">{CHEVRON_GLYPH}</span>
      </button>
      {open && <div ref={bodyRef} className="task-kebab-group-body" role="group" aria-label={label}>{children}</div>}
    </div>
  );
}
