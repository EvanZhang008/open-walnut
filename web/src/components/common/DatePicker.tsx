/**
 * DatePicker — quick-pill + calendar date picker for tasks.
 *
 * Two modes:
 *   inline=true  → renders content directly (for kebab menu embedding)
 *   inline=false → popover triggered by a pill button (for detail panes)
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { MonthGrid } from './MonthGrid';

/**
 * Parse an ISO date string as local time.
 * Date-only strings ("YYYY-MM-DD") are parsed as UTC midnight by the JS spec,
 * which shifts the date backwards in UTC-negative timezones. This helper splits
 * the string and constructs a Date at LOCAL midnight, avoiding the mismatch.
 * Datetime strings (containing 'T') are passed through to `new Date()` as-is.
 */
export function parseDateLocal(iso: string): Date {
  if (iso.includes('T')) return new Date(iso);
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Time-level quick pills (relative to now)
const TIME_PILLS: { label: string; ms: number }[] = [
  { label: '30m', ms: 30 * 60_000 },
  { label: '2h',  ms: 2 * 3_600_000 },
  { label: '4h',  ms: 4 * 3_600_000 },
  { label: '8h',  ms: 8 * 3_600_000 },
];

/** Tomorrow's quick times (2026-11-11, the user: "snooze until should have more options, like
 *  tomorrow 8am, 12pm, 6pm"): local wall-clock hours, so a DST change tonight still lands on 8:00. */
const TOMORROW_HOURS: { label: string; hour: number }[] = [
  { label: '8 AM', hour: 8 },
  { label: '12 PM', hour: 12 },
  { label: '6 PM', hour: 18 },
];

/** Tomorrow at 8:00, 12:00 and 18:00 local time, as ISO instants. */
export function tomorrowTimePills(nowMs = Date.now()): { label: string; date: string }[] {
  const now = new Date(nowMs);
  return TOMORROW_HOURS.map(({ label, hour }) => ({
    label,
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour).toISOString(),
  }));
}

// Day-of-week abbreviations (0=Sun … 6=Sat)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Build 7 day-of-week pills starting from tomorrow (+1d … +7d). */
function buildDayPills(): { label: string; date: string }[] {
  const now = new Date();
  const pills: { label: string; date: string }[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    pills.push({ label: DOW[d.getDay()], date: `${y}-${m}-${day}` });
  }
  return pills;
}

