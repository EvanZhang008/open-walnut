/**
 * The calendar's in-grid pieces that are portalled but never float over the page as an overlay:
 *  - CreatePlaceholder: the block being created, drawn in the grid itself (a portal into the day
 *    column or all-day cell), so it sits exactly where the item will land and scrolls with the grid;
 *  - DragCursorChip: the month view's chip under the pointer while a chip is dragged (a drag ghost).
 * Each takes its colour from item-tint.ts (tests/web/calendar-drag-tint-guard.test.ts).
 */
import { createPortal } from 'react-dom';
import { clockRange, minutesOfDay } from '@/utils/calendar-date';
import type { EventPreview } from './EventCreateForm';
import type { CreateKind, CreatePlaceholder, CreateSeed } from './QuickCreatePopover';
import { NEW_TASK_TINT, useNewEventTint } from './item-tint';

/** A block shorter than this shows its title and time on one line. */
export const ONE_LINE_BELOW_PX = 30;

/** The block being created; event side: the form's live title, times and colour. */
export function CreatePlaceholderBlock({
  blockRef,
  placeholder,
  seed,
  kind,
  preview,
}: {
  blockRef: React.Ref<HTMLDivElement>;
  placeholder: CreatePlaceholder;
  seed: CreateSeed;
  kind: CreateKind;
  preview: EventPreview | null;
}) {
  const seedDay = seed.start.slice(0, 10);
  const hostDay = placeholder.day ?? seedDay;
  const timedHost = !!placeholder.minuteToPx;
  const seedStart = seed.start.includes('T') ? minutesOfDay(seed.start) : null;
  const seedEnd = seed.end?.includes('T')
    ? (seed.end.slice(0, 10) > seedDay ? 24 * 60 : minutesOfDay(seed.end))
    : seedStart === null ? null : Math.min(seedStart + (kind === 'event' ? 60 : 30), 24 * 60);
  const day = preview?.day ?? seedDay;
  // Whole days from the host's day to the item's: 0 (its day) or 1 (the hours past midnight).
  const offset = Math.round((Date.parse(`${day}T00:00:00`) - Date.parse(`${hostDay}T00:00:00`)) / 86_400_000);
  const shift = (m: number | null) => (m === null ? null : m + offset * 24 * 60);
  const startMin = shift(preview ? preview.startMin : seedStart);
  const endMin = shift(preview ? preview.endMin : seedEnd);
  const allDay = preview ? preview.allDay : seedStart === null;
  // Off this host's day or kind (the date was moved, all-day toggled): keep the
  // box for the arrow, but draw nothing where the item will not be.
  const away = (timedHost ? offset < 0 || offset > 1 : offset !== 0) || allDay === timedHost;
  const title = preview?.title || (kind === 'event' ? 'New Event' : 'New Task');
  const style: React.CSSProperties & Record<string, string | number> = {};
  // The colour it will have: the form's calendar once it reports one, its default calendar's
  // before that (the drag that opened it was already drawn in it), a task's otherwise.
  const newEventTint = useNewEventTint();
  const tint = kind === 'event' ? preview?.color ?? newEventTint ?? NEW_TASK_TINT : NEW_TASK_TINT;
  if (timedHost && startMin !== null) {
    const top = placeholder.minuteToPx!(startMin);
    const bottom = placeholder.minuteToPx!(Math.max(endMin ?? startMin + 30, startMin + 15));
    style.top = top;
    style.height = Math.max(bottom - top, 18);
  }
  if (away) style.visibility = 'hidden';
  const oneLine = typeof style.height === 'number' && style.height < ONE_LINE_BELOW_PX;
  return createPortal(
    <div
      ref={blockRef}
      className={`cal-chip cal-create-placeholder${timedHost ? '' : ' cal-chip-compact'}${oneLine ? ' cal-chip-oneline' : ''}`}
      data-testid="cal-create-placeholder"
      data-kind={kind}
      style={{ ...style, '--cal-chip-tint': tint } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="cal-chip-title">{title}</span>
      {timedHost && startMin !== null && endMin !== null && endMin > startMin && (
        <span className="cal-chip-time">{clockRange(startMin % 1440, endMin - (startMin - (startMin % 1440)))}</span>
      )}
    </div>,
    placeholder.host,
  );
}

export interface DragPointer {
  x: number;
  y: number;
  title: string;
  /** The item's own colour (chipTint from item-tint.ts). */
  tint: string;
  copy: boolean;
}

/** The month view's chip under the pointer during a chip drag. */
export function DragCursorChip({ pointer }: { pointer: DragPointer }) {
  return createPortal(
    <div
      className={`cal-drag-cursor-chip${pointer.copy ? ' cal-move-ghost-copy' : ''}`}
      data-copy={pointer.copy ? 'true' : undefined}
      style={{
        left: pointer.x + 10,
        top: pointer.y + 12,
        '--cal-chip-tint': pointer.tint,
      } as React.CSSProperties}
    >
      {pointer.title}
    </div>,
    document.body,
  );
}
