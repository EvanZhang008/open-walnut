/**
 * A task row's start and due pills ("→ 2h", "Overdue"). They read the shared minute clock
 * themselves, so a start time arriving or a due time passing redraws these two pills and never the
 * row around them (minute-clock.ts; 2026-11-23, task 9bceb9f2: the memoized row read the time once
 * at its render, so its pills went stale until something else drew it).
 */
import { useMinuteValue } from '@/utils/minute-clock';
import { badge } from '@/components/common/badge';
import * as ICONS from '../common/Icons';
import { formatDateDisplay, isOverdue, parseDateLocal } from '../common/DatePicker';

/** What the pills show at `now`, as one primitive (so an unchanged minute draws nothing). */
export function datePillWords(startDate: string | undefined, dueDate: string | undefined, now: number): string {
  // Start pill only while the task is still deferred (future start). Deliberately the task's OWN
  // start_date, not the parent-inherited start of the Now filter: the pill marks where the defer was set.
  const startMs = startDate ? parseDateLocal(startDate).getTime() : NaN;
  const start = Number.isFinite(startMs) && startMs > now ? formatDateDisplay(startDate, now) : '';
  const due = formatDateDisplay(dueDate, now);
  return `${start}\n${due}\n${isOverdue(dueDate, now) ? 1 : 0}`;
}

export function TaskDatePills({ startDate, dueDate }: { startDate?: string; dueDate?: string }) {
  const words = useMinuteValue((now) => datePillWords(startDate, dueDate, now), !!(startDate || dueDate));
  const [start, due, overdue] = words.split('\n');
  return (
    <>
      {start && (
        <span className="badge badge-long todo-item-due-pill todo-item-start-pill" title={`Starts: ${startDate}`}>
          <span className="todo-item-start-icon" aria-hidden="true">{ICONS.ICON_ARROW_RIGHT}</span><span>{start}</span>
        </span>
      )}
      {due && (
        <span className={`${badge(overdue === '1' ? 'error' : 'neutral', { long: true })} todo-item-due-pill`} title={dueDate ? `Due: ${dueDate}` : undefined}>
          <span>{due}</span>
        </span>
      )}
    </>
  );
}
