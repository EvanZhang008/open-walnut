/**
 * MonthView — the classic month grid. Each day cell is a coarse dnd-kit
 * droppable (`day:YYYY-MM-DD`) for rail-task drops; moving a chip that is
 * already on the calendar uses ONE view-level useDragGesture (pointer math
 * over captured cell rects — no per-cell droppable churn mid-drag).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDroppable } from '@dnd-kit/core';
import { useDragGesture } from '@/hooks/useDragGesture';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { formatDateOnly, monthGridRange, sameDay } from '@/utils/calendar-date';
import type { CalendarItem } from './calendar-items';
import { CalendarChip } from './CalendarChip';
import type { CreateSeed } from './QuickCreatePopover';

const MAX_CHIPS = 3;
const CLICK_TOLERANCE_PX = 4;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  anchor: Date;
  items: CalendarItem[];
  /** A rail-task dnd-kit drag is in flight (highlights droppables via dnd-kit). */
  dragging: boolean;
  onMoveItem: (itemId: string, newWhen: string) => void;
  /** Report chip-gesture activity up so the page freezes the item arrays. */
  onChipDragging: (dragging: boolean) => void;
  onCreate: (seed: CreateSeed) => void;
  onNavigateDay: (day: string) => void;
  /** Right-click on a chip or empty cell → calendar context menu. */
  onContextMenu?: (point: { x: number; y: number }, target: { item?: CalendarItem; seed?: CreateSeed }) => void;
  /** Click on any chip → the item edit popover (macOS-Calendar-style). */
  onItemClick?: (item: CalendarItem, el: HTMLElement) => void;
}

interface ChipDrag {
  item: CalendarItem;
  /** day under the pointer right now (preview target). */
  overDay: string | null;
  moved: boolean;
}

const MonthDayCell = memo(function MonthDayCell({
  day,
  inMonth,
  isToday,
  items,
  previewDay,
  draggedItemId,
  onChipPointerDown,
  onChipClick,
  onChipContextMenu,
  onEmptyClick,
  onEmptyContextMenu,
  onNavigateDay,
  onShowOverflow,
}: {
  day: Date;
  inMonth: boolean;
  isToday: boolean;
  items: CalendarItem[];
  previewDay: string | null;
  draggedItemId: string | null;
  onChipPointerDown: (e: ReactPointerEvent, item: CalendarItem) => void;
  onChipClick: (item: CalendarItem, el: HTMLElement) => void;
  onChipContextMenu?: (point: { x: number; y: number }, item: CalendarItem) => void;
  onEmptyClick: (day: string, el: HTMLElement) => void;
  onEmptyContextMenu?: (e: React.MouseEvent, day: string) => void;
  onNavigateDay: (day: string) => void;
  onShowOverflow: (day: string, el: HTMLElement) => void;
}) {
  const dayStr = formatDateOnly(day);
  const { setNodeRef, isOver } = useDroppable({ id: `day:${dayStr}` });
  const visible = items.slice(0, MAX_CHIPS);
  const overflow = items.length - visible.length;

  return (
    <div
      ref={setNodeRef}
      className={[
        'cal-month-cell',
        inMonth ? '' : 'cal-month-cell-outside',
        isToday ? 'cal-month-cell-today' : '',
        isOver || previewDay === dayStr ? 'cal-month-cell-dropover' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-day={dayStr}
      onClick={(e) => {
        // Only empty-space clicks create; chips/buttons stop propagation.
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('cal-month-chips')) {
          onEmptyClick(dayStr, e.currentTarget);
        }
      }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('cal-month-chips')) {
          onEmptyContextMenu?.(e, dayStr);
        }
      }}
    >
      <button
        className="cal-month-daynum"
        onClick={(e) => {
          e.stopPropagation();
          onNavigateDay(dayStr);
        }}
      >
        {day.getDate() === 1 ? `${day.toLocaleString('en', { month: 'short' })} ${day.getDate()}` : day.getDate()}
      </button>
      <div className="cal-month-chips">
        {visible.map((it) => (
          <CalendarChip
            key={it.id}
            item={it}
            compact
            ghosted={draggedItemId === it.id}
            onMovePointerDown={onChipPointerDown}
            onClick={onChipClick}
            onContextMenu={onChipContextMenu}
          />
        ))}
        {overflow > 0 && (
          <button
            className="cal-month-more"
            onClick={(e) => {
              e.stopPropagation();
              onShowOverflow(dayStr, e.currentTarget);
            }}
          >
            +{overflow} more
          </button>
        )}
      </div>
    </div>
  );
});

