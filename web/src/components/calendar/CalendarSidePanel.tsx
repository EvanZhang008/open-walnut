/**
 * CalendarSidePanel — the homepage's compact day-agenda: one TimeGrid column
 * for a single day, with chip move + click-to-create working exactly like the
 * full /calendar page. Wrapped in its own DndContext because TimeGrid's
 * droppables need one; rail drags live only on the calendar page (cross-panel
 * drag from TodoPanel is a deliberate non-goal — it owns a separate
 * DndContext and merging them risks its tuned drag setup).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext } from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import { useTasksContext } from '@/contexts/TasksContext';
import { useUndoableTaskActions } from '@/undo/TaskUndoContext';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useDragBusTarget } from '@/hooks/useDragBusTarget';
import { parseDateLocal } from '@/components/common/DatePicker';
import { addDays, formatDateOnly } from '@/utils/calendar-date';
import { eventsToCalendarItems, tasksToCalendarItems, useFrozenWhile, type CalendarItem } from './calendar-items';
import { TimeGrid, type DropPreview, type GridMetrics } from './TimeGrid';
import { QuickCreatePopover, type CreateSeed } from './QuickCreatePopover';
import { CalendarContextMenu, type CalendarContextTarget } from './CalendarContextMenu';
import { CalendarItemPopover } from './CalendarItemPopover';
import { CalendarsPopover } from './CalendarsPopover';
import { CalendarGridControls } from './CalendarGridControls';
import { useCalendarItemActions } from './calendar-item-actions';
import { gridLocalIso, gridSnappedMinuteAt } from './calendar-grid-settings';
import { CalendarAlert, calendarAlertOf, canCreateEventOf } from './CalendarAlert';
import { emptyDayLine, isDayEmpty } from './phone-empty-day';
import { EmptyState, LoadingState, UnavailableState } from '../common/EmptyState';

interface Props {
  onClose: () => void;
  active?: boolean;
  /** Viewport-% width from useResizablePanel; falls back to the CSS default. */
  width?: string;
  panelRef?: React.RefObject<HTMLDivElement | null>;
}

