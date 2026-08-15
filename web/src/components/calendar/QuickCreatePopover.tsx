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
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
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
  const { tasks } = useTasksContext();
  const projectRegistry = useProjectRegistry();
  const anchorRef = useRef<HTMLElement | null>(seed.anchorEl ?? null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef, {
    anchorPoint: seed.anchorPoint ?? null,
    // Open rightward from the click: right-aligned (the default) covered the
    // very day column being scheduled, hiding which day you clicked.
    align: 'left',
  });
  const [tab, setTab] = useState<'task' | 'event'>(seed.tab && onCreateEvent ? seed.tab : 'task');

  // The page's canCreateEvent gate is OPTIMISTIC while calendar sources load.
  // If it settles to "no writable source" while the user sits on the Event tab,
  // onCreateEvent flips to undefined — without this fallback the tab bar
  // unmounts but the event form stays, and Create throws a raw TypeError into
  // the form ("onCreateEvent is not a function") with the user stranded.
  useEffect(() => {
    if (!onCreateEvent && tab === 'event') setTab('task');
  }, [onCreateEvent, tab]);

  // Window-level Escape: the composer/form inputs handle Escape only while
  // focused — after clicking non-focusable popover chrome (tabs, header, the
  // when-line) focus sits on <body> and Escape went dead, leaving the modal
  // backdrop swallowing every grid click. Same pattern as CalendarItemPopover.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Flat list of existing project names for the composer's datalist. Project is
  // the single grouping layer; Inbox is the absence of one, so '' never appears.
  // Registry first (an existing-but-EMPTY project must not be badged "new" in the
  // confirm step), then names seen on tasks as a fallback while that fetch is in
  // flight. Deduped case-insensitively, canonical registry spelling winning.
  const projectOptions = useMemo(() => {
    const seen = new Map<string, string>(); // lowercase → canonical/first spelling
    for (const name of projectRegistry.projectNames) {
      if (name.trim()) seen.set(name.trim().toLowerCase(), name.trim());
    }
    for (const task of tasks) {
      if (task.title.startsWith('.metadata') || !task.project) continue;
      const key = task.project.toLowerCase();
      if (!seen.has(key)) seen.set(key, task.project);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [tasks, projectRegistry.projectNames]);

  // A drag-selected range is the task's working block (start→end), NOT a
  // deadline — seeding it as due_date invented a due the user never asked for.
  const initialDates = useMemo(
    () => ({ start: seed.start, end: seed.end }),
    [seed.start, seed.end]
  );

  return createPortal(
    <>
      {/* Instinctive double-clicks must not toggle-close: the popover the 1st
          click opened puts this backdrop under the 2nd click, which then undid
          everything (customer finding: "double-click leaves you with nothing").
          detail>1 = later clicks of a multi-click — swallow them. mousedown too:
          QuickTaskComposer closes itself on any document mousedown outside. */}
      <div
        className="cal-popover-backdrop"
        onMouseDown={(e) => {
          if (e.detail > 1) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onClick={(e) => {
          if (e.detail <= 1) onClose();
        }}
        // Same as CalendarItemPopover: no browser menu on the backdrop.
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="cal-create-popover" ref={menuRef} style={menuPlacementStyle(placement)}>
        {onCreateEvent && (
          <div
            className="cal-create-tabs"
            role="tablist"
            // The tabs sit INSIDE this popover but OUTSIDE QuickTaskComposer's
            // root div, and the composer closes on any document mousedown
            // outside itself — so without this, clicking "Event" closed the
            // whole popover before the tab could switch.
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button role="tab" aria-selected={tab === 'task'} className={tab === 'task' ? 'active' : ''} onClick={() => setTab('task')}>
              Task
            </button>
            <button role="tab" aria-selected={tab === 'event'} className={tab === 'event' ? 'active' : ''} onClick={() => setTab('event')}>
              Event
            </button>
          </div>
        )}
        {tab === 'task' || !onCreateEvent ? (
          <QuickTaskComposer
            open
            onClose={onClose}
            projectOptions={projectOptions}
            initialDates={initialDates}
            onCreate={async (input) => {
              // pinnedTier needs the Focus Bar plumbing MainPage owns — out of
              // scope on the calendar.
              await onCreateTask({
                title: input.title,
                priority: input.priority,
                project: input.project,
                due_date: input.due_date,
                start_date: input.start_date,
                end_date: input.end_date,
              });
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
  const day = seed.start.slice(0, 10);
  // Editable times: a meeting is rarely exactly the clicked slot + 1h, and
  // without these every new event was silently forced to one hour.
  const [startTime, setStartTime] = useState(() => (allDay ? '' : seed.start.slice(11, 16)));
  const [endTime, setEndTime] = useState(() => {
    if (allDay) return '';
    const end = seed.end ?? addHourLocal(seed.start);
    return end.slice(11, 16);
  });
  // Editing Start keeps the duration (same macOS-Calendar behavior as the item
  // popover) — holding End fixed dead-ended "the meeting is 3h later" edits in
  // "End must be after start." Duration = intent: only explicit End edits set it,
  // and Start edits don't shift a misordered End (the user is mid-correction).
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const [durMin, setDurMin] = useState(() => (allDay || !startTime || !endTime ? 0 : Math.max(0, toMin(endTime) - toMin(startTime))));
  const changeStart = (newStart: string) => {
    // Skip the shift only on a REAL misorder (both fields filled, end<=start —
    // the user is mid-correction). A transiently blank field (Chromium emits
    // '' between keystrokes; Backspace-retype) must NOT disarm the shift.
    const misorderedNow = !!startTime && !!endTime && endTime <= startTime;
    if (newStart && durMin > 0 && !misorderedNow) {
      const shifted = Math.min(toMin(newStart) + durMin, 23 * 60 + 59);
      const pad = (n: number) => String(n).padStart(2, '0');
      setEndTime(`${pad(Math.floor(shifted / 60))}:${pad(shifted % 60)}`);
    }
    setStartTime(newStart);
  };
  const changeEnd = (newEnd: string) => {
    if (newEnd && startTime) {
      const d = toMin(newEnd) - toMin(startTime);
      if (d > 0) setDurMin(d);
    }
    setEndTime(newEnd);
  };
  // A cleared time input (Backspace mid-retype) must gate Create too —
  // submitting a blank composes '<day>T:00' and surfaces a raw server 400.
  const incomplete = !allDay && (!startTime || !endTime);
  const misordered = !allDay && !!startTime && !!endTime && endTime <= startTime;
  const invalid = incomplete || misordered;

  const submit = async () => {
    if (!title.trim() || !calendarId || submitting || invalid) return;
    setSubmitting(true);
    setError(null);
    try {
      const start = allDay ? day : `${day}T${startTime}:00`;
      const end = allDay ? (seed.end ?? day) : `${day}T${endTime}:00`;
      await onCreateEvent({ calendarId, title: title.trim(), start, end, allDay });
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
        {allDay ? (
          <>
            {day}
            {seed.end && seed.end !== day ? ` – ${seed.end}` : ' (all-day)'}
          </>
        ) : (
          <>
            <span>{day}</span>
            <input type="time" value={startTime} onChange={(e) => changeStart(e.target.value)} aria-label="Start time" />
            <span className="cal-item-dash">–</span>
            <input type="time" value={endTime} onChange={(e) => changeEnd(e.target.value)} aria-label="End time" />
          </>
        )}
      </div>
      {misordered && <div className="cal-event-form-error">End must be after start.</div>}
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
        <button className="cal-event-form-create" disabled={!title.trim() || !calendarId || submitting || invalid} onClick={submit}>
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
  // Clamp to 23:59, not "hour 23 same minute": the latter seeded a ZERO-length
  // 23:00–23:00 range for 22:30+ slots — the form opened pre-broken with
  // 'End must be after start.' before the user touched anything.
  const mins = Math.min(h * 60 + m + 60, 23 * 60 + 59);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;
}
