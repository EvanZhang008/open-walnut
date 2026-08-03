/**
 * QuickCreatePopover — clicking/drag-selecting empty calendar space opens
 * this portal-anchored creator: a Task tab (QuickTaskComposer with the slot's
 * dates pre-seeded) and an Event tab (title + target calendar → EventKit
 * write-back, shown only when a writable calendar source is connected).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useTasksContext } from '@/contexts/TasksContext';
import { QuickTaskComposer } from '@/components/tasks/QuickTaskComposer';
import type { CreateTaskInput } from '@/api/tasks';
import { listCalendarSources, type CalendarInfo } from '@/api/calendar';

export interface CreateSeed {
  /** Slot's date ("YYYY-MM-DD") or datetime ("…T09:00:00"). */
  start: string;
  /** Present when the user drag-selected a range. */
  end?: string;
  /** Element to anchor the popover to (small anchors: month cells, all-day cells). */
  anchorEl?: HTMLElement;
  /**
   * Pointer coords to anchor to instead — REQUIRED for time-grid slots: the
   * column element is a day tall, so an element anchor would place the popover
   * at the column's bottom, far from the clicked slot (and off screen).
   */
  anchorPoint?: { x: number; y: number };
  /** Open on this tab (context menu's "New event…" goes straight to Event). */
  tab?: 'task' | 'event';
}

interface Props {
  seed: CreateSeed;
  onClose: () => void;
  onCreateTask: (input: CreateTaskInput) => Promise<Task>;
  /** Present when the calendar source is writable — enables the Event tab. */
  onCreateEvent?: (input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) => Promise<unknown>;
}

export function QuickCreatePopover({ seed, onClose, onCreateTask, onCreateEvent }: Props) {
  const { tasks, star } = useTasksContext();
  const anchorRef = useRef<HTMLElement | null>(seed.anchorEl ?? null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef, {
    anchorPoint: seed.anchorPoint ?? null,
  });
  const [tab, setTab] = useState<'task' | 'event'>(seed.tab && onCreateEvent ? seed.tab : 'task');

  const projectOptions = useMemo(() => {
    const options = new Map<string, Set<string>>();
    for (const task of tasks) {
      if (task.title.startsWith('.metadata') || task.project === task.category) continue;
      let projects = options.get(task.category);
      if (!projects) {
        projects = new Set();
        options.set(task.category, projects);
      }
      projects.add(task.project);
    }
    return Object.fromEntries(
      [...options.entries()].map(([category, projects]) => [category, [...projects].sort((a, b) => a.localeCompare(b))])
    );
  }, [tasks]);

  const initialDates = useMemo(
    () => ({ start: seed.start, due: seed.end }),
    [seed.start, seed.end]
  );

  return createPortal(
    <>
      <div className="cal-popover-backdrop" onClick={onClose} />
      <div className="cal-create-popover" ref={menuRef} style={menuPlacementStyle(placement)}>
        {onCreateEvent && (
          <div className="cal-create-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'task'} className={tab === 'task' ? 'active' : ''} onClick={() => setTab('task')}>
              Task
            </button>
            <button role="tab" aria-selected={tab === 'event'} className={tab === 'event' ? 'active' : ''} onClick={() => setTab('event')}>
              Event
            </button>
          </div>
        )}
        {tab === 'task' ? (
          <QuickTaskComposer
            open
            onClose={onClose}
            projectOptions={projectOptions}
            initialDates={initialDates}
            onCreate={async (input) => {
              // pinnedTier needs the Focus Bar plumbing MainPage owns — out of
              // scope on the calendar; starred still applies post-create.
              const task = await onCreateTask({
                title: input.title,
                priority: input.priority,
                category: input.category,
                project: input.project,
                due_date: input.due_date,
                start_date: input.start_date,
              });
              if (input.starred && task?.id) star(task.id);
              onClose();
            }}
          />
        ) : (
          <EventCreateForm seed={seed} onClose={onClose} onCreateEvent={onCreateEvent!} />
        )}
      </div>
    </>,
    document.body
  );
}

/** Minimal event creator: title + writable target calendar; times from the slot. */
function EventCreateForm({
  seed,
  onClose,
  onCreateEvent,
}: {
  seed: CreateSeed;
  onClose: () => void;
  onCreateEvent: NonNullable<Props['onCreateEvent']>;
}) {
  const [title, setTitle] = useState('');
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [calendarId, setCalendarId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listCalendarSources()
      .then((res) => {
        if (!alive) return;
        const writable = res.calendars.filter((c) => !c.readonly && !c.hidden);
        setCalendars(writable);
        if (writable.length) setCalendarId(writable[0].id);
      })
      .catch(() => alive && setCalendars([]));
    return () => {
      alive = false;
    };
  }, []);

  const allDay = !seed.start.includes('T');
  // Slot click has no end — default to one hour.
  const end = seed.end ?? (allDay ? seed.start : addHourLocal(seed.start));

  const submit = async () => {
    if (!title.trim() || !calendarId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreateEvent({ calendarId, title: title.trim(), start: seed.start, end, allDay });
      onClose();
    } catch (err) {
      setError(String((err as Error).message ?? err).slice(0, 200));
      setSubmitting(false);
    }
  };

  return (
    <div className="cal-event-form" role="dialog" aria-label="Add an event">
      <input
        className="cal-event-form-title"
        placeholder="Event title…"
        value={title}
        autoFocus
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="cal-event-form-when">
        {seed.start.replace('T', ' ').slice(0, 16)}
        {seed.end ? ` – ${seed.end.split('T')[1]?.slice(0, 5) ?? seed.end}` : allDay ? ' (all-day)' : ''}
      </div>
      <select value={calendarId} disabled={!calendars?.length} onChange={(e) => setCalendarId(e.target.value)}>
        {calendars === null && <option>Loading calendars…</option>}
        {calendars?.length === 0 && <option>No writable calendar</option>}
        {calendars?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title} ({c.account})
          </option>
        ))}
      </select>
      {error && <div className="cal-event-form-error">{error}</div>}
      <div className="cal-event-form-footer">
        <button className="cal-event-form-create" disabled={!title.trim() || !calendarId || submitting} onClick={submit}>
          {submitting ? 'Creating…' : 'Create event'}
        </button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function addHourLocal(iso: string): string {
  const [day, time] = iso.split('T');
  const [h, m] = time.split(':').map(Number);
  const nh = Math.min(h + 1, 23);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day}T${pad(nh)}:${pad(m)}:00`;
}
