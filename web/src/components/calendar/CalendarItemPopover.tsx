/**
 * CalendarItemPopover — the macOS-Calendar-style click popover. Clicking ANY
 * chip (event or task) opens this in-place editor anchored to the chip:
 *   events → editable title + date + start/end time, calendar·account line,
 *            location, Delete (read-only calendars show disabled fields)
 *   tasks  → title, project line, date + optional time + all-day
 *            toggle for the date this chip represents, Unschedule, Open task
 * Saves go through the same optimistic paths as drags (moveEvent / update).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import type { CalendarItem } from './calendar-items';
import type { CalendarEvent } from '@/api/calendar';

interface Props {
  item: CalendarItem;
  anchorEl: HTMLElement;
  onClose: () => void;
  onSaveEvent?: (ev: CalendarEvent, patch: { start: string; end: string; title?: string }) => void;
  onDeleteEvent?: (ev: CalendarEvent) => void;
  /** Persist the task date this chip represents; '' clears it (unschedule). */
  onSaveTaskWhen?: (item: CalendarItem, newWhen: string) => void;
  /** Persist the task's end_date (task-start chips only); '' clears it. */
  onSaveTaskEnd?: (item: CalendarItem, newEnd: string) => void;
}

const datePart = (iso: string) => iso.slice(0, 10);
const timePart = (iso: string, fallback = '09:00') => (iso.includes('T') ? iso.slice(11, 16) : fallback);