export function CalendarSidePanel({ onClose, active = true, width, panelRef: externalPanelRef }: Props) {
  const { tasks, create } = useTasksContext();
  const { setPhase, deleteTask } = useUndoableTaskActions();
  const [day, setDay] = useState(() => formatDateOnly(new Date()));
  const anchor = useMemo(() => parseDateLocal(day), [day]);

  const [chipDragging, setChipDragging] = useState(false);
  const [createSeed, setCreateSeed] = useState<CreateSeed | null>(null);
  const [ctxTarget, setCtxTarget] = useState<CalendarContextTarget | null>(null);
  const [openItem, setOpenItem] = useState<{ item: CalendarItem; anchorEl: HTMLElement } | null>(null);
  const [calsAnchor, setCalsAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (active) return;
    setCreateSeed(null);
    setCtxTarget(null);
    setOpenItem(null);
    setCalsAnchor(null);
  }, [active]);
  const metricsRef = useRef<GridMetrics | null>(null);
  const internalPanelRef = useRef<HTMLDivElement | null>(null);
  // One element, two consumers: the drag-bus hit-test reads it, and MainPage's
  // useResizablePanel needs it for the `.resizing` class toggle mid-drag.
  const panelRef = externalPanelRef ?? internalPanelRef;

  // ── Cross-panel drop target (drag bus) ──
  // TodoPanel cards ride the drag bus (their dnd-kit context can't reach this
  // panel); dropping one here schedules it: time-grid position → timed
  // start_date, above the grid (all-day strip) → date-only.
  const [busPreview, setBusPreview] = useState<DropPreview | null>(null);
  const actions = useCalendarItemActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const dayRef = useRef(day);
  dayRef.current = day;
  const minuteFromPoint = useCallback((y: number): number | null => {
    const m = metricsRef.current;
    const rect = m?.colTops.get(dayRef.current);
    if (!m || !rect) return null;
    if (y < m.gridTop) return null; // above the scrollable grid = all-day
    return gridSnappedMinuteAt(y - rect.top, m.startMinute, m.endMinute, m.slotPx);
  }, []);
  useDragBusTarget({
    element: () => panelRef.current,
    onDragOver: (p) => {
      const minute = minuteFromPoint(p.y);
      setBusPreview({ day: dayRef.current, minute, zone: minute === null ? 'allday' : 'col' });
    },
    onDragLeave: () => setBusPreview(null),
    onDrop: (p, payload) => {
      setBusPreview(null);
      if (payload.kind !== 'task') return false;
      const minute = minuteFromPoint(p.y);
      actionsRef.current.scheduleTask(payload.task.id, minute === null ? dayRef.current : gridLocalIso(dayRef.current, minute));
      return true;
    },
  });

  // The agenda is "what's today" — meetings matter as much as tasks. The
  // panel shipped tasks-only at first and users glancing at it before their
  // day missed real calendar events entirely.
  const throughDay = formatDateOnly(addDays(anchor, 1));
  const calendar = useCalendarEvents(day, throughDay);
  const liveItems = useMemo(
    () => [...tasksToCalendarItems(tasks, day, throughDay), ...eventsToCalendarItems(calendar.events)],
    [tasks, day, throughDay, calendar.events]
  );
  const items = useFrozenWhile(liveItems, chipDragging);


  const step = (dir: 1 | -1) => setDay(formatDateOnly(addDays(anchor, dir)));
  const isToday = day === formatDateOnly(new Date());

  const canCreateEvent = canCreateEventOf(calendar);

  // An empty grid looks exactly like a free day, so the agenda says which it is (2026-11-21 UI
  // audit), on its own line under the header: the events still loading (tasks of the day may
  // already be on the grid), calendars that were not read (why, and Retry when a read failed),
  // or nothing on the day. A load that failed, or access lost, is the alert's to say.
  const alerted = calendarAlertOf(calendar) !== null;
  const unread = calendar.sources.length > 0 && !calendar.sources.some((s) => s.available && s.enabled);
  const why = calendar.sources.find((s) => s.enabled && !s.available) ?? calendar.sources.find((s) => s.message);
  const status = calendar.loading
    ? <LoadingState size="row" testId="cal-side-status" title="Loading events…" />
    : alerted
      ? null
      : unread
      ? (
        <UnavailableState
          size="row"
          testId="cal-side-status"
          title="Calendars not read"
          hint={why?.reason === 'permission-denied' && !why.message
            ? 'Re-grant Walnut under System Settings → Privacy & Security → Calendars.'
            : why?.message ? undefined : 'Mac calendars are off or not allowed. Calendar Accounts on the Apps page turns them on.'}
          detail={why?.message}
          onRetry={why?.reason === 'fetch-error' ? calendar.refetch : undefined}
        />
      )
      : isDayEmpty(items, day)
        ? <EmptyState size="row" testId="cal-side-status" title={emptyDayLine(day, formatDateOnly(new Date())).replace(/\.$/, '')} />
        : null;

  return (
    <div
      className="cal-side-panel"
      data-testid="cal-side-panel"
      ref={panelRef}
      style={width ? { width } : undefined}
    >
      <div className="cal-side-header">
        <span className="cal-side-title">
          {isToday ? 'Today' : anchor.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        {/* Three groups of the same quiet buttons: the day, the time scale, the panel. */}
        <div className="cal-side-tools" role="group" aria-label="Day">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => step(-1)} aria-label="Previous day" title="Previous day">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          {!isToday && (
            <button type="button" className="btn btn-ghost btn-sm cal-side-today" onClick={() => setDay(formatDateOnly(new Date()))}>
              Today
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => step(1)} aria-label="Next day" title="Next day">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
        <CalendarGridControls />
        <div className="cal-side-tools" role="group" aria-label="Panel">
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm cal-side-calendars"
            onClick={(event) => setCalsAnchor(event.currentTarget)}
            aria-label="Choose calendars"
            title="Choose which calendars to show"
            data-testid="cal-side-cals-btn"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <circle cx="8.5" cy="14" r="1.4" />
              <circle cx="12" cy="14" r="1.4" />
              <circle cx="15.5" cy="14" r="1.4" />
            </svg>
          </button>
          <Link to={`/calendar?view=day&d=${day}`} className="btn btn-ghost btn-icon btn-sm cal-side-expand" title="Open in Calendar" aria-label="Open in Calendar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 3h6v6" /><path d="M10 14L21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </Link>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="Close calendar panel" aria-label="Close calendar panel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
      <CalendarAlert calendar={calendar} onRetry={calendar.refetch} />
      {status}
      <div className="cal-side-body">
      <DndContext>
        <TimeGrid
          days={1}
          anchor={anchor}
          items={items}
          dropPreview={busPreview}
          metricsRef={metricsRef}
          onMoveItem={actions.moveItem}
          onCopyItem={actions.copyItem}
          onResizeItem={actions.resizeItem}
          onChipDragging={setChipDragging}
          onCreate={setCreateSeed}
          onContextMenu={(point, target) => setCtxTarget({ point, ...target })}
          onItemClick={(item, anchorEl) => setOpenItem({ item, anchorEl })}
          resizableAllDay
          canCreateEvent={canCreateEvent}
        />
      </DndContext>
    </div>
      {active && createSeed && (
        <QuickCreatePopover
          seed={createSeed}
          onClose={() => setCreateSeed(null)}
          onCreateTask={create}
          onCreateEvent={canCreateEvent ? actions.createEvent : undefined}
        />
      )}
      {active && ctxTarget && (
        <CalendarContextMenu
          target={ctxTarget}
          onClose={() => setCtxTarget(null)}
          onUnscheduleTask={actions.unscheduleTask}
          onCompleteTask={(item) => { if (item.kind !== 'event') setPhase(item.task.id, 'COMPLETE'); }}
          onDeleteTask={(item) => { if (item.kind !== 'event') deleteTask(item.task.id); }}
          // Context menu hands back the ITEM (id "event:<real-id>"), not the
          // event — passing item.id to the API 404s and the chip resurrects.
          onDeleteEvent={(item) => { if (item.kind === 'event') void actions.deleteEvent(item.event); }}
          onHideCalendar={calendar.hideCalendar}
          onHideEvent={calendar.hideEvent}
          onCreate={(seed, tab) => setCreateSeed({ ...seed, tab })}
          canCreateEvent={canCreateEvent}
        />
      )}
      {active && calsAnchor && (
        <CalendarsPopover anchorEl={calsAnchor} onClose={() => setCalsAnchor(null)} hiddenEvents={calendar.hiddenEvents} onShowEvent={calendar.showEvent} />
      )}
      {active && openItem && (
        <CalendarItemPopover
          item={openItem.item}
          anchorEl={openItem.anchorEl}
          onClose={() => setOpenItem(null)}
          onSaveEvent={actions.saveEvent}
          onDeleteEvent={actions.deleteEvent}
          onHideEvent={calendar.hideEvent}
          onSaveTaskWhen={actions.saveTaskWhen}
        />
      )}
    </div>
  );
}
