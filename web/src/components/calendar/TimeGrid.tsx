/**
 * TimeGrid — the shared week/day time-grid engine (the macOS Calendar look):
 * an all-day row, an hour ruler, and N absolutely-positioned day columns.
 *
 * Interaction model (React #185-safe by construction):
 *  - rail-task drops: each day column is ONE coarse dnd-kit droppable
 *    (`col:YYYY-MM-DD`); the page computes the slot from pointer Y and passes
 *    a dropPreview down. Slot lines are CSS gradients, not 48 divs.
 *  - chip move / drag-to-create: ONE view-level useDragGesture each (rAF-
 *    coalesced by the hook); preview via CSS transform on a ghost, state
 *    writes at most once per painted frame. Alt (Option) held at the drop
 *    copies an event instead of moving it (useAltCopy).
 *  - every preview is drawn in the colour the item will have (item-tint.ts).
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useDroppable } from '@dnd-kit/core';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useDragGesture } from '@/hooks/useDragGesture';
import { useResizableHeight } from '@/hooks/useResizableHeight';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import {
  SLOT_MINUTES,
  SNAP_MINUTES,
  clockLabel,
  clockRange,
  formatDateOnly,
  layoutDayEvents,
  weekRange,
} from '@/utils/calendar-date';
import { visibleInterval } from '@/utils/page-visibility';
import { fittedSlotPx, GRID_EXTENDED_END, GRID_FOCUS_START, gridMinute, gridY, gridLocalIso, gridSnapMinute, PHONE_MIN_SLOT_PX, phoneLandingMinute, useCalendarGridSettings } from './calendar-grid-settings';
import { timeGridItems } from './calendar-items';
import './grid-controls.css';
import type { CalendarItem } from './calendar-items';
import { CalendarChip } from './CalendarChip';
import { isCreateKind, ONE_LINE_BELOW_PX, type CreateKind, type CreateSeed } from './QuickCreatePopover';
import { usePageView } from '@/utils/view-memory';
import { chipTint, NEW_TASK_TINT, useNewEventTint } from './item-tint';
import { canAltCopy, useAltCopy } from './alt-copy';

export const SLOT_PX = 24;
const CLICK_TOLERANCE_PX = 4;
const MIN_EVENT_PX = 20;
/** Resize can't shrink an event below this. */
const SNAP_MINUTES_MIN = 15;
const ALL_DAY_HEIGHT_STORAGE_KEY = 'open-walnut-home-calendar-all-day-height';
const ALL_DAY_MIN_HEIGHT = 26;
const ALL_DAY_MAX_HEIGHT = 212; // Ten 19px rows, nine 2px gaps, and 4px cell padding.

export interface DropPreview {
  day: string;
  /** null for month/all-day zones (no time component). */
  slot: number | null;
  zone: 'day' | 'allday' | 'col';
}

export interface GridMetrics {
  colTops: Map<string, DOMRect>;
  slotPx: number;
  startMinute: number;
  endMinute: number;
  /** Viewport top edge of the scrollable time area — pointer above it = the
   *  all-day zone. Column rects can't answer this once the grid has scrolled
   *  (their top goes far above the viewport). */
  gridTop: number;
}

interface Props {
  days: 1 | 7;
  anchor: Date;
  items: CalendarItem[];
  dropPreview: DropPreview | null;
  /** The page reads column rects from here to compute dnd-kit drop slots. */
  metricsRef: MutableRefObject<GridMetrics | null>;
  onMoveItem: (itemId: string, newWhen: string) => void;
  /** Alt-drag of an event: a copy where it was dropped, the original stays. */
  onCopyItem?: (itemId: string, newWhen: string) => void;
  /** Bottom-edge resize: events → new end; task-start chips → new end_date. */
  onResizeItem?: (itemId: string, newEnd: string) => void;
  onChipDragging: (dragging: boolean) => void;
  onCreate: (seed: CreateSeed) => void;
  /** Right-click on a chip or empty slot → calendar context menu. */
  onContextMenu?: (point: { x: number; y: number }, target: { item?: CalendarItem; seed?: CreateSeed }) => void;
  /** Click on any chip → the item edit popover (macOS-Calendar-style). */
  onItemClick?: (item: CalendarItem, el: HTMLElement) => void;
  /** Homepage agenda only: let the all-day area grow to ten rows and resize. */
  resizableAllDay?: boolean;
  /** False when no calendar can take an event: a new item can only be a task. */
  canCreateEvent?: boolean;
}

