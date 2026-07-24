/**
 * DatePicker — quick-pill + calendar date picker for tasks.
 *
 * Two modes:
 *   inline=true  → renders content directly (for kebab menu embedding)
 *   inline=false → popover triggered by a pill button (for detail panes)
 */

import { useState, useRef, useEffect, useCallback } from 'react';

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
}

/** Inner content shared by popover and inline modes. */
function DatePickerContent({ date, onChange }: Pick<DatePickerProps, 'date' | 'onChange'>) {
  // Convert current date to YYYY-MM-DD for the input
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

  const handleCalendarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) { onChange(null); return; }
    onChange(val);
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
            title="Clear date"
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
      {/* Day-of-week pills: Mon … Sun (tomorrow → +7d) */}
      <div className="dp-pills">
        {dayPills.map((p) => (
          <button
            key={p.date}
            className="dp-pill"
            onClick={(e) => { e.stopPropagation(); onChange(p.date); }}
            title={p.date}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="dp-calendar-row">
        <input
          type="date"
          className="dp-date-input"
          value={inputValue}
          onChange={handleCalendarChange}
          onClick={(e) => e.stopPropagation()}
        />
        {date && (
          <button
            className="dp-clear"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            title="Clear date"
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );
}

export function DatePicker({ date, onChange, inline }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const handleScroll = () => close();
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [open, close]);

  // Inline mode: render content directly
  if (inline) {
    return <DatePickerContent date={date} onChange={onChange} />;
  }

  // Popover mode
  const display = formatDateDisplay(date);
  const overdue = isOverdue(date);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
    }
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
        className={`dp-trigger${overdue ? ' dp-trigger-overdue' : ''}${display ? ' dp-trigger-has-date' : ''}`}
        onClick={handleToggle}
        title={date ? `Date: ${date}` : 'Set date'}
      >
        {display || 'Date'}
      </button>
      {open && (
        <div
          ref={menuRef}
          className="dp-popover"
          style={menuPos ? { position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 } : undefined}
        >
          <DatePickerContent date={date} onChange={handleChange} />
        </div>
      )}
    </div>
  );
}