/** Format a due_date value for display. */
export function formatDateDisplay(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = parseDateLocal(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();

  // Time-level dates (contains 'T'): show relative
  if (iso.includes('T')) {
    const diffMs = d.getTime() - now.getTime();
    if (diffMs < 0) return 'Overdue';
    if (diffMs < 60_000) return '<1m';
    if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m`;
    if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h`;
  }

  // Day-level
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((dueDay.getTime() - todayStart.getTime()) / 86_400_000);
  if (diffDays < 0) return 'Overdue';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Format a due_date for confirmation contexts (e.g. Quick Task chips) —
 * absolute clock time with a friendly day name, so the user can verify what
 * the AI actually understood ("Tomorrow 10:00", not "19h").
 */
export function formatDateTimeDisplay(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = parseDateLocal(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((dueDay.getTime() - todayStart.getTime()) / 86_400_000);
  const day =
    diffDays === 0 ? 'Today'
    : diffDays === 1 ? 'Tomorrow'
    : diffDays > 1 && diffDays <= 7 ? DOW[d.getDay()]
    : `${d.getMonth() + 1}/${d.getDate()}`;
  if (!iso.includes('T')) return day;
  return `${day} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Format a start_date for display. Same buckets as formatDateDisplay, except a
 * past start is "Started", never "Overdue" — a passed start means "work on it
 * now", not "late" (only due dates can be late).
 */
export function formatStartDateDisplay(iso: string | undefined | null): string {
  if (!iso) return '';
  const s = formatDateDisplay(iso);
  return s === 'Overdue' ? 'Started' : s;
}

/** Check if a due_date is overdue. */
export function isOverdue(iso: string | undefined | null): boolean {
  if (!iso) return false;
  const d = parseDateLocal(iso);
  if (isNaN(d.getTime())) return false;
  if (iso.includes('T')) return d.getTime() < Date.now();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() < todayStart.getTime();
}

interface DatePickerProps {
  /** Current due_date value (ISO string or undefined). */
  date: string | undefined | null;
  /** Called with new ISO date string, or null to clear. */
  onChange: (date: string | null) => void;
  /** Render content directly instead of inside a popover. */
  inline?: boolean;
  /** Trigger-pill label when no date is set, and prefix when set
   *  (e.g. "Start" → "Start 8h"). Default: "Date" / bare value. */
  label?: string;
  /** Calendar-style secondary date (the due/end date is usually empty): when no
   *  date is set, render a low-key "+ <label>" ghost instead of a full labeled
   *  pill. The picker stays one click away; once a date is set the pill renders
   *  normally. */
  ghostWhenEmpty?: boolean;
  /** For a row that already says what the date is ("Start", "Due" in a facts rail):
   *  the trigger shows the date alone, or a muted "Set date" while empty. `label`
   *  still decides the semantics (a passed Start reads "Started", never overdue). */
  bare?: boolean;
  /** The first day the month offers (YYYY-MM-DD): a snooze cannot start in the past. */
  minDate?: string;
  /** Offer a "Tomorrow 8 AM / 12 PM / 6 PM" row (the snooze pickers). */
  tomorrowTimes?: boolean;
}

/** Inner content shared by popover and inline modes. */
function DatePickerContent({ date, onChange, minDate, tomorrowTimes }: Pick<DatePickerProps, 'date' | 'onChange' | 'minDate' | 'tomorrowTimes'>) {
  // The current date as YYYY-MM-DD, the day the month marks
  const inputValue = date ? (() => {
    const d = parseDateLocal(date);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })() : '';

  const handleTimePick = (ms: number) => {
    onChange(new Date(Date.now() + ms).toISOString());
  };

  const dayPills = buildDayPills();

  return (
    <div className="dp-content">
      {/* Time-level pills: None (if set), 30m, 2h, 4h, 8h */}
      <div className="dp-pills">
        {date && (
          <button
            className="dp-pill dp-pill-none"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            aria-label="Clear date"
          >
            None
          </button>
        )}
        {TIME_PILLS.map((p) => (
          <button
            key={p.label}
            className="dp-pill"
            onClick={(e) => { e.stopPropagation(); handleTimePick(p.ms); }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {tomorrowTimes && (
        <div className="dp-pills dp-pills-tomorrow" role="group" aria-label="Tomorrow at">
          <span className="dp-pills-label">Tomorrow</span>
          {tomorrowTimePills().map((p) => (
            <button
              key={p.label}
              className="dp-pill"
              onClick={(e) => { e.stopPropagation(); onChange(p.date); }}
              aria-label={`Tomorrow ${p.label}`}
              data-tomorrow={p.label}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {/* Day-of-week pills: Mon … Sun (tomorrow → +7d) */}
      <div className="dp-pills">
        {dayPills.map((p) => (
          <button
            key={p.date}
            className="dp-pill"
            onClick={(e) => { e.stopPropagation(); onChange(p.date); }}
            data-date={p.date}
          >
            {p.label}
          </button>
        ))}
      </div>
      {/* Walnut's own month, never the browser's date field (MonthGrid). None above clears. */}
      <MonthGrid selected={inputValue} onPick={onChange} {...(minDate ? { min: minDate } : {})} />
    </div>
  );
}

export function DatePicker({ date, onChange, inline, label, ghostWhenEmpty, bare, minDate, tomorrowTimes }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Same class of bug as the kebab menu: this popover holds a ~250px calendar and
  // used to place itself at `rect.bottom + 2` with no flip, no clamp and no height
  // cap, so opening it near the bottom of a short window pushed the day grid off
  // screen unreachably. Hooks must run before the `inline` early-return below.
  const menuPos = useMenuPlacement(open, btnRef, menuRef);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    // Escape closes the picker alone. On window in the capture phase it runs before
    // the bubble-phase listener of a popup under the picker (useModalOverlay, the task
    // details), which would otherwise close the whole popup on the same key.
    // preventDefault first: the beep guard reads the stop (see useModalOverlay).
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    // A scroll inside the popover (the calendar can scroll when capped) must not
    // dismiss it; outside, useMenuPlacement keeps it glued to the trigger until
    // the trigger itself leaves the viewport.
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      const r = btnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) close();
    };
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, close]);

  // Inline mode: render content directly
  if (inline) {
    return <DatePickerContent date={date} onChange={onChange} minDate={minDate} tomorrowTimes={tomorrowTimes} />;
  }

  // Popover mode. Start pickers must never show red "Overdue" — a passed start
  // means "active now", so it renders as "Started" with no error styling.
  const isStart = label === 'Start';
  const display = isStart ? formatStartDateDisplay(date) : formatDateDisplay(date);
  const overdue = !isStart && isOverdue(date);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(!open);
  };

  const handleChange = (v: string | null) => {
    onChange(v);
    close();
  };

  return (
    <div className="dp-wrapper" ref={wrapperRef}>
      <button
        ref={btnRef}
        className={`dp-trigger${overdue ? ' dp-trigger-overdue' : ''}${display ? ' dp-trigger-has-date' : ''}${!display && (ghostWhenEmpty || bare) ? ' dp-trigger-ghost' : ''}${bare ? ' dp-trigger-bare' : ''}`}
        onClick={handleToggle}
        title={date ? `${label ?? 'Date'}: ${date}` : `Set ${(label ?? 'date').toLowerCase()}`}
      >
        {bare
          ? (display || 'Set date')
          : display
            ? (label ? `${label} ${display}` : display)
            : (ghostWhenEmpty ? `+ ${label ?? 'Date'}` : (label ?? 'Date'))}
      </button>
      {/* Portalled for the same reason as the kebab menus: `position: fixed`
          escapes clipping ancestors but not stacking contexts, and this pill can
          sit inside z-indexed panels. */}
      {open && createPortal(
        <div
          ref={menuRef}
          className="dp-popover"
          style={menuPlacementStyle(menuPos)}
        >
          <DatePickerContent date={date} onChange={handleChange} minDate={minDate} tomorrowTimes={tomorrowTimes} />
        </div>,
        document.body,
      )}
    </div>
  );
}
