/**
 * What a calendar view does to its items: move, copy (Alt-drag), resize, unschedule, edit
 * the time from the popover. One hook for the homepage's day agenda and the /calendar page
 * (each had its own copy of the move math), and each change is one entry on the app's undo
 * stack (TaskUndoContext), so mod+z takes it back and mod+shift+z does it again.
 *
 * Event writes reach the user's real calendar. An event that needs approval (other people on
 * it, or not made by Walnut) asks again for its undo and redo, exactly as for the first write.
 * A copy carries only the calendar, title and times: never the people invited to the
 * original, so copying a meeting can never invite or notify anyone.
 */
import { useMemo, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { useTaskStoreActions } from '@/contexts/TasksContext';
import { useTaskUndo } from '@/undo/TaskUndoContext';
import { useNotifications } from '@/contexts/notifications';
import { parseDateLocal } from '@/components/common/DatePicker';
import { calendarEventNeedsApproval, type CalendarEvent } from '@/api/calendar';
import {
  createCalendarEventOptimistic,
  currentCalendarEvent,
  moveCalendarEvent,
  removeCalendarEvent,
} from '@/stores/calendar-events-store';
import { useCalendarWriteConfirmation } from './calendar-event-actions';
import type { CalendarItem } from './calendar-items';

const pad = (n: number) => String(n).padStart(2, '0');
/** Tz-less local ISO of a date ("2026-11-20T16:00:00"). */
export function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Item ids are "<kind>:<id>"; an event id may itself hold ':', so split on the first one. */
export function splitItemId(itemId: string): { kind: string; id: string } {
  const sep = itemId.indexOf(':');
  return { kind: itemId.slice(0, sep), id: itemId.slice(sep + 1) };
}

/** Where an event lands when dropped at `newWhen`: a timed drop keeps its length (15 min at
 *  least), a date-only drop (the all-day row, a month cell) makes it that day's all-day event. */
export function droppedEventTimes(ev: Pick<CalendarEvent, 'start' | 'end'>, newWhen: string): { start: string; end: string } {
  if (!newWhen.includes('T')) return { start: newWhen, end: newWhen };
  const durMs = Math.max(15 * 60_000, parseDateLocal(ev.end || ev.start).getTime() - parseDateLocal(ev.start).getTime());
  return { start: newWhen, end: localIso(new Date(parseDateLocal(newWhen).getTime() + durMs)) };
}

type TaskWhen = { start_date?: string; end_date?: string; due_date?: string };
type NewEvent = { calendarId: string; title: string; start: string; end: string; allDay: boolean };

/** A task's start moved to `newWhen`: a timed block keeps its length (macOS Calendar); a drop
 *  into the all-day row or a month cell drops the block shape. */
export function droppedTaskPatch(task: Pick<Task, 'start_date' | 'end_date'> | undefined, newWhen: string): TaskWhen {
  const patch: TaskWhen = { start_date: newWhen };
  if (task?.end_date?.includes('T') && task.start_date?.includes('T')) {
    if (newWhen.includes('T')) {
      const durMs = parseDateLocal(task.end_date).getTime() - parseDateLocal(task.start_date).getTime();
      if (durMs > 0) patch.end_date = localIso(new Date(parseDateLocal(newWhen).getTime() + durMs));
    } else {
      patch.end_date = '';
    }
  }
  return patch;
}

const whenOf = (t: Task | undefined, k: keyof TaskWhen) => (t?.[k] as string | undefined) ?? '';
/** Two times the same to the minute (a source may add seconds to what it was sent). */
const sameMinute = (a: string, b: string) => a.slice(0, 16) === b.slice(0, 16);

export interface CalendarItemActions {
  moveItem: (itemId: string, newWhen: string) => void;
  /** Alt-drag: a new event where the copy was dropped; the original stays. Events only. */
  copyItem: (itemId: string, newWhen: string) => void;
  resizeItem: (itemId: string, newEnd: string) => void;
  /** The quick-create popover's Event side. */
  createEvent: (input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) => Promise<CalendarEvent>;
  /** A task dropped from a list onto the grid: its start becomes `when`. */
  scheduleTask: (id: string, when: string) => void;
  unscheduleTask: (item: CalendarItem) => void;
  /** Item-popover save for tasks: newWhen '' clears the chip's date. */
  saveTaskWhen: (item: CalendarItem, newWhen: string, newEnd?: string) => void;
  /** Item-popover save for events; false when the person did not confirm it. */
  saveEvent: (ev: CalendarEvent, patch: { start: string; end: string; title?: string }) => Promise<boolean>;
  /** Deletes reach the real calendar with no undo; false when not confirmed. */
  deleteEvent: (ev: CalendarEvent) => Promise<boolean>;
}

export function useCalendarItemActions(): CalendarItemActions {
  // The writers and a row lookup that reads the row as it is now, subscribing to nothing.
  const store = useTaskStoreActions();
  const undo = useTaskUndo();
  const confirm = useCalendarWriteConfirmation();
  const { notify } = useNotifications();
  const latest = useRef({ store, undo, confirm, notify });
  latest.current = { store, undo, confirm, notify };

  return useMemo(() => {
    let newSeq = 0;
    const row = (id: string) => latest.current.store?.get(id) ?? undefined;
    const update = (id: string, patch: TaskWhen) => latest.current.store?.update(id, patch) ?? Promise.resolve(false);

    // Everything done to one item runs in order: an Undo waits for the write it takes back
    // (a meeting's write waits for the Mac's confirmation, and its answer would otherwise land
    // after the Undo and put it back), and a Redo waits for that Undo. Events share one queue
    // (EVENTS): a copy's removal must not pass a move of that copy still on its way.
    const EVENTS = 'events';
    const queues = new Map<string, Promise<unknown>>();
    const serial = <T,>(key: string, fn: () => T | Promise<T>): Promise<T> => {
      const run = (queues.get(key) ?? Promise.resolve()).then(fn);
      queues.set(key, run.catch(() => {}));
      return run;
    };

    // An event re-created by a Redo (a copy, a new event) has a new id: what was done to the
    // old one is done to its successor.
    const alias = new Map<string, string>();
    const resolve = (id: string) => { let cur = id; for (let i = 0; i < 20 && alias.has(cur); i++) cur = alias.get(cur)!; return cur; };

    /** The Undo found the item changed elsewhere since and left it (replaces the "Undone" line). */
    const sayStale = (title: string, body: string) => latest.current.undo?.notUndone(title, body);

    const taskAt = (id: string, want: TaskWhen) => {
      const cur = row(id);
      return !!cur && (Object.keys(want) as (keyof TaskWhen)[]).every((k) => whenOf(cur, k) === want[k]);
    };

    const writeTask = (id: string, patch: TaskWhen, title: string) => {
      const task = row(id);
      const keys = Object.keys(patch) as (keyof TaskWhen)[];
      const before: TaskWhen = {};
      for (const k of keys) before[k] = whenOf(task, k);
      const key = `cal:task:${id}`;
      const write = serial(key, () => update(id, patch));
      const stack = latest.current.undo;
      if (!stack || !task || keys.every((k) => before[k] === patch[k])) return;
      const withdraw = stack.push({
        key,
        title,
        body: task.title,
        // Only while it is still where this put it: a later change elsewhere is not taken back.
        undo: () => {
          void serial(key, async () => {
            if (!taskAt(id, patch)) { sayStale(title, task.title); return; }
            await update(id, before);
          });
        },
        // Only while it is still where the Undo put it.
        redo: () => serial(key, () => { if (taskAt(id, before)) writeTask(id, patch, title); }),
      });
      void write.then((ok) => { if (ok === false) withdraw(); }, withdraw);
    };

    type EventFields = { start: string; end: string; title?: string };
    const eventAt = (ev: CalendarEvent | undefined, want: EventFields) =>
      !!ev && sameMinute(ev.start, want.start) && sameMinute(ev.end, want.end) && (want.title === undefined || ev.title === want.title);

    /** Write an event's times (and title); `expect`: only if it is still there (a Redo). */
    const writeEvent = (id0: string, next: EventFields, title: string, expect?: EventFields): Promise<boolean> => {
      const key = `cal:event:${resolve(id0)}`;
      return serial(EVENTS, async () => {
        const id = resolve(id0);
        const ev = currentCalendarEvent(id);
        if (!ev || (expect && !eventAt(ev, expect))) return false;
        if (!(await latest.current.confirm(ev, 'update'))) return false;
        const before: EventFields = { start: ev.start, end: ev.end, ...(next.title !== undefined ? { title: ev.title } : {}) };
        if (eventAt(ev, next)) return true;
        const write = moveCalendarEvent(id, { ...next, human_confirm: calendarEventNeedsApproval(ev) });
        const stack = latest.current.undo;
        if (stack) {
          const withdraw = stack.push({
            key,
            title,
            body: ev.title,
            undo: () => {
              void serial(EVENTS, async () => {
                if (!(await write)) return; // refused: it never moved
                const cur = currentCalendarEvent(resolve(id));
                if (!cur || !eventAt(cur, next)) { sayStale(title, ev.title); return; }
                if (!(await latest.current.confirm(cur, 'update'))) return;
                await moveCalendarEvent(cur.id, { ...before, human_confirm: calendarEventNeedsApproval(cur) });
              });
            },
            redo: () => writeEvent(id, next, title, before),
          });
          void write.then((ok) => { if (!ok) withdraw(); });
        }
        await write;
        return true;
      });
    };

    const removeCreated = async (ev: CalendarEvent) => {
      const cur = currentCalendarEvent(resolve(ev.id)) ?? ev;
      const needsApproval = calendarEventNeedsApproval(cur);
      if (needsApproval && !(await latest.current.confirm(cur, 'delete'))) return;
      await removeCalendarEvent(cur.id, needsApproval);
    };

    /** A new event (a copy, or one made in the quick-create popover); its Undo removes it, and
     *  its Redo makes it again (`replaces`: the one the Redo stands in for). */
    const createUndoable = (input: NewEvent, key: string, title: string, sayFailure: boolean, replaces?: Promise<CalendarEvent>): Promise<CalendarEvent> => {
      const created = createCalendarEventOptimistic(input);
      if (replaces) void Promise.all([replaces, created]).then(([old, now]) => { alias.set(old.id, now.id); }, () => {});
      const withdraw = latest.current.undo?.push({
        key,
        title,
        body: input.title,
        // An Undo before the event is written waits for it, then removes it.
        undo: () => { void serial(EVENTS, async () => { const ev = await created.catch(() => null); if (ev) await removeCreated(ev); }); },
        redo: () => serial(EVENTS, () => { void createUndoable(input, key, title, true, created).catch(() => {}); }),
      });
      void serial(EVENTS, () => created.catch(() => null));
      created.catch((err: unknown) => {
        withdraw?.();
        if (!sayFailure) return;
        latest.current.notify({
          kind: 'operation-error', severity: 'error', persistent: false, dedupKey: `calendar-create:${key}`,
          title: 'Could not create event', body: String((err as Error)?.message ?? err).slice(0, 400),
        });
      });
      return created;
    };

    const actions: CalendarItemActions = {
      moveItem: (itemId, newWhen) => {
        const { kind, id } = splitItemId(itemId);
        if (kind === 'task-start') writeTask(id, droppedTaskPatch(row(id), newWhen), 'Task moved');
        else if (kind === 'task-due') writeTask(id, { due_date: newWhen }, 'Deadline moved');
        else if (kind === 'event') {
          const ev = currentCalendarEvent(id);
          if (ev) void writeEvent(id, droppedEventTimes(ev, newWhen), 'Event moved');
        }
      },
      copyItem: (itemId, newWhen) => {
        const { kind, id } = splitItemId(itemId);
        const src = kind === 'event' ? currentCalendarEvent(id) : undefined;
        if (!src || src.readonly) return;
        // Calendar, title and times only: no attendees, so nobody is invited or told.
        void createUndoable({ calendarId: src.calendarId, title: src.title, ...droppedEventTimes(src, newWhen), allDay: !newWhen.includes('T') },
          `cal:new:${++newSeq}`, 'Event copied', true).catch(() => {});
      },
      // The popover shows its own error, so a refused create is not said twice.
      createEvent: (input) => createUndoable({ ...input, allDay: !!input.allDay }, `cal:new:${++newSeq}`, 'Event created', false),
      scheduleTask: (id, when) => writeTask(id, { start_date: when }, 'Task scheduled'),
      resizeItem: (itemId, newEnd) => {
        const { kind, id } = splitItemId(itemId);
        if (kind === 'task-start') writeTask(id, { end_date: newEnd }, 'Task resized');
        else if (kind === 'event') {
          const ev = currentCalendarEvent(id);
          if (ev) void writeEvent(id, { start: ev.start, end: newEnd }, 'Event resized');
        }
      },
      unscheduleTask: (item) => {
        if (item.kind === 'event') return;
        // Unscheduling the start also clears end_date: a dangling end without a start means nothing.
        if (item.kind === 'task-due') writeTask(item.task.id, { due_date: '' }, 'Deadline cleared');
        else writeTask(item.task.id, { start_date: '', ...(item.task.end_date ? { end_date: '' } : {}) }, 'Task unscheduled');
      },
      saveTaskWhen: (item, newWhen, newEnd) => {
        if (item.kind === 'event') return;
        if (item.kind === 'task-due') writeTask(item.task.id, { due_date: newWhen }, 'Deadline changed');
        else writeTask(item.task.id, { start_date: newWhen, ...(newEnd !== undefined ? { end_date: newEnd } : {}) }, 'Task time changed');
      },
      saveEvent: (ev, patch) => writeEvent(ev.id, patch, 'Event changed'),
      deleteEvent: async (ev) => {
        if (!(await latest.current.confirm(ev, 'delete'))) return false;
        void removeCalendarEvent(ev.id, calendarEventNeedsApproval(ev));
        return true;
      },
    };
    return actions;
  }, []);
}
