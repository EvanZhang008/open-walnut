/**
 * CalendarChip — one item on the calendar. Purely presentational: the owning
 * view (MonthView / TimeGrid) instantiates a single useDragGesture and passes
 * `onMovePointerDown` down; the chip just arms it with its item. Geometry,
 * previews, and persistence all live in the view — one gesture per view, not
 * one per chip.
 */
import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { CalendarItem } from './calendar-items';

function timeLabel(startMin: number): string {
  const h24 = Math.floor(startMin / 60);
  const m = startMin % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export interface CalendarChipProps {
  item: CalendarItem;
  /** Absolute positioning from the view's layout pass (time grid) — none in month cells. */
  style?: CSSProperties;
  /** Compact single-line variant for month cells / all-day row. */
  compact?: boolean;
  /** The view is previewing this chip elsewhere — render the original ghosted. */
  ghosted?: boolean;
  onMovePointerDown?: (e: ReactPointerEvent, item: CalendarItem) => void;
  /** Bottom-edge resize (events only). */
  onResizePointerDown?: (e: ReactPointerEvent, item: CalendarItem) => void;
  onClick?: (item: CalendarItem, el: HTMLElement) => void;
}

export const CalendarChip = memo(function CalendarChip({
  item,
  style,
  compact,
  ghosted,
  onMovePointerDown,
  onResizePointerDown,
  onClick,
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

  return (
    <div
      className={cls}
      style={tint ? ({ ...style, '--cal-chip-tint': tint } as CSSProperties) : style}
      data-item-id={item.id}
      data-day={item.day}
      title={title}
      onPointerDown={readonly ? undefined : (e) => onMovePointerDown?.(e, item)}
      onClick={(e) => onClick?.(item, e.currentTarget)}
    >
      <span className="cal-chip-body">
        {isDue && (
          <svg className="cal-chip-flag" viewBox="0 0 24 24" fill="currentColor" aria-label="Due">
            <path d="M5 3v18h2v-7h11l-3-4.5L18 5H7V3H5z" />
          </svg>
        )}
        {!item.allDay && compact && <span className="cal-chip-time">{timeLabel(item.startMin)}</span>}
        <span className="cal-chip-title">{title}</span>
      </span>
      {isEvent && !compact && item.event.location && (
        <span className="cal-chip-location">{item.event.location}</span>
      )}
      {isEvent && !compact && !readonly && onResizePointerDown && (
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