export const MonthView = memo(function MonthView({
  anchor,
  items,
  dragging,
  onMoveItem,
  onChipDragging,
  onCreate,
  onNavigateDay,
  onContextMenu,
  onItemClick,
}: Props) {
  const weeks = useMemo(() => monthGridRange(anchor), [anchor]);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = new Date();

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of items) {
      const list = m.get(it.day);
      if (list) list.push(it);
      else m.set(it.day, [it]);
    }
    for (const list of m.values()) {
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMin - b.startMin);
    }
    return m;
  }, [items]);

  // ---- overflow popover ----------------------------------------------------
  const [overflowDay, setOverflowDay] = useState<string | null>(null);
  const overflowAnchorRef = useRef<HTMLElement | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const overflowPlacement = useMenuPlacement(overflowDay !== null, overflowAnchorRef, overflowMenuRef);

  const showOverflow = useCallback((day: string, el: HTMLElement) => {
    overflowAnchorRef.current = el;
    setOverflowDay(day);
  }, []);

  // Window-level Escape for the overflow popover — it has no focusable content,
  // so element-level onKeyDown can never fire. Without this, Escape left the
  // (invisible) full-screen backdrop up and it silently swallowed the next chip
  // drag: pointerdown landed on the backdrop, no gesture armed, and the
  // trailing mouseup closed the popover — so the retry "mysteriously" worked
  // and the failure read as speed-dependent (customer-journey finding).
  useEffect(() => {
    if (overflowDay === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowDay(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [overflowDay]);

  // ---- chip move gesture (one per view) -------------------------------------
  const dragRef = useRef<ChipDrag | null>(null);
  // Survives dragRef's reset in onEnd so the trailing click can be suppressed.
  const justDraggedRef = useRef(false);
  // Cell rects are captured once per drag; scrolling mid-drag is impossible
  // (body is locked by useDragGesture's user-select/none + short drags).
  const cellRectsRef = useRef<{ day: string; rect: DOMRect }[]>([]);
  const [preview, setPreview] = useState<{ itemId: string; overDay: string } | null>(null);
  // Floating chip clone under the cursor — the "in my hand" feedback the cell
  // highlight alone doesn't give.
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number; title: string; tint?: string } | null>(null);

  const dayAtPoint = useCallback((x: number, y: number): string | null => {
    for (const { day, rect } of cellRectsRef.current) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return day;
    }
    return null;
  }, []);

  const gesture = useDragGesture({
    onMove: (m) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (Math.abs(m.dx) + Math.abs(m.dy) > CLICK_TOLERANCE_PX) drag.moved = true;
      if (drag.moved) {
        setDragPointer({
          x: m.x,
          y: m.y,
          title: drag.item.kind === 'event' ? drag.item.event.title : drag.item.task.title,
          tint: drag.item.kind === 'event' ? drag.item.event.color : undefined,
        });
      }
      const overDay = dayAtPoint(m.x, m.y);
      if (overDay !== drag.overDay) {
        drag.overDay = overDay;
        // useDragGesture already coalesces to one call per frame — safe to set state here.
        setPreview(overDay ? { itemId: drag.item.id, overDay } : null);
      }
    },
    onEnd: ({ canceled }) => {
      const drag = dragRef.current;
      dragRef.current = null;
      justDraggedRef.current = !!drag?.moved;
      setPreview(null);
      setDragPointer(null);
      onChipDragging(false);
      if (!drag || canceled || !drag.moved || !drag.overDay || drag.overDay === drag.item.day) return;
      // Day-to-day move preserves time-of-day when the value had one.
      const newWhen = drag.item.when.includes('T')
        ? `${drag.overDay}T${drag.item.when.split('T')[1]}`
        : drag.overDay;
      onMoveItem(drag.item.id, newWhen);
    },
  });

  const handleChipPointerDown = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      if (item.kind === 'event' && item.event.readonly) return;
      const grid = gridRef.current;
      if (!grid) return;
      cellRectsRef.current = Array.from(grid.querySelectorAll<HTMLElement>('.cal-month-cell')).map((el) => ({
        day: el.dataset.day!,
        rect: el.getBoundingClientRect(),
      }));
      dragRef.current = { item, overDay: null, moved: false };
      onChipDragging(true);
      gesture.onPointerDown(e);
    },
    [gesture, onChipDragging]
  );

  const handleChipClick = useCallback(
    (item: CalendarItem, el: HTMLElement) => {
      // A drag that traveled suppresses its trailing click; a plain click opens
      // the in-place item popover (page-level).
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      onItemClick?.(item, el);
    },
    [onItemClick]
  );

  const handleEmptyClick = useCallback(
    (day: string, el: HTMLElement) => onCreate({ start: day, anchorEl: el }),
    [onCreate]
  );

  const handleChipContextMenu = useCallback(
    (point: { x: number; y: number }, item: CalendarItem) => onContextMenu?.(point, { item }),
    [onContextMenu]
  );

  const handleEmptyContextMenu = useCallback(
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

  const overflowItems = overflowDay ? byDay.get(overflowDay) ?? [] : [];

  return (
    <div className={`cal-month${dragging ? ' cal-month-dragging' : ''}`} ref={gridRef}>
      <div className="cal-month-weekdays">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-month-weekday">
            {w}
          </div>
        ))}
      </div>
      <div className="cal-month-grid" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.flat().map((day) => {
          const dayStr = formatDateOnly(day);
          return (
            <MonthDayCell
              key={dayStr}
              day={day}
              inMonth={day.getMonth() === anchor.getMonth()}
              isToday={sameDay(day, today)}
              items={byDay.get(dayStr) ?? []}
              previewDay={preview?.overDay ?? null}
              draggedItemId={preview?.itemId ?? null}
              onChipPointerDown={handleChipPointerDown}
              onChipClick={handleChipClick}
              onChipContextMenu={onContextMenu ? handleChipContextMenu : undefined}
              onEmptyClick={handleEmptyClick}
              onEmptyContextMenu={onContextMenu ? handleEmptyContextMenu : undefined}
              onNavigateDay={onNavigateDay}
              onShowOverflow={showOverflow}
            />
          );
        })}
      </div>
      {dragPointer &&
        createPortal(
          <div
            className="cal-drag-cursor-chip"
            style={{
              left: dragPointer.x + 10,
              top: dragPointer.y + 12,
              ...(dragPointer.tint ? ({ '--cal-chip-tint': dragPointer.tint } as React.CSSProperties) : {}),
            }}
          >
            {dragPointer.title}
          </div>,
          document.body
        )}
      {overflowDay &&
        createPortal(
          <>
            <div className="cal-popover-backdrop" onClick={() => setOverflowDay(null)} />
            <div className="cal-overflow-popover" ref={overflowMenuRef} style={menuPlacementStyle(overflowPlacement)}>
              <div className="cal-overflow-title">{overflowDay}</div>
              {overflowItems.map((it) => (
                <CalendarChip
                  key={it.id}
                  item={it}
                  compact
                  onMovePointerDown={(e, item) => {
                    setOverflowDay(null);
                    handleChipPointerDown(e, item);
                  }}
                  onClick={handleChipClick}
                  onContextMenu={
                    onContextMenu
                      ? (point, item) => {
                          setOverflowDay(null);
                          handleChipContextMenu(point, item);
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
});
