/**
 * A month of days to pick one from: Walnut's own calendar for DatePicker (2026-10-31, the user,
 * on the snooze menu's native date field: use Walnut's own picker). A native <input type="date">
 * draws the browser's own field (a "10/31/2026" box, each engine its own popup), so the picker
 * never uses one. No title tooltips either: each day says its date to a screen reader instead.
 */
import { useState } from 'react';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The local calendar day as YYYY-MM-DD. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The weeks of one month, Sunday first; a day outside the month is null. */
export function monthWeeks(year: number, month: number): (Date | null)[][] {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array<null>(first).fill(null)];
  for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function MonthGrid({ selected, onPick, min, now = new Date() }: {
  /** The picked day (YYYY-MM-DD), if any: the grid opens on its month. */
  selected: string;
  /** The first day that can be picked (YYYY-MM-DD); the ones before it are drawn, not offered. */
  min?: string;
  onPick: (day: string) => void;
  now?: Date;
}) {
  const start = selected ? new Date(Number(selected.slice(0, 4)), Number(selected.slice(5, 7)) - 1, 1) : now;
  const [view, setView] = useState({ y: start.getFullYear(), m: start.getMonth() });
  const today = isoDay(now);
  const step = (by: number) => setView(({ y, m }) => {
    const d = new Date(y, m + by, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  return (
    <div className="dp-month" data-testid="dp-month" data-month={`${view.y}-${String(view.m + 1).padStart(2, '0')}`}>
      <div className="dp-month-head">
        <button type="button" className="dp-month-step" data-testid="dp-month-prev" aria-label="Previous month" onClick={(e) => { e.stopPropagation(); step(-1); }}>‹</button>
        <span className="dp-month-name" aria-live="polite">{MONTHS[view.m]} {view.y}</span>
        <button type="button" className="dp-month-step" data-testid="dp-month-next" aria-label="Next month" onClick={(e) => { e.stopPropagation(); step(1); }}>›</button>
      </div>
      <div className="dp-month-grid" role="grid" aria-label={`${MONTHS[view.m]} ${view.y}`}>
        <div className="dp-month-row" role="row">
          {WEEKDAYS.map((w) => <span key={w} className="dp-month-dow" role="columnheader">{w}</span>)}
        </div>
        {monthWeeks(view.y, view.m).map((week, i) => (
          <div key={i} className="dp-month-row" role="row">
            {week.map((d, j) => {
              if (!d) return <span key={j} className="dp-month-day is-blank" role="gridcell" />;
              const day = isoDay(d);
              const cls = `dp-month-day${day === selected ? ' is-selected' : ''}${day === today ? ' is-today' : ''}${day < today ? ' is-past' : ''}`;
              const off = !!min && day < min;
              return (
                <span key={j} role="gridcell">
                  <button
                    type="button"
                    className={cls}
                    data-testid="dp-month-day"
                    data-date={day}
                    aria-label={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    aria-pressed={day === selected}
                    disabled={off}
                    onClick={(e) => { e.stopPropagation(); onPick(day); }}
                  >{d.getDate()}</button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
