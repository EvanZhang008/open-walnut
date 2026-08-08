/**
 * CalendarSidePanel — the homepage's compact day-agenda: one TimeGrid column
 * for a single day, with chip move + click-to-create working exactly like the
 * full /calendar page. Wrapped in its own DndContext because TimeGrid's
 * droppables need one; rail drags live only on the calendar page (cross-panel
 * drag from TodoPanel is a deliberate non-goal — it owns a separate
 * DndContext and merging them risks its tuned drag setup).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { DndContext } from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import { useTasksContext } from '@/contexts/TasksContext';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useDragBusTarget } from '@/hooks/useDragBusTarget';
import { parseDateLocal } from '@/components/common/DatePicker';
import { SLOT_MINUTES, addDays, formatDateOnly, slotToLocalIso, snapMinutes } from '@/utils/calendar-date';
import { eventsToCalendarItems, tasksToCalendarItems, useFrozenWhile, type CalendarItem } from './calendar-items';
import { TimeGrid, type DropPreview, type GridMetrics } from './TimeGrid';
import { QuickCreatePopover, type CreateSeed } from './QuickCreatePopover';
import { CalendarContextMenu, type CalendarContextTarget } from './CalendarContextMenu';
import { CalendarItemPopover } from './CalendarItemPopover';

interface Props {
  onClose: () => void;
  /** Viewport-% width from useResizablePanel; falls back to the CSS default. */
  width?: string;
  panelRef?: React.RefObject<HTMLDivElement | null>;
}

