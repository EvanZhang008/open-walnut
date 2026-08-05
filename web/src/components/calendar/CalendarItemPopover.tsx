/**
 * CalendarItemPopover — the macOS-Calendar-style click popover. Clicking ANY
 * chip (event or task) opens this in-place editor anchored to the chip:
 *   events → editable title + date + start/end time, calendar·account line,
 *            location, Delete (read-only calendars show disabled fields)
 *   tasks  → title, category·project line, date + optional time + all-day
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
}

const datePart = (iso: string) => iso.slice(0, 10);
const timePart = (iso: string, fallback = '09:00') => (iso.includes('T') ? iso.slice(11, 16) : fallback);

export function CalendarItemPopover({ item, anchorEl, onClose, onSaveEvent, onDeleteEvent, onSaveTaskWhen }: Props) {
  const anchorRef = useRef<HTMLElement | null>(anchorEl);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef);

  const isEvent = item.kind === 'event';
  const readonly = isEvent && !!item.event.readonly;

  const [title, setTitle] = useState(isEvent ? item.event.title : item.task.title);
  const [allDay, setAllDay] = useState(item.allDay);
  const [startDate, setStartDate] = useState(datePart(item.when));
  const [startTime, setStartTime] = useState(timePart(item.when));
  const [endDate, setEndDate] = useState(isEvent ? datePart(item.event.end || item.event.start) : '');
  const [endTime, setEndTime] = useState(isEvent ? timePart(item.event.end || item.event.start, '10:00') : '');

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
  const malformed = !saneWhen(composeStart()) || (isEvent && !saneWhen(composeEnd()));
  const misordered =
    isEvent && !malformed && (allDay ? composeEnd() < composeStart() : composeEnd() <= composeStart());
  const invalid = malformed || misordered;

  const save = () => {
    // invalid gates tasks too (Enter bypasses the button's disabled attribute).
    if (readonly || invalid) return;
    if (isEvent) {
      if (!title.trim()) return;
      onSaveEvent?.(item.event, { start: composeStart(), end: composeEnd(), title: title.trim() });
    } else {
      onSaveTaskWhen?.(item, composeStart());
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

  // A timed event renders ONE date input (its day). Moving that day must move
  // the WHOLE event, i.e. endDate has to follow. Two traps this must survive
  // (both found by adversarial UI agents):
  //  - clear-then-retype fires change with '' — committing it strands the
  //    popover permanently invalid, so transient empties are ignored;
  //  - typing a year emits PARTIAL values per keystroke ('0002-08-06'…), so
  //    the end date is recomputed every change from the IMMUTABLE mount span
  //    (event end day − start day), never chained through previous state —
  //    one transient value must not poison every edit after it.
  const eventSpanMs = isEvent
    ? Math.max(0, Date.parse(`${datePart(item.event.end || item.event.start)}T00:00:00`) -
        Date.parse(`${datePart(item.event.start)}T00:00:00`))
    : 0;
  const setEventDate = (newDate: string) => {
    if (!newDate) return;
    const base = Date.parse(`${newDate}T00:00:00`);
    if (isEvent && !allDay && Number.isFinite(base)) {
      // Noon anchor dodges DST: adding a 24h-multiple to midnight can land in
      // the previous day across a spring-forward boundary.
      const shifted = new Date(base + eventSpanMs + 12 * 3600 * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      setEndDate(`${String(shifted.getFullYear()).padStart(4, '0')}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`);
    }
    setStartDate(newDate);
  };

  return createPortal(
    <>
      <div className="cal-popover-backdrop" onClick={onClose} />
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
            : `${item.task.category} · ${item.task.project}${item.kind === 'task-due' ? ' · due date' : ' · start date'}`}
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
          </div>
          {isEvent && !allDay && (
            <div className="cal-item-row">
              <input type="time" value={startTime} disabled={readonly} onChange={(e) => setStartTime(e.target.value)} />
              <span className="cal-item-dash">–</span>
              <input type="time" value={endTime} disabled={readonly} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          )}
          {isEvent && allDay && (endDate !== startDate || !!item.event.end) && (
            <div className="cal-item-row">
              <span className="cal-item-dash">to</span>
              <input type="date" value={endDate || startDate} min="1900-01-01" max="2999-12-31" disabled={readonly} onChange={(e) => setEndDate(e.target.value)} />
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
                onDeleteEvent(item.event);
                onClose();
              }}
            >
              Delete
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