export function CalendarItemPopover({ item, anchorEl, onClose, onSaveEvent, onDeleteEvent, onSaveTaskWhen, onSaveTaskEnd }: Props) {
  const anchorRef = useRef<HTMLElement | null>(anchorEl);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef);

  const isEvent = item.kind === 'event';
  const readonly = isEvent && !!item.event.readonly;

  const [title, setTitle] = useState(isEvent ? item.event.title : item.task.title);
  // Deleting writes through to the REAL external calendar with no undo — a
  // single misclick must not be enough (same two-step as CalendarContextMenu).
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [allDay, setAllDay] = useState(item.allDay);
  const [startDate, setStartDate] = useState(datePart(item.when));
  const [startTime, setStartTime] = useState(timePart(item.when));
  const [endDate, setEndDate] = useState(isEvent ? datePart(item.event.end || item.event.start) : '');
  const [endTime, setEndTime] = useState(isEvent ? timePart(item.event.end || item.event.start, '10:00') : '');
  // Task working-block end (task-start chips): optional — '' means "no end".
  const isTaskStart = item.kind === 'task-start';
  const taskEnd = isTaskStart ? item.task.end_date : undefined;
  const [taskEndTime, setTaskEndTime] = useState(taskEnd?.includes('T') ? taskEnd.slice(11, 16) : '');

  const composeStart = () => (allDay ? startDate : `${startDate}T${startTime}:00`);
  const composeEnd = () => (allDay ? (endDate || startDate) : `${endDate || startDate}T${endTime}:00`);
  // Guard EVERY branch, not just timed events. Chromium's date field happily
  // emits 6-digit years ('192028-08-14') AND zero-pads 1–2 digit years into
  // parseable ones ('26' → '0026-08-12') — both save fine through the tasks
  // API and then the chip vanishes from every calendar surface (real data
  // loss). Parseability alone isn't enough; require the shape AND a sane year.
  const saneWhen = (iso: string) => {
    const d = datePart(iso);
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      d >= '1900-01-01' &&
      d <= '2999-12-31' &&
      // Full-string parse still matters: a cleared time input composes
      // '…T:00', which has a sane date part but is not a valid datetime.
      Number.isFinite(Date.parse(iso.includes('T') ? iso : `${iso}T00:00:00`))
    );
  };
  // Optional task end: '' = no end. When set it must land after the start.
  const composeTaskEnd = () => (taskEndTime && !allDay ? `${startDate}T${taskEndTime}:00` : '');
  const malformed = !saneWhen(composeStart()) || (isEvent && !saneWhen(composeEnd()));
  const misordered =
    (isEvent && !malformed && (allDay ? composeEnd() < composeStart() : composeEnd() <= composeStart())) ||
    (isTaskStart && !malformed && !!composeTaskEnd() && composeTaskEnd() <= composeStart());
  const invalid = malformed || misordered;

  const save = () => {
    // invalid gates tasks too (Enter bypasses the button's disabled attribute).
    if (readonly || invalid) return;
    if (isEvent) {
      if (!title.trim()) return;
      onSaveEvent?.(item.event, { start: composeStart(), end: composeEnd(), title: title.trim() });
    } else {
      onSaveTaskWhen?.(item, composeStart());
      // Persist the end only when it changed (all-day always clears it).
      if (isTaskStart && onSaveTaskEnd) {
        const newEnd = composeTaskEnd();
        const oldEnd = taskEnd?.includes('T') ? taskEnd : '';
        if (newEnd !== oldEnd) onSaveTaskEnd(item, newEnd);
      }
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') onClose();
  };

  // Escape must work regardless of focus. The div's onKeyDown only fires with
  // focus inside the popover — read-only popovers never autofocus and task
  // popovers have a static title, so Escape was dead there (backdrop click was
  // the only way out). Same window-level pattern as CalendarContextMenu.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Moving an event's START (time or date) keeps its duration — macOS Calendar
  // behavior; holding end fixed dead-ended "push the meeting later" edits in
  // "End must be after start." The duration is tracked as INTENT, updated only
  // by explicit END edits — deriving it from current state each keystroke let
  // clamps silently shorten the event and then STICK. Computed over FULL
  // datetimes: a 23:00→01:00 cross-midnight event is 2h, not "-22h of
  // time-of-day". Recomputing end = start + durMin also survives Chromium's
  // per-keystroke PARTIAL date values ('0002-08-06'…): both dates move
  // together, so no transient value poisons the edits after it.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  // 15-min floor: a zero-length event otherwise seeds durMin=0, start edits
  // never move end, and the popover stays stuck on "End must be after start."
  // with no way out. The floor gives the first start edit a valid 15-min out.
  const [durMin, setDurMin] = useState(() =>
    isEvent && !item.allDay
      ? Math.max(15, Math.round((Date.parse(item.event.end || item.event.start) - Date.parse(item.event.start)) / 60000))
      : 0
  );
  // Last non-blank start, for the misorder check below. Chromium's type=time
  // emits a transient '' mid-typing ("0"→''→"08:00"); judging misorder against
  // that blank (NaN) either disarmed the shift for good (silent 5h save) or —
  // once treated as "not misordered" — overwrote an End the user was
  // mid-correcting. The last committed value is the real comparison point.
  const lastStartTimeRef = useRef(timePart(item.when));
  const setEventStartTime = (newStart: string) => {
    if (isEvent && newStart && durMin > 0) {
      const base = Date.parse(`${startDate}T${newStart}:00`);
      // Don't shift while the typed end is a REAL misorder — the user is
      // mid-correction there, and jumping end would discard what they typed.
      const cmpStart = startTime || lastStartTimeRef.current;
      const endMs = Date.parse(`${endDate || startDate}T${endTime}:00`);
      const startMs = Date.parse(`${startDate}T${cmpStart}:00`);
      const misorderedNow = Number.isFinite(endMs) && Number.isFinite(startMs) && endMs <= startMs;
      if (Number.isFinite(base) && !misorderedNow) {
        const shifted = new Date(base + durMin * 60000);
        setEndDate(`${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(shifted.getDate())}`);
        setEndTime(`${pad2(shifted.getHours())}:${pad2(shifted.getMinutes())}`);
      }
    }
    if (newStart) lastStartTimeRef.current = newStart;
    setStartTime(newStart);
  };
  const setEventEndTime = (newEnd: string) => {
    if (isEvent && newEnd) {
      const d = Math.round(
        (Date.parse(`${endDate || startDate}T${newEnd}:00`) - Date.parse(`${startDate}T${startTime}:00`)) / 60000
      );
      if (Number.isFinite(d) && d > 0) setDurMin(d);
    }
    setEndTime(newEnd);
  };
  // Explicit end-DATE edits are end edits too — update the duration intent.
  const setEventEndDate = (newDate: string) => {
    if (!newDate) return;
    if (isEvent) {
      const d = Math.round(
        (Date.parse(`${newDate}T${endTime}:00`) - Date.parse(`${startDate}T${startTime}:00`)) / 60000
      );
      if (Number.isFinite(d) && d > 0) setDurMin(d);
    }
    setEndDate(newDate);
  };

  const setEventDate = (newDate: string) => {
    if (!newDate) return;
    if (isEvent && !allDay && durMin > 0) {
      // End follows from duration intent, NOT from a span captured at mount:
      // after a time edit changed whether the event crosses midnight, the
      // mount-time day span is stale and re-shifting by it moved the end a
      // whole day off (verifier round 4). Same mid-correction guard as
      // setEventStartTime: while the typed end is a real misorder, a date
      // keystroke must not silently rewrite it (verifier round 5).
      const cmpStart = startTime || lastStartTimeRef.current;
      const endMs = Date.parse(`${endDate || startDate}T${endTime}:00`);
      const startMs = Date.parse(`${startDate}T${cmpStart}:00`);
      const misorderedNow = Number.isFinite(endMs) && Number.isFinite(startMs) && endMs <= startMs;
      const base = Date.parse(`${newDate}T${cmpStart}:00`);
      if (Number.isFinite(base) && !misorderedNow) {
        const shifted = new Date(base + durMin * 60000);
        setEndDate(`${String(shifted.getFullYear()).padStart(4, '0')}-${pad2(shifted.getMonth() + 1)}-${pad2(shifted.getDate())}`);
        setEndTime(`${pad2(shifted.getHours())}:${pad2(shifted.getMinutes())}`);
      }
    }
    setStartDate(newDate);
  };

  return createPortal(
    <>
      {/* Ignore the trailing clicks of a double-click: the popover the 1st
          click opened puts this backdrop under the 2nd, which toggle-closed it
          (same customer papercut as QuickCreatePopover). */}
      <div
        className="cal-popover-backdrop"
        onClick={(e) => {
          if (e.detail <= 1) onClose();
        }}
        // Right-click with the popover open must not surface the browser menu
        // (it reads as "the calendar has no right-click") — close instead.
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="cal-item-popover"
        ref={menuRef}
        style={menuPlacementStyle(placement)}
        role="dialog"
        data-testid="cal-item-popover"
        onKeyDown={onKeyDown}
      >
        {isEvent ? (
          <input
            className="cal-item-title"
            value={title}
            disabled={readonly}
            maxLength={200}
            autoFocus={!readonly}
            onChange={(e) => setTitle(e.target.value)}
            style={{ borderLeft: `3px solid ${item.event.color ?? 'var(--accent)'}` }}
          />
        ) : (
          <div className="cal-item-title cal-item-title-static" title={item.task.title}>
            {item.task.title}
          </div>
        )}
        <div className="cal-item-sub">
          {isEvent
            ? `${item.event.calendarName} · ${item.event.accountName}${readonly ? ' · read-only' : ''}`
            : `${item.task.project || 'Inbox'}${item.kind === 'task-due' ? ' · due date' : ' · start date'}`}
        </div>
        {isEvent && item.event.location && <div className="cal-item-location">{item.event.location}</div>}

        <div className="cal-item-fields">
          {/* Events get date and start–end on SEPARATE rows: all three inputs on
              one line total ~358px vs the popover's 274px content box, and with
              overflow-x hidden the browser's focus auto-scroll shoved the Save
              button clean out of the clickable area (edit silently lost). */}
          <div className="cal-item-row">
            <input type="date" value={startDate} min="1900-01-01" max="2999-12-31" disabled={readonly} onChange={(e) => setEventDate(e.target.value)} />
            {!allDay && !isEvent && (
              <input type="time" value={startTime} disabled={readonly} onChange={(e) => setStartTime(e.target.value)} />
            )}
            {!allDay && isTaskStart && (
              <>
                <span className="cal-item-dash">–</span>
                {/* Optional end of the working block; clearing it removes the span. */}
                <input type="time" value={taskEndTime} aria-label="End time (optional)" onChange={(e) => setTaskEndTime(e.target.value)} />
              </>
            )}
          </div>
          {isEvent && !allDay && (
            <div className="cal-item-row">
              <input type="time" value={startTime} disabled={readonly} onChange={(e) => setEventStartTime(e.target.value)} />
              <span className="cal-item-dash">–</span>
              <input type="time" value={endTime} disabled={readonly} onChange={(e) => setEventEndTime(e.target.value)} />
            </div>
          )}
          {isEvent && (allDay ? endDate !== startDate || !!item.event.end : endDate !== startDate || misordered) && (
            // All-day ranges always show their end date; a TIMED event shows it
            // when it crosses midnight — otherwise "11 PM – 1 AM" gives no hint
            // the end is tomorrow — and when MISORDERED: typing End 01:00 on a
            // 22:00 event means "past midnight", and without this row there was
            // no way to say "tomorrow" (permanent dead-end, verifier round 5).
            <div className="cal-item-row">
              <span className="cal-item-dash">to</span>
              <input type="date" value={endDate || startDate} min="1900-01-01" max="2999-12-31" disabled={readonly} onChange={(e) => setEventEndDate(e.target.value)} />
            </div>
          )}
          {!isEvent && (
            <label className="cal-item-allday">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All-day
            </label>
          )}
          {invalid && (
            <div className="cal-item-error">{malformed ? 'Invalid date.' : 'End must be after start.'}</div>
          )}
        </div>

        <div className="cal-item-footer">
          {!readonly && (
            <button className="cal-item-save" disabled={invalid || (isEvent && !title.trim())} onClick={save}>
              Save
            </button>
          )}
          {isEvent && !readonly && onDeleteEvent && (
            <button
              className="cal-item-danger"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                onDeleteEvent(item.event);
                onClose();
              }}
            >
              {confirmDelete ? 'Really delete?' : 'Delete'}
            </button>
          )}
          {!isEvent && onSaveTaskWhen && (
            <button
              onClick={() => {
                onSaveTaskWhen(item, '');
                onClose();
              }}
            >
              {item.kind === 'task-due' ? 'Clear due' : 'Unschedule'}
            </button>
          )}
          {!isEvent && (
            <button className="cal-item-open" onClick={() => window.open(`/tasks/${item.task.id}`, '_self')}>
              Open task ↗
            </button>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
