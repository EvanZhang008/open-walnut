import type { Task } from '@open-walnut/core';
import { formatDateDisplay, formatStartDateDisplay } from '@/components/common/DatePicker';

/** The session menu's closed Dates row: the dates that are set, else what it holds. */
export function datesHint(task: Pick<Task, 'start_date' | 'due_date'>): string {
  const parts = [
    task.start_date ? `start ${formatStartDateDisplay(task.start_date)}` : '',
    task.due_date ? `due ${formatDateDisplay(task.due_date)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'start · due';
}
