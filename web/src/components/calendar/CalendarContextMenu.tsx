/**
 * CalendarContextMenu — right-click menu for the calendar surfaces, replacing
 * the browser menu with regular calendar actions:
 *   task chip   → Open task · Complete · Unschedule (clear that date) · Delete
 *   event chip  → Hide its calendar · Delete event (writable calendars only)
 *   empty slot  → New task… · New event… (seeds the quick-create popover)
 * Anchored at the pointer via useMenuPlacement's anchorPoint mode.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import type { CalendarItem } from './calendar-items';
import type { CreateSeed } from './QuickCreatePopover';

export interface CalendarContextTarget {
  point: { x: number; y: number };
  /** Right-clicked chip (absent for empty-space clicks). */
  item?: CalendarItem;
  /** Empty-space click: the slot seed (absent for chip clicks). */
  seed?: CreateSeed;
}

interface Props {
  target: CalendarContextTarget;
  onClose: () => void;
  /** Clear the date the chip stands for (task-start → start_date, task-due → due_date). */
  onUnscheduleTask?: (item: CalendarItem) => void;
  /** Mark the task COMPLETE (human action — the calendar is a human surface). */
  onCompleteTask?: (item: CalendarItem) => void;
  /** Delete the task entirely (two-step confirm, same as event delete). */
  onDeleteTask?: (item: CalendarItem) => void;
  onDeleteEvent?: (item: CalendarItem) => void;
  /** Hide the external calendar that owns the selected event. */
  onHideCalendar?: (calendarId: string) => void;
  /** Open the quick-create popover on the given tab. */
  onCreate?: (seed: CreateSeed, tab: 'task' | 'event') => void;
  /** Event creation is possible (writable source connected). */
  canCreateEvent?: boolean;
}

export function CalendarContextMenu({
  target,
  onClose,
  onUnscheduleTask,
  onCompleteTask,
  onDeleteTask,
  onDeleteEvent,
  onHideCalendar,
  onCreate,
  canCreateEvent,
}: Props) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef, { anchorPoint: target.point });
  // Deleting an event writes through to the REAL external calendar with no
  // undo, so a single stray right-click+click must not be enough.
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { item, seed } = target;
  const isTask = item && item.kind !== 'event';
  const isEvent = item?.kind === 'event';
  const eventWritable = isEvent && !item.event.readonly;

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return createPortal(
    <>
      <div className="cal-popover-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="cal-ctx-menu"
        ref={menuRef}
        style={menuPlacementStyle(placement)}
        role="menu"
        data-testid="cal-ctx-menu"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {isTask && (
          <>
            <button role="menuitem" onClick={run(() => window.open(`/tasks/${item.task.id}`, '_self'))}>
              Open task
            </button>
            {onCompleteTask && (
              <button role="menuitem" onClick={run(() => onCompleteTask(item))}>
                Complete task
              </button>
            )}
            {onUnscheduleTask && (
              <button role="menuitem" onClick={run(() => onUnscheduleTask(item))}>
                {item.kind === 'task-due' ? 'Clear due date' : 'Unschedule'}
              </button>
            )}
            {onDeleteTask && (
              <button
                role="menuitem"
                className="cal-ctx-danger"
                onClick={confirmDelete ? run(() => onDeleteTask(item)) : () => setConfirmDelete(true)}
              >
                {confirmDelete ? 'Delete — are you sure?' : 'Delete task'}
              </button>
            )}
          </>
        )}
        {isEvent && (
          <>
            <div className="cal-ctx-label" title={item.event.calendarName}>
              {item.event.calendarName} · {item.event.accountName}
              {item.event.readonly ? ' (read-only)' : ''}
            </div>
            {onHideCalendar && (
              <button role="menuitem" onClick={run(() => onHideCalendar(item.event.calendarId))}>
                Hide calendar
              </button>
            )}
            {eventWritable && onDeleteEvent && (
              <button
                role="menuitem"
                className="cal-ctx-danger"
                onClick={confirmDelete ? run(() => onDeleteEvent(item)) : () => setConfirmDelete(true)}
              >
                {confirmDelete ? 'Delete — are you sure?' : 'Delete event'}
              </button>
            )}
          </>
        )}
        {seed && onCreate && (
          <>
            <button role="menuitem" onClick={run(() => onCreate(seed, 'task'))}>
              New task…
            </button>
            {canCreateEvent && (
              <button role="menuitem" onClick={run(() => onCreate(seed, 'event'))}>
                New event…
              </button>
            )}
          </>
        )}
      </div>
    </>,
    document.body
  );
}