interface ChipDrag {
  item: CalendarItem;
  /** Pointer offset inside the chip at grab, so the ghost doesn't jump. */
  grabOffsetMin: number;
  overDay: string | null;
  /** Snapped minutes-of-day for the ghost top (null → all-day row). */
  previewMin: number | null;
  moved: boolean;
  /** Alt is down on an item that can be copied: the drop copies it. */
  copy: boolean;
}

interface CreateDrag {
  day: string;
  anchorMin: number;
  startMin: number;
  endMin: number;
  moved: boolean;
  /** Where the gesture started, for popover placement. */
  pointer: { x: number; y: number };
}

/** Whole 15 px text lines a block of this height holds (the chip decides what fits). */
const chipLines = (height: number) => Math.max(1, Math.floor((height - 4) / 15));

function isWeekend(day: string): boolean {
  const dow = new Date(`${day}T00:00:00`).getDay();
  return dow === 0 || dow === 6;
}

function hourLabel(hour: number): string {
  const h = hour % 24;
  if (h === 0) return '12 AM';
  if (h === 12) return 'Noon';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const minsToLabel = (mins: number) => clockLabel(mins, true);
/** Hour labels this close to the now-line give way to its time label. */
const NOW_LABEL_CLEAR_PX = 10;

const AllDayCell = memo(function AllDayCell({
  day,
  items,
  highlight,
  onChipPointerDown,
  onChipClick,
  onChipContextMenu,
  onEmptyClick,
  onEmptyContextMenu,
}: {
  day: string;
  items: CalendarItem[];
  highlight: boolean;
  onChipPointerDown: (e: ReactPointerEvent, item: CalendarItem) => void;
  onChipClick: (item: CalendarItem, el: HTMLElement) => void;
  onChipContextMenu?: (point: { x: number; y: number }, item: CalendarItem) => void;
  onEmptyClick: (day: string, el: HTMLElement) => void;
  onEmptyContextMenu?: (e: React.MouseEvent, day: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `allday:${day}` });
  return (
    <div
      ref={setNodeRef}
      className={`cal-allday-cell${isOver || highlight ? ' cal-dropover' : ''}`}
      data-day={day}
      onClick={(e) => {
        if (e.target === e.currentTarget) onEmptyClick(day, e.currentTarget);
      }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) onEmptyContextMenu?.(e, day);
      }}
    >
      {items.map((it) => (
        <CalendarChip
          key={it.id}
          item={it}
          compact
          onMovePointerDown={onChipPointerDown}
          onClick={onChipClick}
          onContextMenu={onChipContextMenu}
        />
      ))}
    </div>
  );
});

