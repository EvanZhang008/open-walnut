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
 *    writes at most once per painted frame.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useDragGesture } from '@/hooks/useDragGesture';
import {
  SLOT_MINUTES,
  SNAP_MINUTES,
  formatDateOnly,
  layoutDayEvents,
  snapMinutes,
  slotToLocalIso,
  weekRange,
} from '@/utils/calendar-date';
import type { CalendarItem } from './calendar-items';
import { CalendarChip } from './CalendarChip';
import type { CreateSeed } from './QuickCreatePopover';

export const SLOT_PX = 24; // 30-min row height → 48px/hour, 1152px/day
const CLICK_TOLERANCE_PX = 4;
const MIN_EVENT_PX = 20;
/** Resize can't shrink an event below this. */
const SNAP_MINUTES_MIN = 15;

export interface DropPreview {
  day: string;
  /** null for month/all-day zones (no time component). */
  slot: number | null;
  zone: 'day' | 'allday' | 'col';
}

export interface GridMetrics {
  colTops: Map<string, DOMRect>;
  slotPx: number;
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
  onResizeEvent?: (itemId: string, newEnd: string) => void;
  onChipDragging: (dragging: boolean) => void;
  onCreate: (seed: CreateSeed) => void;
  /** Right-click on a chip or empty slot → calendar context menu. */
  onContextMenu?: (point: { x: number; y: number }, target: { item?: CalendarItem; seed?: CreateSeed }) => void;
  /** Click on any chip → the item edit popover (macOS-Calendar-style). */
  onItemClick?: (item: CalendarItem, el: HTMLElement) => void;
}

