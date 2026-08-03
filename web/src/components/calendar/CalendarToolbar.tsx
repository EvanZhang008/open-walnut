import { memo } from 'react';
import { addDays, formatDateOnly, weekRange } from '@/utils/calendar-date';

export type CalendarViewKind = 'day' | 'week' | 'month';

interface Props {
  view: CalendarViewKind;
  anchor: Date;
  onViewChange: (view: CalendarViewKind) => void;
  onAnchorChange: (day: string) => void;
  /** Rail visibility toggle (week/day views' unscheduled-task list). */
  railOpen: boolean;
  onToggleRail: () => void;
  /** Opens the in-view calendar visibility popover, anchored to the button. */
  onOpenCalendars?: (anchorEl: HTMLElement) => void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function title(view: CalendarViewKind, anchor: Date): string {
  if (view === 'month') return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  if (view === 'day') {
    return `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`;
  }
  const days = weekRange(anchor);
  const [a, b] = [days[0], days[6]];
  const ma = MONTHS[a.getMonth()].slice(0, 3);
  const mb = MONTHS[b.getMonth()].slice(0, 3);
  if (a.getMonth() === b.getMonth()) return `${ma} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`;
  return `${ma} ${a.getDate()} – ${mb} ${b.getDate()}, ${b.getFullYear()}`;
}

const STEP: Record<CalendarViewKind, number> = { day: 1, week: 7, month: 0 };

export const CalendarToolbar = memo(function CalendarToolbar({
  view,
  anchor,
  onViewChange,
  onAnchorChange,
  railOpen,
  onToggleRail,
  onOpenCalendars,
}: Props) {
  const step = (dir: 1 | -1) => {
    const next =
      view === 'month'
        ? new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1)
        : addDays(anchor, STEP[view] * dir);
    onAnchorChange(formatDateOnly(next));
  };

  return (
    <div className="cal-toolbar">
      <div className="cal-toolbar-left">
        <button
          className={`cal-rail-toggle${railOpen ? ' active' : ''}`}
          onClick={onToggleRail}
          title={railOpen ? 'Hide task list' : 'Show task list'}
          aria-label={railOpen ? 'Hide task list' : 'Show task list'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="4" width="7" height="16" rx="1.5" />
            <line x1="14" y1="7" x2="21" y2="7" />
            <line x1="14" y1="12" x2="21" y2="12" />
            <line x1="14" y1="17" x2="21" y2="17" />
          </svg>
        </button>
        <button className="cal-today-btn" onClick={() => onAnchorChange(formatDateOnly(new Date()))}>
          Today
        </button>
        <div className="cal-nav-btns">
          <button onClick={() => step(-1)} aria-label="Previous" title="Previous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button onClick={() => step(1)} aria-label="Next" title="Next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
        <h2 className="cal-title">{title(view, anchor)}</h2>
      </div>
      <div className="cal-toolbar-right">
        {onOpenCalendars && (
          <button
            className="cal-cals-btn"
            onClick={(e) => onOpenCalendars(e.currentTarget)}
            title="Choose which calendars to show"
            data-testid="cal-cals-btn"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <circle cx="8.5" cy="14" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="15.5" cy="14" r="1.4" fill="currentColor" stroke="none" />
            </svg>
            Calendars
          </button>
        )}
        <div className="cal-view-switch" role="tablist" aria-label="Calendar view">
          {(['day', 'week', 'month'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`cal-view-btn${view === v ? ' active' : ''}`}
              onClick={() => onViewChange(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
