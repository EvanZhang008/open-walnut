/**
 * CalendarItemPopover — the macOS-Calendar-style click popover. Clicking ANY
 * chip (event or task) opens this in-place editor anchored to the chip:
 *   events → editable title + date + start/end time, calendar·account line,
 *            location, Delete (read-only calendars show disabled fields)
 *   tasks  → title, category·project line, date + optional time + all-day
 *            toggle for the date this chip represents, Unschedule, Open task
 * Saves go through the same optimistic paths as drags (moveEvent / update).
 */
import { useRef, useState } from 'react';
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
  const invalid = isEvent && !allDay && composeEnd() <= composeStart();

  const save = () => {
    if (readonly) return;
    if (isEvent) {
      if (invalid || !title.trim()) return;
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
          <div className="cal-item-row">
            <input type="date" value={startDate} disabled={readonly} onChange={(e) => setStartDate(e.target.value)} />
            {!allDay && (
              <input type="time" value={startTime} disabled={readonly} onChange={(e) => setStartTime(e.target.value)} />
            )}
            {isEvent && !allDay && (
              <>
                <span className="cal-item-dash">–</span>
                <input type="time" value={endTime} disabled={readonly} onChange={(e) => setEndTime(e.target.value)} />
              </>
            )}
          </div>
          {isEvent && allDay && (endDate !== startDate || !!item.event.end) && (
            <div className="cal-item-row">
              <span className="cal-item-dash">to</span>
              <input type="date" value={endDate || startDate} disabled={readonly} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          )}
          {!isEvent && (
            <label className="cal-item-allday">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All-day
            </label>
          )}
          {invalid && <div className="cal-item-error">End must be after start.</div>}
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