export function CalendarSidePanel({ onClose, width, panelRef: externalPanelRef }: Props) {
  const { tasks, update, create, setPhase, deleteTask } = useTasksContext();
  const [day, setDay] = useState(() => formatDateOnly(new Date()));
  const anchor = useMemo(() => parseDateLocal(day), [day]);

  const [chipDragging, setChipDragging] = useState(false);
  const [createSeed, setCreateSeed] = useState<CreateSeed | null>(null);
  const [ctxTarget, setCtxTarget] = useState<CalendarContextTarget | null>(null);
  const [openItem, setOpenItem] = useState<{ item: CalendarItem; anchorEl: HTMLElement } | null>(null);
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
  const dayRef = useRef(day);
  dayRef.current = day;
  const slotFromPoint = useCallback((y: number): number | null => {
    const m = metricsRef.current;
    const rect = m?.colTops.get(dayRef.current);
    if (!m || !rect) return null;
    if (y < m.gridTop) return null; // above the scrollable grid = all-day
    const mins = snapMinutes(((y - rect.top) / m.slotPx) * SLOT_MINUTES, SLOT_MINUTES);
    return Math.max(0, Math.min(Math.floor(mins / SLOT_MINUTES), (24 * 60) / SLOT_MINUTES - 1));
  }, []);
  useDragBusTarget({
    element: () => panelRef.current,
    onDragOver: (p) => {
      const slot = slotFromPoint(p.y);
      setBusPreview({ day: dayRef.current, slot, zone: slot === null ? 'allday' : 'col' });
    },
    onDragLeave: () => setBusPreview(null),
    onDrop: (p, payload) => {
      setBusPreview(null);
      if (payload.kind !== 'task') return false;
      const slot = slotFromPoint(p.y);
      update(payload.task.id, {
        start_date: slot === null ? dayRef.current : slotToLocalIso(dayRef.current, slot),
      });
      return true;
    },
  });

  // The agenda is "what's today" — meetings matter as much as tasks. The
  // panel shipped tasks-only at first and users glancing at it before their
  // day missed real calendar events entirely.
  const calendar = useCalendarEvents(day, day);
  const liveItems = useMemo(
    () => [...tasksToCalendarItems(tasks, day, day), ...eventsToCalendarItems(calendar.events)],
    [tasks, day, calendar.events]
  );
  const items = useFrozenWhile(liveItems, chipDragging);

  const moveItem = useCallback(
    (itemId: string, newWhen: string) => {
      // Event ids may themselves contain ':' — split on the FIRST colon only.
      const sep = itemId.indexOf(':');
      const kind = itemId.slice(0, sep);
      const rest = itemId.slice(sep + 1);
      if (kind === 'task-start') {
        // Same duration-preserving move as CalendarPage.moveItem.
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
        if (!ev || !newWhen.includes('T')) return;
        const durMs = Math.max(
          15 * 60_000,
          parseDateLocal(ev.end || ev.start).getTime() - parseDateLocal(ev.start).getTime()
        );
        const newEnd = new Date(parseDateLocal(newWhen).getTime() + durMs);
        const pad = (n: number) => String(n).padStart(2, '0');
        calendar.moveEvent(rest, {
          start: newWhen,
          end: `${newEnd.getFullYear()}-${pad(newEnd.getMonth() + 1)}-${pad(newEnd.getDate())}T${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}:00`,
        });
      }
    },
    [update, calendar]
  );

  const unscheduleTask = useCallback(
    (item: CalendarItem) => {
      if (item.kind === 'event') return;
      if (item.kind === 'task-due') update(item.task.id, { due_date: '' });
      else update(item.task.id, { start_date: '', ...(item.task.end_date ? { end_date: '' } : {}) });
    },
    [update]
  );

  const saveTaskWhen = useCallback(
    (item: CalendarItem, newWhen: string) => {
      if (item.kind === 'event') return;
      if (item.kind === 'task-due') update(item.task.id, { due_date: newWhen });
      else update(item.task.id, { start_date: newWhen });
    },
    [update]
  );

  const step = (dir: 1 | -1) => setDay(formatDateOnly(addDays(anchor, dir)));
  const isToday = day === formatDateOnly(new Date());

  // Same optimistic-while-unresolved gate as CalendarPage (see its comment).
  const canCreateEvent = calendar.sources.length === 0
    ? calendar.loading
    : calendar.sources.some((s) => s.available && s.enabled);

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
        <div className="cal-side-nav">
          <button onClick={() => step(-1)} aria-label="Previous day">‹</button>
          {!isToday && (
            <button className="cal-side-today" onClick={() => setDay(formatDateOnly(new Date()))}>
              Today
            </button>
          )}
          <button onClick={() => step(1)} aria-label="Next day">›</button>
        </div>
        <Link to={`/calendar?view=day&d=${day}`} className="cal-side-expand" title="Open calendar">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" /><path d="M10 14L21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </Link>
        <button className="btn btn-sm" onClick={onClose} title="Close calendar panel">
          ✕
        </button>
      </div>
      <div className="cal-side-body">
        <DndContext>
          <TimeGrid
            days={1}
            anchor={anchor}
            items={items}
            dropPreview={busPreview}
            metricsRef={metricsRef}
            onMoveItem={moveItem}
            onResizeItem={(itemId, newEnd) => {
              const sep = itemId.indexOf(':');
              if (itemId.slice(0, sep) === 'task-start') update(itemId.slice(sep + 1), { end_date: newEnd });
              else {
                const rest = itemId.slice(sep + 1);
                const ev = calendar.events.find((e) => e.id === rest);
                if (ev) calendar.moveEvent(rest, { start: ev.start, end: newEnd });
              }
            }}
            onChipDragging={setChipDragging}
            onCreate={setCreateSeed}
            onContextMenu={(point, target) => setCtxTarget({ point, ...target })}
            onItemClick={(item, anchorEl) => setOpenItem({ item, anchorEl })}
          />
        </DndContext>
      </div>
      {createSeed && (
        <QuickCreatePopover
          seed={createSeed}
          onClose={() => setCreateSeed(null)}
          onCreateTask={create}
          onCreateEvent={canCreateEvent ? calendar.createEvent : undefined}
        />
      )}
      {ctxTarget && (
        <CalendarContextMenu
          target={ctxTarget}
          onClose={() => setCtxTarget(null)}
          onUnscheduleTask={unscheduleTask}
          onCompleteTask={(item) => { if (item.kind !== 'event') setPhase(item.task.id, 'COMPLETE'); }}
          onDeleteTask={(item) => { if (item.kind !== 'event') deleteTask(item.task.id); }}
          // Context menu hands back the ITEM (id "event:<real-id>"), not the
          // event — passing item.id to the API 404s and the chip resurrects.
          onDeleteEvent={(item) => {
            if (item.kind === 'event') calendar.removeEvent(item.event.id);
          }}
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
