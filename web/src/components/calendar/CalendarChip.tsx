/**
 * CalendarChip — one item on the calendar. Purely presentational: the owning
 * view (MonthView / TimeGrid) instantiates a single useDragGesture and passes
 * `onMovePointerDown` down; the chip just arms it with its item. Geometry,
 * previews, and persistence all live in the view — one gesture per view, not
 * one per chip.
 */
import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { clockLabel, clockRange } from '@/utils/calendar-date';
import type { CalendarItem } from './calendar-items';

export interface CalendarChipProps {
  item: CalendarItem;
  /** Absolute positioning from the view's layout pass (time grid) — none in month cells. */
  style?: CSSProperties;
  /** Compact single-line variant for month cells / all-day row. */
  compact?: boolean;
  /**
   * Time-grid blocks: whole text lines the block's height holds. The title takes
   * what the time and location lines leave, so no line is ever cut in half.
   */
  lines?: number;
  /** The view is previewing this chip elsewhere — render the original ghosted. */
  ghosted?: boolean;
  onMovePointerDown?: (e: ReactPointerEvent, item: CalendarItem) => void;
  /** Bottom-edge resize (events + timed task-start chips). */
  onResizePointerDown?: (e: ReactPointerEvent, item: CalendarItem) => void;
  onClick?: (item: CalendarItem, el: HTMLElement) => void;
  /** Right-click → calendar context menu (replaces the browser menu). */
  onContextMenu?: (point: { x: number; y: number }, item: CalendarItem) => void;
}

export const CalendarChip = memo(function CalendarChip({
  item,
  style,
  compact,
  lines,
  ghosted,
  onMovePointerDown,
  onResizePointerDown,
  onClick,
  onContextMenu,
}: CalendarChipProps) {
  const isEvent = item.kind === 'event';
  const isDue = item.kind === 'task-due';
  const readonly = isEvent && (item.event.readonly || !onMovePointerDown);
  const title = isEvent ? item.event.title : item.task.title;

  const cls = [
    'cal-chip',
    `cal-chip-${item.kind}`,
    compact ? 'cal-chip-compact' : '',
    ghosted ? 'cal-chip-ghosted' : '',
    readonly ? 'cal-chip-readonly' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tint = isEvent ? item.event.color : undefined;
  // A timed block: title first, then its time, then where (each only when a whole line is left).
  const block = !compact && lines !== undefined;
  const showTime = block && !item.allDay && lines >= 2;
  const location = isEvent ? item.event.location : undefined;
  const showLocation = block && !!location && lines >= (showTime ? 3 : 2);
  const titleLines = block ? Math.max(1, lines - (showTime ? 1 : 0) - (showLocation ? 1 : 0)) : 1;

  return (
    <div data-peek-row=""
      // Timed blocks encode duration in their absolute geometry. Their full text is in the
      // click-open detail, not a hover expansion that covers the next event. List chips grow.
      data-peek={style?.top !== undefined ? 'off' : undefined}
      className={cls}
      style={{ ...style, ...(tint ? { '--cal-chip-tint': tint } : {}), ...(block ? { '--cal-title-lines': titleLines } : {}) } as CSSProperties}
      data-lines={block ? lines : undefined}
      data-item-id={item.id}
      data-day={item.day}
      aria-label={isDue ? `Due: ${title}` : title}
      onPointerDown={readonly ? undefined : (e) => {
        if (e.button !== 0) return; // right/middle button must not arm a drag
        onMovePointerDown?.(e, item);
      }}
      onClick={(e) => onClick?.(item, e.currentTarget)}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu({ x: e.clientX, y: e.clientY }, item);
            }
          : undefined
      }
    >
      <span className="cal-chip-body">
        {isDue && (
          <svg className="cal-chip-flag" viewBox="0 0 24 24" fill="currentColor" aria-label="Due">
            <path d="M5 3v18h2v-7h11l-3-4.5L18 5H7V3H5z" />
          </svg>
        )}
        {!item.allDay && compact && <span className="cal-chip-time">{clockLabel(item.startMin)}</span>}
        <span className="cal-chip-title">{title}</span>
      </span>
      {showTime && (
        <span className="cal-chip-time cal-chip-range">
          {isDue ? `Due ${clockLabel(item.startMin)}` : clockRange(item.startMin, item.endMin)}
        </span>
      )}
      {(block ? showLocation : !compact && !!location) && <span className="cal-chip-location">{location}</span>}
      {(isEvent || item.kind === 'task-start') && !item.allDay && !compact && !readonly && onResizePointerDown && (
        <div
          className="cal-chip-resize-handle"
          onPointerDown={(e) => {
            e.stopPropagation(); // must not arm the move gesture
            onResizePointerDown(e, item);
          }}
        />
      )}
    </div>
  );
});
