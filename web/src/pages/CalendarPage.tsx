/**
 * CalendarPage — macOS-Calendar-style day/week/month views over tasks
 * (start_date / due_date chips) plus, in Phase 2, external calendar events.
 *
 * URL is the source of truth for position: /calendar?view=week&d=2026-08-03
 * (shareable/reloadable); everything transient (drag previews, popovers)
 * stays local to the views.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { Task } from '@open-walnut/core';
import { useTasksContext } from '@/contexts/TasksContext';
import { useUndoableTaskActions } from '@/undo/TaskUndoContext';
import { parseDateLocal } from '@/components/common/DatePicker';
import { EmptyState } from '@/components/common/EmptyState';
import {
  formatDateOnly,
  addDays,
  viewRange,
} from '@/utils/calendar-date';
import { eventsToCalendarItems, tasksToCalendarItems, useFrozenWhile, type CalendarItem } from '@/components/calendar/calendar-items';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';
import { CalendarToolbar, type CalendarViewKind } from '@/components/calendar/CalendarToolbar';
import { usePageView } from '@/utils/view-memory';
import { CalendarTaskList, TaskListChip } from '@/components/calendar/CalendarTaskList';
import { MonthView } from '@/components/calendar/MonthView';
import { TimeGrid, type DropPreview, type GridMetrics } from '@/components/calendar/TimeGrid';
import { QuickCreatePopover, type CreateSeed } from '@/components/calendar/QuickCreatePopover';
import { CalendarsPopover } from '@/components/calendar/CalendarsPopover';
import { CalendarContextMenu, type CalendarContextTarget } from '@/components/calendar/CalendarContextMenu';
import { CalendarItemPopover } from '@/components/calendar/CalendarItemPopover';
import { useCalendarItemActions } from '@/components/calendar/calendar-item-actions';
import { gridLocalIso, gridSnappedMinuteAt } from '@/components/calendar/calendar-grid-settings';
import { CalendarAlert, calendarAlertOf, canCreateEventOf } from '@/components/calendar/CalendarAlert';
import { emptyDayLine, isDayEmpty } from '@/components/calendar/phone-empty-day';

const VALID_VIEWS = new Set<CalendarViewKind>(['day', 'week', 'month']);
const isCalendarView = (v: unknown): v is CalendarViewKind => typeof v === 'string' && VALID_VIEWS.has(v as CalendarViewKind);
const LS_RAIL_KEY = 'open-walnut-calendar-rail-open';

/** Parse the drop target id minted by the views: day:… | allday:… | col:… */
function parseDroppableId(id: string): { zone: 'day' | 'allday' | 'col'; day: string } | null {
  const m = /^(day|allday|col):(\d{4}-\d{2}-\d{2})$/.exec(id);
  return m ? { zone: m[1] as 'day' | 'allday' | 'col', day: m[2] } : null;
}

