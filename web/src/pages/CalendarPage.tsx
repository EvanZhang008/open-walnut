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
import { parseDateLocal } from '@/components/common/DatePicker';
import {
  SLOT_MINUTES,
  formatDateOnly,
  slotToLocalIso,
  snapMinutes,
  viewRange,
} from '@/utils/calendar-date';
import { eventsToCalendarItems, tasksToCalendarItems, useFrozenWhile, type CalendarItem } from '@/components/calendar/calendar-items';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { CalendarToolbar, type CalendarViewKind } from '@/components/calendar/CalendarToolbar';
import { CalendarTaskList, TaskListChip } from '@/components/calendar/CalendarTaskList';
import { MonthView } from '@/components/calendar/MonthView';
import { TimeGrid, type DropPreview, type GridMetrics } from '@/components/calendar/TimeGrid';
import { QuickCreatePopover, type CreateSeed } from '@/components/calendar/QuickCreatePopover';
import { CalendarsPopover } from '@/components/calendar/CalendarsPopover';
import { CalendarContextMenu, type CalendarContextTarget } from '@/components/calendar/CalendarContextMenu';
import { CalendarItemPopover } from '@/components/calendar/CalendarItemPopover';

const VALID_VIEWS = new Set<CalendarViewKind>(['day', 'week', 'month']);
const LS_RAIL_KEY = 'open-walnut-calendar-rail-open';

/** Parse the drop target id minted by the views: day:… | allday:… | col:… */
function parseDroppableId(id: string): { zone: 'day' | 'allday' | 'col'; day: string } | null {
  const m = /^(day|allday|col):(\d{4}-\d{2}-\d{2})$/.exec(id);
  return m ? { zone: m[1] as 'day' | 'allday' | 'col', day: m[2] } : null;
}