interface ChipDrag {
  item: CalendarItem;
  /** Pointer offset inside the chip at grab, so the ghost doesn't jump. */
  grabOffsetMin: number;
  overDay: string | null;
  /** Snapped minutes-of-day for the ghost top (null → all-day row). */
  previewMin: number | null;
  moved: boolean;
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

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  if (h === 0) return '';
  if (h === 12) return 'Noon';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function minsToLabel(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

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
  onChipPointerDown: (e: ReactPointerEvent, item: CalendarItem) => void;
  onResizePointerDown?: (e: ReactPointerEvent, item: CalendarItem) => void;
  onChipClick: (item: CalendarItem, el: HTMLElement) => void;
  onChipContextMenu?: (point: { x: number; y: number }, item: CalendarItem) => void;
  onEmptyPointerDown: (e: ReactPointerEvent, day: string) => void;
  onEmptyContextMenu?: (e: React.MouseEvent, day: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${day}` });

  const placements = useMemo(
    () => layoutDayEvents(items.map((it) => ({ id: it.id, startMin: it.startMin, endMin: it.endMin }))),
    [items]
  );

  return (
    <div
      ref={setNodeRef}
      className={`cal-day-col${isToday ? ' cal-day-col-today' : ''}${isOver ? ' cal-dropover' : ''}`}
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
        const top = (it.startMin / SLOT_MINUTES) * SLOT_PX;
        const height = Math.max(((it.endMin - it.startMin) / SLOT_MINUTES) * SLOT_PX, MIN_EVENT_PX);
        const widthPct = 100 / p.laneCount;
        return (
          <CalendarChip
            key={it.id}
            item={it}
            ghosted={ghostItemId === it.id}
            style={{
              top,
              height,
              left: `calc(${p.lane * widthPct}% + 2px)`,
              width: `calc(${widthPct}% - 4px)`,
            }}
            onMovePointerDown={(e, item) => {
              e.stopPropagation();
              onChipPointerDown(e, item);
            }}
            onResizePointerDown={onResizePointerDown}
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
  onResizeEvent,
  onChipDragging,
  onCreate,
  onContextMenu,
  onItemClick,
}: Props) {
  const dayList = useMemo(() => {
    const base = days === 7 ? weekRange(anchor) : [anchor];
    return base.map((d) => formatDateOnly(d));
  }, [days, anchor]);

  const today = new Date();
  const todayStr = formatDateOnly(today);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);

  // Publish column rects for the page's dnd-kit slot math; refresh on layout.
  const publishMetrics = useCallback(() => {
    const cols = colsRef.current?.querySelectorAll<HTMLElement>('.cal-day-col');
    if (!cols) return;
    const colTops = new Map<string, DOMRect>();
    cols.forEach((el) => colTops.set(el.dataset.day!, el.getBoundingClientRect()));
    metricsRef.current = {
      colTops,
      slotPx: SLOT_PX,
      gridTop: scrollRef.current?.getBoundingClientRect().top ?? 0,
    };
  }, [metricsRef]);

  useEffect(() => {
    publishMetrics();
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', publishMetrics, { passive: true });
    window.addEventListener('resize', publishMetrics);
    return () => {
      scroller?.removeEventListener('scroll', publishMetrics);
      window.removeEventListener('resize', publishMetrics);
    };
  }, [publishMetrics, dayList]);

  // Auto-scroll to ~8 AM on mount / day-count change.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 8 * 2 * SLOT_PX - 12 });
  }, [days]);

  // Now-line, re-anchored every 60s.
  const [nowMin, setNowMin] = useState(() => today.getHours() * 60 + today.getMinutes());
  useEffect(() => {
    const t = setInterval(() => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const { allDayByDay, timedByDay } = useMemo(() => {
    const allDay = new Map<string, CalendarItem[]>();
    const timed = new Map<string, CalendarItem[]>();
    for (const d of dayList) {
      allDay.set(d, []);
      timed.set(d, []);
    }
    for (const it of items) {
      const bucket = it.allDay ? allDay : timed;
      bucket.get(it.day)?.push(it);
    }
    for (const list of timed.values()) list.sort((a, b) => a.startMin - b.startMin);
    return { allDayByDay: allDay, timedByDay: timed };
  }, [items, dayList]);

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
      return snapMinutes(((y - rect.top) / SLOT_PX) * SLOT_MINUTES);
    },
    [metricsRef]
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
    tint?: string;
  } | null>(null);

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
      const previewMin = inAllDay ? null : Math.max(0, minAtY(overDay, m.y) - drag.grabOffsetMin);
      drag.overDay = overDay;
      drag.previewMin = previewMin;
      setMoveGhost({
        itemId: drag.item.id,
        day: overDay,
        startMin: previewMin,
        lengthMin: drag.item.endMin - drag.item.startMin,
        title: drag.item.kind === 'event' ? drag.item.event.title : drag.item.task.title,
        tint: drag.item.kind === 'event' ? drag.item.event.color : undefined,
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
          : `${drag.overDay}T${String(Math.floor(drag.previewMin / 60)).padStart(2, '0')}:${String(drag.previewMin % 60).padStart(2, '0')}:00`;
      if (newWhen !== drag.item.when) onMoveItem(drag.item.id, newWhen);
    },
  });

  const handleChipPointerDown = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      if (item.kind === 'event' && item.event.readonly) return;
      publishMetrics();
      const grabMin = item.allDay ? 0 : minAtY(item.day, e.clientY) - item.startMin;
      dragRef.current = { item, grabOffsetMin: Math.max(0, grabMin), overDay: null, previewMin: null, moved: false };
      onChipDragging(true);
      moveGesture.onPointerDown(e);
    },
    [moveGesture, minAtY, onChipDragging, onResizeEvent, publishMetrics]
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

  // ---- event resize gesture (bottom edge; events only) -------------------------
  const resizeRef = useRef<{ item: CalendarItem; endMin: number } | null>(null);
  const [resizeGhost, setResizeGhost] = useState<{ itemId: string; day: string; startMin: number; endMin: number } | null>(null);

  const resizeGesture = useDragGesture({
    cursor: 'ns-resize',
    onMove: (m) => {
      const rs = resizeRef.current;
      if (!rs) return;
      const raw = minAtY(rs.item.day, m.y);
      rs.endMin = Math.max(rs.item.startMin + SNAP_MINUTES_MIN, raw);
      setResizeGhost({ itemId: rs.item.id, day: rs.item.day, startMin: rs.item.startMin, endMin: rs.endMin });
    },
    onEnd: ({ canceled }) => {
      const rs = resizeRef.current;
      resizeRef.current = null;
      setResizeGhost(null);
      if (!rs || canceled || !onResizeEvent) return;
      if (rs.endMin === rs.item.endMin) return;
      const end = `${rs.item.day}T${String(Math.floor(rs.endMin / 60)).padStart(2, '0')}:${String(rs.endMin % 60).padStart(2, '0')}:00`;
      onResizeEvent(rs.item.id, end);
    },
  });

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      if (item.kind !== 'event' || item.event.readonly) return;
      publishMetrics();
      resizeRef.current = { item, endMin: item.endMin };
      resizeGesture.onPointerDown(e);
    },
    [resizeGesture, publishMetrics]
  );

  // ---- drag-to-create gesture --------------------------------------------------
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
      if (!sel.moved) {
        onCreate({
          start: slotToLocalIso(sel.day, Math.floor(sel.anchorMin / SLOT_MINUTES)),
          anchorPoint: sel.pointer,
        });
      } else {
        // Selection endpoints snap to SNAP_MINUTES (15), not SLOT_MINUTES (30)
        // — flooring into 30-min slots shaved up to 15 min off a :15/:45
        // endpoint (the overlay said 6:45, the created event ended 6:30).
        onCreate({
          start: slotToLocalIso(sel.day, sel.startMin / SNAP_MINUTES, SNAP_MINUTES),
          end: slotToLocalIso(sel.day, sel.endMin / SNAP_MINUTES, SNAP_MINUTES),
          anchorPoint: sel.pointer,
        });
      }
    },
  });

  const handleEmptyPointerDown = useCallback(
    (e: ReactPointerEvent, day: string) => {
      publishMetrics();
      const mins = snapMinutes(minAtY(day, e.clientY), SLOT_MINUTES);
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
    [createGesture, minAtY, publishMetrics]
  );

  const handleAllDayEmptyClick = useCallback(
    (day: string, el: HTMLElement) => onCreate({ start: day, anchorEl: el }),
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
      const mins = snapMinutes(minAtY(day, e.clientY), SLOT_MINUTES);
      onContextMenu(
        { x: e.clientX, y: e.clientY },
        { seed: { start: slotToLocalIso(day, Math.floor(mins / SLOT_MINUTES)), anchorPoint: { x: e.clientX, y: e.clientY } } }
      );
    },
    [onContextMenu, minAtY, publishMetrics]
  );

  const handleAllDayContextMenu = useCallback(
    (e: React.MouseEvent, day: string) => {
      if (!onContextMenu) return;
      e.preventDefault();
      onContextMenu(
        { x: e.clientX, y: e.clientY },
        { seed: { start: day, anchorPoint: { x: e.clientX, y: e.clientY } } }
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
    <div className="cal-grid" data-days={days}>
      <div className="cal-grid-header">
        <div className="cal-grid-gutter" />
        <div className="cal-grid-dayheads">{dayList.map(dayHeader)}</div>
      </div>
      <div className="cal-grid-allday">
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
      <div className="cal-grid-scroll" ref={scrollRef}>
        <div className="cal-grid-ruler">
          {HOURS.map((h) => (
            <div key={h} className="cal-grid-hour" style={{ height: SLOT_PX * 2 }}>
              <span className="cal-grid-hourlabel">{hourLabel(h)}</span>
            </div>
          ))}
        </div>
        <div className="cal-grid-cols" ref={colsRef} style={{ height: SLOT_PX * 2 * 24 }}>
          {dayList.map((d) => (
            <DayColumn
              key={d}
              day={d}
              isToday={d === todayStr}
              items={timedByDay.get(d) ?? []}
              ghostItemId={moveGhost?.itemId ?? null}
              onChipPointerDown={handleChipPointerDown}
              onResizePointerDown={onResizeEvent ? handleResizePointerDown : undefined}
              onChipClick={handleChipClick}
              onChipContextMenu={onContextMenu ? handleChipContextMenu : undefined}
              onEmptyPointerDown={handleEmptyPointerDown}
              onEmptyContextMenu={onContextMenu ? handleColContextMenu : undefined}
            />
          ))}

          {/* drop preview line for rail-task drags (page-computed) */}
          {dropPreview?.zone === 'col' && dropPreview.slot !== null && (
            <GridOverlay day={dropPreview.day} dayList={dayList}>
              <div className="cal-drop-line" style={{ top: dropPreview.slot * SLOT_PX }}>
                <span className="cal-drop-time">{minsToLabel(dropPreview.slot * SLOT_MINUTES)}</span>
              </div>
            </GridOverlay>
          )}

          {/* chip-move ghost — a solid chip look-alike (title + live time), so
              the drag reads as "the chip is in my hand", not a hollow outline */}
          {moveGhost && moveGhost.startMin !== null && (
            <GridOverlay day={moveGhost.day} dayList={dayList}>
              <div
                className="cal-move-ghost cal-move-ghost-solid"
                style={{
                  top: (moveGhost.startMin / SLOT_MINUTES) * SLOT_PX,
                  height: Math.max((moveGhost.lengthMin / SLOT_MINUTES) * SLOT_PX, MIN_EVENT_PX),
                  ...(moveGhost.tint ? ({ '--cal-chip-tint': moveGhost.tint } as React.CSSProperties) : {}),
                }}
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
                  top: (resizeGhost.startMin / SLOT_MINUTES) * SLOT_PX,
                  height: Math.max(((resizeGhost.endMin - resizeGhost.startMin) / SLOT_MINUTES) * SLOT_PX, MIN_EVENT_PX),
                }}
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
                className="cal-create-sel"
                style={{
                  top: (createSel.startMin / SLOT_MINUTES) * SLOT_PX,
                  height: ((createSel.endMin - createSel.startMin) / SLOT_MINUTES) * SLOT_PX,
                }}
              >
                <span className="cal-drop-time">
                  {minsToLabel(createSel.startMin)} – {minsToLabel(createSel.endMin)}
                </span>
              </div>
            </GridOverlay>
          )}

          {/* now line */}
          {dayList.includes(todayStr) && (
            <GridOverlay day={todayStr} dayList={dayList}>
              <div className="cal-now-line" style={{ top: (nowMin / SLOT_MINUTES) * SLOT_PX }}>
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