export function CalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tasks, create } = useTasksContext();
  const { setPhase, deleteTask } = useUndoableTaskActions();

  // A phone opens on one day: seven columns at phone width are 45px each.
  const phoneLayout = usePhoneLayout();
  // The view the user last picked is kept (synced with the rest of the UI prefs):
  // a link's ?view wins, a bare /calendar opens on the kept one. A phone keeps its
  // own (it opens on one day; seven columns at phone width are 45px each).
  const [keptView, setKeptView] = usePageView<CalendarViewKind>('calendar', 'view', 'week', isCalendarView);
  const [keptPhoneView, setKeptPhoneView] = usePageView<CalendarViewKind>('calendar', 'phoneView', 'day', isCalendarView);
  const rawView = searchParams.get('view');
  const view: CalendarViewKind = isCalendarView(rawView) ? rawView : phoneLayout ? keptPhoneView : keptView;
  const rawDay = searchParams.get('d');
  const anchorDay = rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : formatDateOnly(new Date());
  const anchor = useMemo(() => parseDateLocal(anchorDay), [anchorDay]);

  const setParam = useCallback(
    (patch: { view?: CalendarViewKind; d?: string }) => {
      if (patch.view) (phoneLayout ? setKeptPhoneView : setKeptView)(patch.view);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (patch.view) next.set('view', patch.view);
          if (patch.d) next.set('d', patch.d);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams, phoneLayout, setKeptPhoneView, setKeptView]
  );

  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(LS_RAIL_KEY) !== 'false');
  const toggleRail = useCallback(() => {
    setRailOpen((prev) => {
      localStorage.setItem(LS_RAIL_KEY, String(!prev));
      return !prev;
    });
  }, []);
  // On a phone the task list lies over the grid instead of beside it, so it
  // starts closed there and its toggle is not the synced desktop flag.
  const [phoneRailOpen, setPhoneRailOpen] = useState(false);
  // The list is a phone layer (spec 4.3): Back closes it, the bar names it.
  const railLayer = usePhoneOverlay({
    id: 'calendar-tasks',
    kind: 'calendar-tasks',
    open: phoneLayout && phoneRailOpen,
    bar: { title: 'Tasks' },
    onClose: () => setPhoneRailOpen(false),
  });
  const closeRailLayer = railLayer.close;
  const togglePhoneRail = useCallback(() => {
    if (phoneRailOpen) closeRailLayer();
    else setPhoneRailOpen(true);
  }, [phoneRailOpen, closeRailLayer]);
  const railShown = phoneLayout ? phoneRailOpen : railOpen;

  // ----- items ------------------------------------------------------------
  const { from, to } = useMemo(() => viewRange(view, anchor), [view, anchor]);

  // Drag state. activeTask = rail task riding a dnd-kit drag; chip moves are
  // handled inside the views via useDragGesture and set chipDragging here so
  // the item arrays freeze either way (React #185 invariant #2).
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  // Every change to an item (shared with the homepage agenda), each one undoable.
  const actions = useCalendarItemActions();
  const [chipDragging, setChipDragging] = useState(false);

  const throughDay = view === 'month' ? to : formatDateOnly(addDays(parseDateLocal(to), 1));
  const calendar = useCalendarEvents(from, throughDay);
  const liveItems = useMemo(
    () => [...tasksToCalendarItems(tasks, from, throughDay), ...eventsToCalendarItems(calendar.events)],
    [tasks, from, throughDay, calendar.events]
  );
  const items = useFrozenWhile(liveItems, activeTask !== null || chipDragging);

  // ----- quick create -----------------------------------------------------
  const [createSeed, setCreateSeed] = useState<CreateSeed | null>(null);

  // ----- calendars visibility popover + right-click menu + item popover -----
  const [calsAnchor, setCalsAnchor] = useState<HTMLElement | null>(null);
  const [ctxTarget, setCtxTarget] = useState<CalendarContextTarget | null>(null);
  const [openItem, setOpenItem] = useState<{ item: CalendarItem; anchorEl: HTMLElement } | null>(null);

  // ----- dnd-kit: rail task → calendar ------------------------------------
  // Stable sensor options (inline objects per render destabilize dnd-kit's
  // memoization → re-register loop; see TodoPanel invariants).
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const sensors = useSensors(pointerSensor);

  // Drop preview for time columns: RAF-batched single state write per frame.
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const previewRaf = useRef(0);
  const previewPending = useRef<DropPreview | null>(null);
  const gridMetricsRef = useRef<GridMetrics | null>(null);

  const scheduleDropPreview = useCallback((p: DropPreview | null) => {
    previewPending.current = p;
    if (previewRaf.current) return;
    previewRaf.current = requestAnimationFrame(() => {
      previewRaf.current = 0;
      setDropPreview(previewPending.current);
    });
  }, []);

  // Live pointer during a rail drag. dnd-kit's activatorEvent+delta looked
  // equivalent to the live pointer but drifts once scroll containers are
  // involved (delta bakes in scrollable-ancestor adjustments), which stored
  // drop times hours away from where the user visibly dropped — the drop line
  // even rendered offset from the cursor. Tracking the real pointermove
  // sidesteps dnd-kit's coordinate model entirely.
  const dragPointerY = useRef<number | null>(null);
  useEffect(() => {
    const track = (ev: PointerEvent) => {
      if (dragPointerY.current !== null) dragPointerY.current = ev.clientY;
    };
    window.addEventListener('pointermove', track, { passive: true });
    return () => window.removeEventListener('pointermove', track);
  }, []);

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const task = e.active.data.current?.task as Task | undefined;
    if (task) {
      setActiveTask(task);
      dragPointerY.current = (e.activatorEvent as PointerEvent)?.clientY ?? 0;
    }
  }, []);

  const computeColPreview = useCallback(
    (e: DragMoveEvent | DragEndEvent): DropPreview | null => {
      const overId = e.over?.id;
      if (typeof overId !== 'string') return null;
      const target = parseDroppableId(overId);
      if (!target) return null;
      if (target.zone !== 'col') return { day: target.day, minute: null, zone: target.zone };
      const metrics = gridMetricsRef.current;
      const rect = metrics?.colTops.get(target.day);
      if (!rect || !metrics) return { day: target.day, minute: null, zone: 'col' };
      const pointerY = dragPointerY.current ?? (e.activatorEvent as PointerEvent)?.clientY ?? 0;
      const y = pointerY - rect.top;
      return { day: target.day, minute: gridSnappedMinuteAt(y, metrics.startMinute, metrics.endMinute, metrics.slotPx), zone: 'col' };
    },
    []
  );

  const handleDragMove = useCallback(
    (e: DragMoveEvent) => {
      if (!e.active.data.current?.task) return;
      scheduleDropPreview(computeColPreview(e));
    },
    [computeColPreview, scheduleDropPreview]
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const task = e.active.data.current?.task as Task | undefined;
      setActiveTask(null);
      scheduleDropPreview(null);
      const preview = task && e.over ? computeColPreview(e) : null;
      dragPointerY.current = null;
      if (!task || !e.over) return;
      const target = parseDroppableId(String(e.over.id));
      if (!target) return;
      if (target.zone === 'col') {
        // No measured column (it scrolled away mid-drag): no time to give it, rather than midnight.
        if (preview?.minute != null) actions.scheduleTask(task.id, gridLocalIso(target.day, preview.minute));
        return;
      }
      actions.scheduleTask(task.id, target.day);
    },
    [computeColPreview, scheduleDropPreview, actions]
  );

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    dragPointerY.current = null;
    scheduleDropPreview(null);
  }, [scheduleDropPreview]);

  const openCreate = useCallback((seed: CreateSeed) => setCreateSeed(seed), []);

  const canCreateEvent = canCreateEventOf(calendar);
  const calendarAlert = calendarAlertOf(calendar);

  const openContextMenu = useCallback(
    (point: { x: number; y: number }, target: { item?: CalendarItem; seed?: CreateSeed }) =>
      setCtxTarget({ point, ...target }),
    []
  );

  const deleteEventItem = useCallback(
    (item: CalendarItem) => { if (item.kind === 'event') void actions.deleteEvent(item.event); },
    [actions]
  );

  const completeTaskItem = useCallback(
    (item: CalendarItem) => {
      if (item.kind === 'event') return;
      setPhase(item.task.id, 'COMPLETE');
    },
    [setPhase]
  );

  const deleteTaskItem = useCallback(
    (item: CalendarItem) => {
      if (item.kind === 'event') return;
      deleteTask(item.task.id);
    },
    [deleteTask]
  );

  const openItemPopover = useCallback(
    (item: CalendarItem, anchorEl: HTMLElement) => setOpenItem({ item, anchorEl }),
    []
  );

  // N27: a phone's empty day says so (only once its events are in and no calendar problem is up).
  const dayEmpty = phoneLayout && view === 'day' && !calendar.loading && !calendarAlert && isDayEmpty(items, from);

  return (
    <div className="cal-page" data-view={view}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <CalendarToolbar
          view={view}
          anchor={anchor}
          onViewChange={(v) => setParam({ view: v })}
          onAnchorChange={(d) => setParam({ d })}
          railOpen={railShown}
          onToggleRail={phoneLayout ? togglePhoneRail : toggleRail}
          onOpenCalendars={setCalsAnchor}
        />
        {dayEmpty && (
          <EmptyState size="row" testId="cal-empty-day" title={emptyDayLine(from, formatDateOnly(new Date())).replace(/\.$/, '')} />
        )}
        <CalendarAlert calendar={calendar} onRetry={calendar.refetch} />
        <div className="cal-body">
          {railShown && <CalendarTaskList tasks={tasks} />}
          <div className="cal-view">
            {view === 'month' ? (
              <MonthView
                anchor={anchor}
                items={items}
                dragging={activeTask !== null}
                onMoveItem={actions.moveItem}
                onCopyItem={actions.copyItem}
                onChipDragging={setChipDragging}
                onCreate={openCreate}
                onNavigateDay={(d) => setParam({ view: 'day', d })}
                onContextMenu={openContextMenu}
                onItemClick={openItemPopover}
              />
            ) : (
              <TimeGrid
                days={view === 'day' ? 1 : 7}
                anchor={anchor}
                items={items}
                dropPreview={dropPreview}
                metricsRef={gridMetricsRef}
                onMoveItem={actions.moveItem}
                onCopyItem={actions.copyItem}
                onResizeItem={actions.resizeItem}
                onChipDragging={setChipDragging}
                onCreate={openCreate}
                onContextMenu={openContextMenu}
                onItemClick={openItemPopover}
                canCreateEvent={canCreateEvent}
              />
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeTask ? <TaskListChip task={activeTask} overlay /> : null}
        </DragOverlay>
      </DndContext>
      {createSeed && (
        <QuickCreatePopover
          seed={createSeed}
          onClose={() => setCreateSeed(null)}
          onCreateTask={create}
          onCreateEvent={canCreateEvent ? actions.createEvent : undefined}
        />
      )}
      {calsAnchor && <CalendarsPopover anchorEl={calsAnchor} onClose={() => setCalsAnchor(null)} hiddenEvents={calendar.hiddenEvents} onShowEvent={calendar.showEvent} />}
      {ctxTarget && (
        <CalendarContextMenu
          target={ctxTarget}
          onClose={() => setCtxTarget(null)}
          onUnscheduleTask={actions.unscheduleTask}
          onCompleteTask={completeTaskItem}
          onDeleteTask={deleteTaskItem}
          onDeleteEvent={deleteEventItem}
          onHideCalendar={calendar.hideCalendar}
          onHideEvent={calendar.hideEvent}
          onCreate={(seed, tab) => setCreateSeed({ ...seed, tab })}
          canCreateEvent={canCreateEvent}
        />
      )}
      {openItem && (
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