export function CalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tasks, update, create, setPhase, deleteTask } = useTasksContext();

  const rawView = searchParams.get('view') as CalendarViewKind | null;
  const view: CalendarViewKind = rawView && VALID_VIEWS.has(rawView) ? rawView : 'week';
  const rawDay = searchParams.get('d');
  const anchorDay = rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : formatDateOnly(new Date());
  const anchor = useMemo(() => parseDateLocal(anchorDay), [anchorDay]);

  const setParam = useCallback(
    (patch: { view?: CalendarViewKind; d?: string }) => {
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
    [setSearchParams]
  );

  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(LS_RAIL_KEY) !== 'false');
  const toggleRail = useCallback(() => {
    setRailOpen((prev) => {
      localStorage.setItem(LS_RAIL_KEY, String(!prev));
      return !prev;
    });
  }, []);

  // ----- items ------------------------------------------------------------
  const { from, to } = useMemo(() => viewRange(view, anchor), [view, anchor]);

  // Drag state. activeTask = rail task riding a dnd-kit drag; chip moves are
  // handled inside the views via useDragGesture and set chipDragging here so
  // the item arrays freeze either way (React #185 invariant #2).
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [chipDragging, setChipDragging] = useState(false);

  const calendar = useCalendarEvents(from, to);
  const liveItems = useMemo(
    () => [...tasksToCalendarItems(tasks, from, to), ...eventsToCalendarItems(calendar.events)],
    [tasks, from, to, calendar.events]
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
      if (target.zone !== 'col') return { day: target.day, slot: null, zone: target.zone };
      const metrics = gridMetricsRef.current;
      const rect = metrics?.colTops.get(target.day);
      if (!rect || !metrics) return { day: target.day, slot: null, zone: 'col' };
      const pointerY = dragPointerY.current ?? (e.activatorEvent as PointerEvent)?.clientY ?? 0;
      const y = pointerY - rect.top;
      const mins = snapMinutes((y / metrics.slotPx) * SLOT_MINUTES, SLOT_MINUTES);
      return { day: target.day, slot: Math.floor(mins / SLOT_MINUTES), zone: 'col' };
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
        const slot = preview?.slot ?? 0;
        update(task.id, { start_date: slotToLocalIso(target.day, slot) });
      } else {
        update(task.id, { start_date: target.day });
      }
    },
    [computeColPreview, scheduleDropPreview, update]
  );

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    dragPointerY.current = null;
    scheduleDropPreview(null);
  }, [scheduleDropPreview]);

  // ----- chip interactions (shared by views) -------------------------------
  const moveItem = useCallback(
    (itemId: string, newWhen: string) => {
      // Event ids may themselves contain ':' — split on the FIRST colon only.
      const sep = itemId.indexOf(':');
      const kind = itemId.slice(0, sep);
      const rest = itemId.slice(sep + 1);
      if (kind === 'task-start') {
        // Moving a spanned task keeps its duration — end_date shifts with the
        // start (macOS-Calendar behavior, same as events below). A drop into
        // the all-day row / a month cell drops the block shape entirely.
        const task = tasks.find((t) => t.id === rest);
        const patch: { start_date: string; end_date?: string } = { start_date: newWhen };
        if (task?.end_date?.includes('T') && task.start_date?.includes('T')) {
          if (newWhen.includes('T')) {
            const durMs = parseDateLocal(task.end_date).getTime() - parseDateLocal(task.start_date).getTime();
            if (durMs > 0) {
              const end = new Date(parseDateLocal(newWhen).getTime() + durMs);
              const pad = (n: number) => String(n).padStart(2, '0');
              patch.end_date = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}:00`;
            }
          } else {
            patch.end_date = '';
          }
        }
        update(rest, patch);
      }
      else if (kind === 'task-due') update(rest, { due_date: newWhen });
      else if (kind === 'event') {
        const ev = calendar.events.find((e) => e.id === rest);
        if (!ev) return;
        if (!newWhen.includes('T')) {
          // dropped in the all-day row / a month cell with a date-only value
          calendar.moveEvent(rest, { start: newWhen, end: newWhen });
          return;
        }
        // Moving keeps the duration.
        const durMs = Math.max(
          15 * 60_000,
          parseDateLocal(ev.end || ev.start).getTime() - parseDateLocal(ev.start).getTime()
        );
        const newStart = parseDateLocal(newWhen);
        const newEnd = new Date(newStart.getTime() + durMs);
        const pad = (n: number) => String(n).padStart(2, '0');
        const fmt = (d: Date) =>
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
        calendar.moveEvent(rest, { start: newWhen, end: fmt(newEnd) });
      }
    },
    [update, calendar]
  );

  const resizeItem = useCallback(
    (itemId: string, newEnd: string) => {
      const sep = itemId.indexOf(':');
      const kind = itemId.slice(0, sep);
      const rest = itemId.slice(sep + 1);
      if (kind === 'task-start') {
        update(rest, { end_date: newEnd });
        return;
      }
      const ev = calendar.events.find((e) => e.id === rest);
      if (!ev) return;
      calendar.moveEvent(rest, { start: ev.start, end: newEnd });
    },
    [calendar, update]
  );

  const openCreate = useCallback((seed: CreateSeed) => setCreateSeed(seed), []);

  // While the FIRST events fetch is in flight (sources never resolved yet),
  // assume event-creation IS available: gating on the resolved sources made a
  // quick-create opened during a slow load render with no Task|Event tab bar
  // at all (the "can't select Event" race). Once sources have resolved once we
  // trust them — `sources` persists across range-change refetches, so this
  // never flashes the Event tab at users with no writable calendar. If the
  // optimism was wrong, QuickCreatePopover falls back to the Task tab.
  const canCreateEvent = calendar.sources.length === 0
    ? calendar.loading
    : calendar.sources.some((s) => s.available && s.enabled);

  const openContextMenu = useCallback(
    (point: { x: number; y: number }, target: { item?: CalendarItem; seed?: CreateSeed }) =>
      setCtxTarget({ point, ...target }),
    []
  );

  const unscheduleTask = useCallback(
    (item: CalendarItem) => {
      if (item.kind === 'event') return;
      // '' clears the date through the web update path. Unscheduling the start
      // also clears end_date — a dangling end without a start means nothing.
      if (item.kind === 'task-due') update(item.task.id, { due_date: '' });
      else update(item.task.id, { start_date: '', ...(item.task.end_date ? { end_date: '' } : {}) });
    },
    [update]
  );

  const deleteEventItem = useCallback(
    (item: CalendarItem) => {
      if (item.kind !== 'event') return;
      calendar.removeEvent(item.event.id);
    },
    [calendar]
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

  /** Item-popover save for tasks: newWhen '' clears the chip's date. */
  const saveTaskWhen = useCallback(
    (item: CalendarItem, newWhen: string) => {
      if (item.kind === 'event') return;
      if (item.kind === 'task-due') update(item.task.id, { due_date: newWhen });
      else update(item.task.id, { start_date: newWhen });
    },
    [update]
  );

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
          railOpen={railOpen}
          onToggleRail={toggleRail}
          onOpenCalendars={setCalsAnchor}
        />
        <div className="cal-body">
          {railOpen && <CalendarTaskList tasks={tasks} />}
          <div className="cal-view">
            {view === 'month' ? (
              <MonthView
                anchor={anchor}
                items={items}
                dragging={activeTask !== null}
                onMoveItem={moveItem}
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
                onMoveItem={moveItem}
                onResizeItem={resizeItem}
                onChipDragging={setChipDragging}
                onCreate={openCreate}
                onContextMenu={openContextMenu}
                onItemClick={openItemPopover}
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
          onCreateEvent={canCreateEvent ? calendar.createEvent : undefined}
        />
      )}
      {calsAnchor && <CalendarsPopover anchorEl={calsAnchor} onClose={() => setCalsAnchor(null)} />}
      {ctxTarget && (
        <CalendarContextMenu
          target={ctxTarget}
          onClose={() => setCtxTarget(null)}
          onUnscheduleTask={unscheduleTask}
          onCompleteTask={completeTaskItem}
          onDeleteTask={deleteTaskItem}
          onDeleteEvent={deleteEventItem}
          onHideCalendar={calendar.hideCalendar}
          onCreate={(seed, tab) => setCreateSeed({ ...seed, tab })}
          canCreateEvent={canCreateEvent}
        />
      )}
      {openItem && (
        <CalendarItemPopover
          item={openItem.item}
          anchorEl={openItem.anchorEl}
          onClose={() => setOpenItem(null)}
          onSaveEvent={(ev, patch) => calendar.moveEvent(ev.id, patch)}
          onDeleteEvent={(ev) => calendar.removeEvent(ev.id)}
          onSaveTaskWhen={saveTaskWhen}
          onSaveTaskEnd={(item, newEnd) => {
            if (item.kind !== 'event') update(item.task.id, { end_date: newEnd });
          }}
        />
      )}
    </div>
  );
}