const DayColumn = memo(function DayColumn({
  day,
  isToday,
  items,
  ghostItemId,
  startMinute,
  endMinute,
  slotPx,
  onChipPointerDown,
  onResizePointerDown,
  onChipClick,
  onChipContextMenu,
  onEmptyPointerDown,
  onEmptyContextMenu,
}: {
  day: string;
  isToday: boolean;
  items: CalendarItem[];
  ghostItemId: string | null;
  startMinute: number;
  endMinute: number;
  slotPx: number;
  onChipPointerDown: (e: ReactPointerEvent, item: CalendarItem) => void;
  onResizePointerDown?: (e: ReactPointerEvent, item: CalendarItem) => void;
  onChipClick: (item: CalendarItem, el: HTMLElement) => void;
  onChipContextMenu?: (point: { x: number; y: number }, item: CalendarItem) => void;
  onEmptyPointerDown: (e: ReactPointerEvent, day: string) => void;
  onEmptyContextMenu?: (e: React.MouseEvent, day: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${day}` });

  const placements = useMemo(
    () => layoutDayEvents(items.map((it) => ({ id: it.id, startMin: Math.max(startMinute, it.startMin),
      endMin: Math.max(it.endMin, Math.max(startMinute, it.startMin) + MIN_EVENT_PX / slotPx * SLOT_MINUTES) }))),
    [items, startMinute, slotPx]
  );

  return (
    <div
      ref={setNodeRef}
      className={`cal-day-col${isToday ? ' cal-day-col-today' : ''}${isWeekend(day) ? ' cal-day-col-weekend' : ''}${isOver ? ' cal-dropover' : ''}`}
      data-day={day}
      onPointerDown={(e) => {
        // Empty-space only: chips call stopPropagation in their handler below.
        // Ignore non-primary buttons — right-click must not start a create drag.
        if (e.target === e.currentTarget && e.button === 0) onEmptyPointerDown(e, day);
      }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) onEmptyContextMenu?.(e, day);
      }}
    >
      {items.map((it) => {
        const p = placements.get(it.id)!;
        const start = Math.max(startMinute, it.startMin);
        const end = Math.min(endMinute, it.endMin);
        const top = gridY(start, startMinute, slotPx);
        const height = Math.min(gridY(endMinute, start, slotPx), Math.max(gridY(end, start, slotPx), MIN_EVENT_PX));
        const widthPct = 100 / p.laneCount;
        return (
          <CalendarChip
            key={it.id}
            item={it}
            lines={chipLines(height)}
            ghosted={ghostItemId === it.id}
            style={{
              top,
              height,
              left: `calc(${p.lane * widthPct}% + 2px)`,
              width: `calc(${widthPct}% - 4px)`,
              // Whole 15 px title lines the chip holds: a narrow phone chip wraps
              // its title over them (phone-pages-r3.css).
              '--cal-chip-lines': chipLines(height),
            } as React.CSSProperties}
            onMovePointerDown={(e, item) => {
              e.stopPropagation();
              onChipPointerDown(e, item);
            }}
            onResizePointerDown={it.endMin <= endMinute ? onResizePointerDown : undefined}
            onClick={onChipClick}
            onContextMenu={onChipContextMenu}
          />
        );
      })}
    </div>
  );
});

export const TimeGrid = memo(function TimeGrid({
  days,
  anchor,
  items,
  dropPreview,
  metricsRef,
  onMoveItem,
  onCopyItem,
  onResizeItem,
  onChipDragging,
  onCreate,
  onContextMenu,
  onItemClick,
  resizableAllDay = false,
  canCreateEvent = true,
}: Props) {
  const { zoom, fullDay } = useCalendarGridSettings();
  const startMinute = 0;
  const endMinute = fullDay ? 24 * 60 : GRID_EXTENDED_END;
  const [viewportHeight, setViewportHeight] = useState(0);
  const phone = usePhoneLayout();
  const fittedPx = fullDay ? SLOT_PX * zoom : fittedSlotPx(viewportHeight, zoom);
  // R3-06: fitting the work day into a phone screen gave 31 px an hour, under a
  // finger's chip. A phone keeps hours tall enough for a 30 minute block (like
  // iOS Calendar) and scrolls the day instead.
  const slotPx = phone ? Math.max(fittedPx, PHONE_MIN_SLOT_PX) : fittedPx;
  const hours = Array.from({ length: (endMinute - startMinute) / 60 }, (_, i) => startMinute / 60 + i);
  const dayList = useMemo(() => {
    const base = days === 7 ? weekRange(anchor) : [anchor];
    return base.map((d) => formatDateOnly(d));
  }, [days, anchor]);

  const today = new Date();
  const todayStr = formatDateOnly(today);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollMinuteRef = useRef(GRID_FOCUS_START);
  const colsRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);
  const allDayResize = useResizableHeight(ALL_DAY_HEIGHT_STORAGE_KEY, {
    min: ALL_DAY_MIN_HEIGHT,
    max: ALL_DAY_MAX_HEIGHT,
  });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => { if (scroller.clientHeight > 12) setViewportHeight(scroller.clientHeight); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Publish column rects for the page's dnd-kit slot math; refresh on layout.
  const publishMetrics = useCallback(() => {
    const cols = colsRef.current?.querySelectorAll<HTMLElement>('.cal-day-col');
    if (!cols) return;
    const colTops = new Map<string, DOMRect>();
    cols.forEach((el) => colTops.set(el.dataset.day!, el.getBoundingClientRect()));
    metricsRef.current = {
      colTops,
      slotPx,
      startMinute,
      endMinute,
      gridTop: scrollRef.current?.getBoundingClientRect().top ?? 0,
    };
  }, [metricsRef, slotPx, startMinute, endMinute]);

  useEffect(() => {
    publishMetrics();
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', publishMetrics, { passive: true });
    window.addEventListener('resize', publishMetrics);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && scroller
        ? new ResizeObserver(publishMetrics)
        : null;
    if (scroller) resizeObserver?.observe(scroller);
    return () => {
      scroller?.removeEventListener('scroll', publishMetrics);
      window.removeEventListener('resize', publishMetrics);
      resizeObserver?.disconnect();
    };
  }, [publishMetrics, dayList]);

  const previousScale = useRef<{ slotPx: number; days: number; fullDay: boolean } | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || viewportHeight <= 12) return;
    const previous = previousScale.current;
    const reset = !previous || previous.days !== days || previous.fullDay !== fullDay;
    const minute = reset ? (phone ? phoneLandingMinute(dayList) : fullDay ? 8 * 60 : GRID_FOCUS_START) : scrollMinuteRef.current;
    scroller.scrollTop = gridY(minute, 0, slotPx);
    if (Math.abs(scroller.scrollTop - gridY(minute, 0, slotPx)) > 1) {
      scrollMinuteRef.current = gridMinute(scroller.scrollTop, 0, slotPx);
    } else {
      scrollMinuteRef.current = minute;
    }
    previousScale.current = { slotPx, days, fullDay };
    publishMetrics();
  }, [slotPx, days, fullDay, viewportHeight, publishMetrics, phone, dayList]);

  // Now-line, re-anchored every 60s. visibleInterval: hidden tabs skip; the
  // catch-up tick on return recomputes from the clock, so it's never stale.
  const [nowMin, setNowMin] = useState(() => today.getHours() * 60 + today.getMinutes());
  useEffect(() => {
    return visibleInterval(() => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
  }, []);

  const showNow = dayList.includes(todayStr) && nowMin >= startMinute && nowMin < endMinute;

  const { allDayByDay, timedByDay } = useMemo(() => {
    const allDay = new Map<string, CalendarItem[]>();
    const timed = new Map<string, CalendarItem[]>();
    for (const d of dayList) {
      allDay.set(d, []);
      timed.set(d, []);
    }
    for (const it of timeGridItems(items, dayList, endMinute)) {
      const bucket = it.allDay ? allDay : timed;
      if (it.allDay || (it.endMin > startMinute && it.startMin < endMinute)) bucket.get(it.day)?.push(it);
    }
    for (const list of timed.values()) list.sort((a, b) => a.startMin - b.startMin);
    return { allDayByDay: allDay, timedByDay: timed };
  }, [items, dayList, startMinute, endMinute]);

  const dayAtX = useCallback(
    (x: number): string | null => {
      const metrics = metricsRef.current;
      if (!metrics) return null;
      for (const [day, rect] of metrics.colTops) {
        if (x >= rect.left && x <= rect.right) return day;
      }
      return null;
    },
    [metricsRef]
  );

  const minAtY = useCallback(
    (day: string, y: number): number => {
      const rect = metricsRef.current?.colTops.get(day);
      if (!rect) return 0;
      return gridSnapMinute(gridMinute(y - rect.top, startMinute, slotPx), SNAP_MINUTES, endMinute);
    },
    [metricsRef, startMinute, endMinute, slotPx]
  );

  // ---- chip move gesture -----------------------------------------------------
  const dragRef = useRef<ChipDrag | null>(null);
  // A pointer drag still emits a trailing click (down/up land on the same
  // element under capture). dragRef is nulled in onEnd — before that click —
  // so the "was this a drag?" answer must outlive it.
  const justDraggedRef = useRef(false);
  const [moveGhost, setMoveGhost] = useState<{
    itemId: string;
    day: string;
    startMin: number | null;
    lengthMin: number;
    title: string;
    tint: string;
    copy: boolean;
  } | null>(null);
  const copyable = useCallback((item: CalendarItem) => !!onCopyItem && canAltCopy(item), [onCopyItem]);
  // Alt pressed or let go while the pointer stands still changes the gesture too.
  useAltCopy(!!moveGhost, (alt) => {
    const drag = dragRef.current;
    if (!drag || !copyable(drag.item)) return;
    drag.copy = alt;
    setMoveGhost((g) => (g ? { ...g, copy: alt } : g));
  });

  const moveGesture = useDragGesture({
    onMove: (m) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (Math.abs(m.dx) + Math.abs(m.dy) > CLICK_TOLERANCE_PX) drag.moved = true;
      const overDay = dayAtX(m.x);
      if (!overDay) return;
      // Above the scrollable grid's viewport edge = the all-day row →
      // date-only preview. (Column rect tops are useless here once scrolled.)
      const inAllDay = m.y < (metricsRef.current?.gridTop ?? 0);
      const previewMin = inAllDay ? null : Math.max(Math.min(0, drag.item.startMin), Math.min(endMinute - SNAP_MINUTES, minAtY(overDay, m.y) - drag.grabOffsetMin));
      drag.overDay = overDay;
      drag.previewMin = previewMin;
      drag.copy = m.event.altKey && copyable(drag.item);
      setMoveGhost({
        itemId: drag.item.id,
        day: overDay,
        startMin: previewMin,
        lengthMin: drag.item.endMin - drag.item.startMin,
        title: drag.item.kind === 'event' ? drag.item.event.title : drag.item.task.title,
        tint: chipTint(drag.item),
        copy: drag.copy,
      });
    },
    onEnd: ({ canceled }) => {
      const drag = dragRef.current;
      dragRef.current = null;
      justDraggedRef.current = !!drag?.moved;
      setMoveGhost(null);
      onChipDragging(false);
      if (!drag || canceled || !drag.moved || !drag.overDay) return;
      const newWhen =
        drag.previewMin === null
          ? drag.overDay // dropped in the all-day row → strip the time
          : gridLocalIso(drag.overDay, drag.previewMin);
      if (newWhen === drag.item.when) return;
      if (drag.copy) onCopyItem?.(drag.item.id, newWhen);
      else onMoveItem(drag.item.id, newWhen);
    },
  });

  const handleChipPointerDown = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      if (item.kind === 'event' && item.event.readonly) return;
      publishMetrics();
      const grabMin = item.allDay ? 0 : minAtY(item.day, e.clientY) - item.startMin;
      dragRef.current = { item, grabOffsetMin: Math.max(0, grabMin), overDay: null, previewMin: null, moved: false, copy: e.altKey && copyable(item) };
      onChipDragging(true);
      moveGesture.onPointerDown(e);
    },
    [moveGesture, minAtY, onChipDragging, publishMetrics, copyable]
  );

  const handleChipClick = useCallback(
    (item: CalendarItem, el: HTMLElement) => {
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      onItemClick?.(item, el);
    },
    [onItemClick]
  );

  // ---- resize gesture (bottom edge; events + task-start chips) -----------------
  const resizeRef = useRef<{ item: CalendarItem; endMin: number; colTop: number } | null>(null);
  const [resizeGhost, setResizeGhost] = useState<{ itemId: string; day: string; startMin: number; endMin: number; tint: string } | null>(null);

  const resizeGesture = useDragGesture({
    cursor: 'ns-resize',
    onMove: (m) => {
      const rs = resizeRef.current;
      if (!rs) return;
      const rect = metricsRef.current?.colTops.get(rs.item.day);
      if (!rect) return;
      const raw = Math.round((rs.item.endMin + (m.dy + rs.colTop - rect.top) / slotPx * SLOT_MINUTES) / SNAP_MINUTES) * SNAP_MINUTES;
      rs.endMin = Math.min(Math.max(endMinute, rs.item.endMin), Math.max(rs.item.startMin + SNAP_MINUTES_MIN, raw));
      setResizeGhost({ itemId: rs.item.id, day: rs.item.day, startMin: rs.item.startMin, endMin: rs.endMin, tint: chipTint(rs.item) });
    },
    onEnd: ({ canceled }) => {
      const rs = resizeRef.current;
      resizeRef.current = null;
      setResizeGhost(null);
      // The resize pointerup also fires a trailing click on the chip — without
      // this it opened the item popover right after every resize (and its
      // backdrop then swallowed the next drag's pointerdown).
      justDraggedRef.current = true;
      if (!rs || canceled || !onResizeItem) return;
      if (rs.endMin === rs.item.endMin) return;
      const end = gridLocalIso(rs.item.day, rs.endMin);
      onResizeItem(rs.item.id, end);
    },
  });

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      if (item.kind === 'event' ? item.event.readonly : item.kind !== 'task-start' || item.allDay) return;
      publishMetrics();
      resizeRef.current = { item, endMin: item.endMin, colTop: metricsRef.current?.colTops.get(item.day)?.top ?? 0 };
      resizeGesture.onPointerDown(e);
    },
    [resizeGesture, publishMetrics]
  );

  // ---- drag-to-create gesture --------------------------------------------------
  // The kind a new item will be (the popover's kept Event | Task choice), so the
  // block being dragged reads "New Event" or "New Task" before the popover opens.
  const [keptKind] = usePageView<CreateKind>('calendar', 'createKind', 'event', isCreateKind);
  const createKind: CreateKind = canCreateEvent ? keptKind : 'task';
  // The block being dragged out is drawn in the colour it will have once dropped: the new
  // event's calendar (the default one the form starts on), or a task's.
  const newEventTint = useNewEventTint();
  const createTint = createKind === 'event' ? newEventTint ?? NEW_TASK_TINT : NEW_TASK_TINT;
  /** Where the popover draws the block being created: the day's column, minute → px. */
  const timedPlaceholder = useLeanCallback(
    (day: string) => {
      const host = colsRef.current?.querySelector<HTMLElement>(`.cal-day-col[data-day="${day}"]`);
      return host ? { host, day, minuteToPx: (m: number) => gridY(m, startMinute, slotPx) } : undefined;
    },
    [startMinute, slotPx]
  );
  const createRef = useRef<CreateDrag | null>(null);
  const [createSel, setCreateSel] = useState<CreateDrag | null>(null);

  const createGesture = useDragGesture({
    onMove: (m) => {
      const sel = createRef.current;
      if (!sel) return;
      sel.moved = true;
      const mins = minAtY(sel.day, m.y);
      sel.startMin = Math.min(sel.anchorMin, mins);
      sel.endMin = Math.max(sel.anchorMin + SLOT_MINUTES, mins);
      setCreateSel({ ...sel });
    },
    onEnd: ({ canceled }) => {
      const sel = createRef.current;
      createRef.current = null;
      setCreateSel(null);
      if (!sel || canceled) return;
      const placeholder = timedPlaceholder(sel.day);
      if (!sel.moved) {
        onCreate({
          start: gridLocalIso(sel.day, sel.anchorMin),
          anchorPoint: sel.pointer,
          placeholder,
        });
      } else {
        // Selection endpoints snap to SNAP_MINUTES (15), not SLOT_MINUTES (30)
        // — flooring into 30-min slots shaved up to 15 min off a :15/:45
        // endpoint (the overlay said 6:45, the created event ended 6:30).
        onCreate({
          start: gridLocalIso(sel.day, sel.startMin),
          end: gridLocalIso(sel.day, sel.endMin),
          anchorPoint: sel.pointer,
          placeholder,
        });
      }
    },
  });

  const handleEmptyPointerDown = useCallback(
    (e: ReactPointerEvent, day: string) => {
      publishMetrics();
      const mins = Math.min(endMinute - SLOT_MINUTES, gridSnapMinute(minAtY(day, e.clientY), SLOT_MINUTES, endMinute));
      createRef.current = {
        day,
        anchorMin: mins,
        startMin: mins,
        endMin: mins + SLOT_MINUTES,
        moved: false,
        pointer: { x: e.clientX, y: e.clientY },
      };
      createGesture.onPointerDown(e);
    },
    [createGesture, minAtY, endMinute, publishMetrics]
  );


  const handleAllDayEmptyClick = useCallback(
    (day: string, el: HTMLElement) => onCreate({ start: day, anchorEl: el, placeholder: { host: el } }),
    [onCreate]
  );

  // ---- right-click → calendar context menu --------------------------------------
  const handleChipContextMenu = useCallback(
    (point: { x: number; y: number }, item: CalendarItem) => onContextMenu?.(point, { item }),
    [onContextMenu]
  );

  const handleColContextMenu = useCallback(
    (e: React.MouseEvent, day: string) => {
      if (!onContextMenu) return;
      e.preventDefault();
      publishMetrics();
      const mins = Math.min(endMinute - SLOT_MINUTES, gridSnapMinute(minAtY(day, e.clientY), SLOT_MINUTES, endMinute));
      onContextMenu(
        { x: e.clientX, y: e.clientY },
        { seed: { start: gridLocalIso(day, mins), anchorPoint: { x: e.clientX, y: e.clientY }, placeholder: timedPlaceholder(day) } }
      );
    },
    [onContextMenu, minAtY, endMinute, publishMetrics, timedPlaceholder]
  );

  const handleAllDayContextMenu = useCallback(
    (e: React.MouseEvent, day: string) => {
      if (!onContextMenu) return;
      e.preventDefault();
      const host = e.currentTarget as HTMLElement;
      onContextMenu(
        { x: e.clientX, y: e.clientY },
        { seed: { start: day, anchorPoint: { x: e.clientX, y: e.clientY }, placeholder: { host } } }
      );
    },
    [onContextMenu]
  );

  const dayHeader = (dayStr: string) => {
    const d = new Date(Number(dayStr.slice(0, 4)), Number(dayStr.slice(5, 7)) - 1, Number(dayStr.slice(8, 10)));
    const isToday = dayStr === todayStr;
    return (
      <div key={dayStr} className={`cal-grid-dayhead${isToday ? ' today' : ''}`}>
        <span className="cal-grid-dayname">{d.toLocaleDateString('en', { weekday: 'short' })}</span>
        <span className="cal-grid-daynum">{d.getDate()}</span>
      </div>
    );
  };

  return (
    <div className={`cal-grid${moveGhost?.copy ? ' cal-grid-copying' : ''}`} data-days={days} data-start-minute={startMinute} data-end-minute={endMinute}
      style={{ '--cal-slot-px': `${slotPx}px`, '--cal-hour-px': `${slotPx * 2}px` } as React.CSSProperties}>
      <div className="cal-grid-header">
        <div className="cal-grid-gutter" />
        <div className="cal-grid-dayheads">{dayList.map(dayHeader)}</div>
      </div>
      <div
        ref={allDayRef}
        className={`cal-grid-allday${resizableAllDay ? ' cal-grid-allday-resizable' : ''}`}
        style={resizableAllDay ? { maxHeight: allDayResize.height ?? ALL_DAY_MAX_HEIGHT } : undefined}
      >
        <div className="cal-grid-gutter cal-allday-label">all-day</div>
        <div className="cal-allday-cells">
          {dayList.map((d) => (
            <AllDayCell
              key={d}
              day={d}
              items={allDayByDay.get(d) ?? []}
              highlight={
                (dropPreview?.zone === 'allday' && dropPreview.day === d) ||
                (moveGhost?.day === d && moveGhost.startMin === null)
              }
              onChipPointerDown={handleChipPointerDown}
              onChipClick={handleChipClick}
              onChipContextMenu={onContextMenu ? handleChipContextMenu : undefined}
              onEmptyClick={handleAllDayEmptyClick}
              onEmptyContextMenu={onContextMenu ? handleAllDayContextMenu : undefined}
            />
          ))}
        </div>
      </div>
      {resizableAllDay && (
        <div
          className={`cal-allday-resize-handle${allDayResize.isDragging ? ' dragging' : ''}`}
          data-testid="cal-allday-resize-handle"
          role="separator"
          aria-label="Resize all-day events"
          aria-orientation="horizontal"
          title="Drag to resize all-day events"
          onPointerDown={(e) => allDayResize.handlePointerDown(e, allDayRef.current)}
        />
      )}
      <div className="cal-grid-scroll" ref={scrollRef} onScroll={(e) => {
        if ((fullDay || e.currentTarget.clientHeight === viewportHeight) &&
          Math.abs(e.currentTarget.scrollTop - gridY(scrollMinuteRef.current, 0, slotPx)) > 1) {
          scrollMinuteRef.current = gridMinute(e.currentTarget.scrollTop, 0, slotPx);
        }
      }}>
        <div className="cal-grid-ruler" style={{ height: gridY(endMinute, startMinute, slotPx) }}>
          {hours.map((h) => (
            <div key={h} className="cal-grid-hour" style={{ height: slotPx * 2 }}>
              <span
                className="cal-grid-hourlabel"
                style={showNow && Math.abs(gridY(h * 60, startMinute, slotPx) - gridY(nowMin, startMinute, slotPx)) < NOW_LABEL_CLEAR_PX ? { visibility: 'hidden' } : undefined}
              >
                {hourLabel(h)}
              </span>
            </div>
          ))}
          {showNow && (
            <span className="cal-now-label" data-testid="cal-now-label" style={{ top: gridY(nowMin, startMinute, slotPx) }}>
              {clockLabel(nowMin, true)}
            </span>
          )}
          <span className="cal-grid-range-end">{hourLabel(endMinute / 60)}</span>
        </div>
        <div className="cal-grid-cols" ref={colsRef} style={{ height: gridY(endMinute, startMinute, slotPx) }}>
          {dayList.map((d) => (
            <DayColumn
              key={d}
              day={d}
              isToday={d === todayStr}
              items={timedByDay.get(d) ?? []}
              ghostItemId={moveGhost && !moveGhost.copy ? moveGhost.itemId : null}
              startMinute={startMinute}
              endMinute={endMinute}
              slotPx={slotPx}
              onChipPointerDown={handleChipPointerDown}
              onResizePointerDown={onResizeItem ? handleResizePointerDown : undefined}
              onChipClick={handleChipClick}
              onChipContextMenu={onContextMenu ? handleChipContextMenu : undefined}
              onEmptyPointerDown={handleEmptyPointerDown}
              onEmptyContextMenu={onContextMenu ? handleColContextMenu : undefined}
            />
          ))}

          {/* drop preview line for rail-task drags (page-computed) */}
          {dropPreview?.zone === 'col' && dropPreview.slot !== null && (
            <GridOverlay day={dropPreview.day} dayList={dayList}>
              <div className="cal-drop-line" style={{ top: gridY(dropPreview.slot * SLOT_MINUTES, startMinute, slotPx) }}>
                <span className="cal-drop-time">{minsToLabel(dropPreview.slot * SLOT_MINUTES)}</span>
              </div>
            </GridOverlay>
          )}

          {/* chip-move ghost — a solid chip look-alike (title + live time), so
              the drag reads as "the chip is in my hand", not a hollow outline */}
          {moveGhost && moveGhost.startMin !== null && (
            <GridOverlay day={moveGhost.day} dayList={dayList}>
              <div
                className={`cal-move-ghost cal-move-ghost-solid${moveGhost.copy ? ' cal-move-ghost-copy' : ''}`}
                data-testid="cal-move-ghost"
                data-copy={moveGhost.copy ? 'true' : undefined}
                style={{
                  top: gridY(moveGhost.startMin, startMinute, slotPx),
                  height: Math.max(gridY(moveGhost.lengthMin, 0, slotPx), MIN_EVENT_PX),
                  '--cal-chip-tint': moveGhost.tint,
                } as React.CSSProperties}
              >
                <span className="cal-move-ghost-title">{moveGhost.title}</span>
                <span className="cal-drop-time">{minsToLabel(moveGhost.startMin)}</span>
              </div>
            </GridOverlay>
          )}

          {/* event resize ghost */}
          {resizeGhost && (
            <GridOverlay day={resizeGhost.day} dayList={dayList}>
              <div
                className="cal-move-ghost"
                style={{
                  top: gridY(resizeGhost.startMin, startMinute, slotPx),
                  height: Math.max(gridY(resizeGhost.endMin, resizeGhost.startMin, slotPx), MIN_EVENT_PX),
                  '--cal-chip-tint': resizeGhost.tint,
                } as React.CSSProperties}
              >
                <span className="cal-drop-time" style={{ top: 'auto', bottom: -18 }}>
                  {minsToLabel(resizeGhost.endMin)}
                </span>
              </div>
            </GridOverlay>
          )}

          {/* drag-to-create selection */}
          {createSel && (
            <GridOverlay day={createSel.day} dayList={dayList}>
              <div
                className={`cal-chip cal-create-placeholder cal-create-sel${gridY(createSel.endMin, createSel.startMin, slotPx) < ONE_LINE_BELOW_PX ? ' cal-chip-oneline' : ''}`}
                data-kind={createKind}
                data-testid="cal-create-sel"
                style={{
                  top: gridY(createSel.startMin, startMinute, slotPx),
                  height: gridY(createSel.endMin, createSel.startMin, slotPx),
                  '--cal-chip-tint': createTint,
                } as React.CSSProperties}
              >
                <span className="cal-chip-title">{createKind === 'task' ? 'New Task' : 'New Event'}</span>
                <span className="cal-chip-time">{clockRange(createSel.startMin, createSel.endMin)}</span>
              </div>
            </GridOverlay>
          )}

          {/* now line: faint across the week, solid with a dot on today */}
          {showNow && days > 1 && (
            <div className="cal-now-line cal-now-line-faint" style={{ top: gridY(nowMin, startMinute, slotPx) }} />
          )}
          {showNow && (
            <GridOverlay day={todayStr} dayList={dayList}>
              <div className="cal-now-line" style={{ top: gridY(nowMin, startMinute, slotPx) }}>
                <span className="cal-now-dot" />
              </div>
            </GridOverlay>
          )}
        </div>
      </div>
    </div>
  );
});

/** Positions children over one day column using percentage offsets. */
function GridOverlay({ day, dayList, children }: { day: string; dayList: string[]; children: React.ReactNode }) {
  const idx = dayList.indexOf(day);
  if (idx === -1) return null;
  const width = 100 / dayList.length;
  return (
    <div className="cal-grid-overlay" style={{ left: `${idx * width}%`, width: `${width}%` }}>
      {children}
    </div>
  );
}
