/**
 * calendar-items — the unified item model every calendar view consumes.
 *
 * Two kinds today (Phase 2 adds external events):
 *   task-start — the task's start_date ("when I begin"); THE draggable chip
 *   task-due   — the task's due_date rendered as a deadline marker; draggable
 *                too (moves due_date). A task with both dates emits both.
 *
 * Scope rule: only a task's OWN dates render here — deliberately NOT the
 * inherited-from-ancestor dates TodoPanel uses for filtering
 * (getEffectiveDateField). Rendering inherited dates would stack N children
 * on the parent's slot, and dragging a child would write a date it never had.
 */
import { useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { dayOf, minutesOfDay, SLOT_MINUTES } from '@/utils/calendar-date';
import type { CalendarEvent } from '@/api/calendar';

export type CalendarItem =
  | {
      kind: 'task-start' | 'task-due';
      /** `${kind}:${task.id}` — unique across kinds for lane layout + React keys. */
      id: string;
      task: Task;
      /** The raw date value this chip represents (start_date or due_date). */
      when: string;
      /** Date-only value → renders in the all-day row / month cell. */
      allDay: boolean;
      day: string;
      /** Minutes since local midnight (0 for allDay). */
      startMin: number;
      /** Visual block length. task-start spans to the task's end_date when set
       *  (same-day); otherwise tasks are point-in-time, one slot tall. */
      endMin: number;
    }
  | {
      kind: 'event';
      id: string;
      event: CalendarEvent;
      when: string;
      allDay: boolean;
      day: string;
      startMin: number;
      endMin: number;
    };

const DONE_PHASES = new Set(['COMPLETE', 'CANCELLED']);

function taskItem(kind: 'task-start' | 'task-due', task: Task, when: string): CalendarItem {
  const allDay = !when.includes('T');
  const startMin = allDay ? 0 : minutesOfDay(when);
  // A start chip with a same-day timed end_date spans start→end like an event;
  // an end on a LATER day clamps to midnight (per-day chip render). Anything
  // else (no end, misordered, all-day) stays the point-in-time single slot.
  let endMin = Math.min(startMin + SLOT_MINUTES, 24 * 60);
  if (kind === 'task-start' && !allDay && task.end_date?.includes('T')) {
    const endsToday = dayOf(task.end_date) === dayOf(when);
    const e = endsToday ? minutesOfDay(task.end_date) : 24 * 60;
    if (dayOf(task.end_date) >= dayOf(when) && (endsToday ? e > startMin : true)) endMin = Math.max(e, startMin + 15);
  }
  return {
    kind,
    id: `${kind}:${task.id}`,
    task,
    when,
    allDay,
    day: dayOf(when),
    startMin,
    endMin,
  };
}

/**
 * Project tasks into calendar items within [from, to] (inclusive day strings).
 * Completed/cancelled tasks are filtered — the calendar shows the plan, not
 * the history (v1 call; revisit with feedback).
 */
export function tasksToCalendarItems(tasks: Task[], from: string, to: string): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const t of tasks) {
    if (DONE_PHASES.has(t.phase)) continue;
    if (t.start_date) {
      const d = dayOf(t.start_date);
      if (d >= from && d <= to) items.push(taskItem('task-start', t, t.start_date));
    }
    if (t.due_date) {
      const d = dayOf(t.due_date);
      if (d >= from && d <= to) items.push(taskItem('task-due', t, t.due_date));
    }
  }
  return items;
}

/** Events → items (Phase 2). Multi-day events are clamped per rendered day by the views. */
export function eventsToCalendarItems(events: CalendarEvent[]): CalendarItem[] {
  return events.map((ev) => {
    const allDay = ev.allDay || !ev.start.includes('T');
    const startMin = allDay ? 0 : minutesOfDay(ev.start);
    const sameDayEnd = dayOf(ev.end || ev.start) === dayOf(ev.start);
    const endMin = allDay
      ? 24 * 60
      : Math.max(startMin + 15, sameDayEnd && ev.end ? minutesOfDay(ev.end) : 24 * 60);
    return {
      kind: 'event' as const,
      id: `event:${ev.id}`,
      event: ev,
      when: ev.start,
      allDay,
      day: dayOf(ev.start),
      startMin,
      endMin,
    };
  });
}

/**
 * Freeze a value while `frozen` is true (returns the last unfrozen snapshot).
 * Same trick as TodoPanel's drag freeze: while a drag is in flight, WS echoes
 * must not reshuffle the chip array under the pointer (React #185 invariant
 * #2 — a mid-drag remount of the dragged node crashes dnd-kit).
 */
export function useFrozenWhile<T>(value: T, frozen: boolean): T {
  const [snapshot, setSnapshot] = useState(value);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  useEffect(() => {
    if (!frozenRef.current) setSnapshot(value);
  }, [value]);
  // Leaving frozen state must resync immediately (value may be stale in state).
  useEffect(() => {
    if (!frozen) setSnapshot(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen]);
  return frozen ? snapshot : value;
}
