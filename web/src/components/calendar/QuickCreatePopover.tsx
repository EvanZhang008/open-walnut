/**
 * QuickCreatePopover — clicking or drag-selecting empty calendar space opens
 * this creator, laid out like a desktop calendar's new-event popover:
 *  - a placeholder block appears in the grid at once, at the slot being
 *    created, and follows the form (title, times, calendar colour);
 *  - the popover opens BESIDE that block with an arrow pointing at it, never
 *    over it (useMenuPlacement `beside`);
 *  - an Event | Task switch on top. Event is the default; the last one the user
 *    picked is kept (usePageView), so it survives a reload and an app restart.
 * The Event side is EventCreateForm; the Task side is QuickTaskComposer with the
 * slot's dates pre-seeded. Event shows only while a writable calendar exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import type { PlacementArrow } from '@/hooks/menu-placement-beside';
import { useTasksContext } from '@/contexts/TasksContext';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { QuickTaskComposer } from '@/components/tasks/QuickTaskComposer';
import type { CreateTaskInput } from '@/api/tasks';
import { usePageView } from '@/utils/view-memory';
import { clockRange, minutesOfDay } from '@/utils/calendar-date';
import { EventCreateForm, type CreateEventInput, type EventPreview } from './EventCreateForm';

export type CreateKind = 'event' | 'task';
/** A block shorter than this shows its title and time on one line. */
export const ONE_LINE_BELOW_PX = 30;
export const isCreateKind = (v: unknown): v is CreateKind => v === 'event' || v === 'task';

/** Where the grid draws the block being created while the popover is open. */
export interface CreatePlaceholder {
  /** A time-grid day column (timed) or an all-day cell (a chip in its list). */
  host: HTMLElement;
  /** Timed hosts: minute from the column's day start → px from its top. */
  minuteToPx?: (min: number) => number;
  /** The host's day: a column runs past midnight, so tomorrow's 1 AM sits at its minute 1500. */
  day?: string;
}

export interface CreateSeed {
  /** Slot's date ("YYYY-MM-DD") or datetime ("…T09:00:00"). */
  start: string;
  /** Present when the user drag-selected a range. */
  end?: string;
  /** Element to anchor the popover to (small anchors: month cells). */
  anchorEl?: HTMLElement;
  /**
   * Pointer coords to anchor to instead, when there is no placeholder (a
   * context-menu "New…" outside the time grid). Never a day column: it is a
   * day tall, and the popover would land at its bottom.
   */
  anchorPoint?: { x: number; y: number };
  /** Draw a placeholder block here and anchor the popover beside it. */
  placeholder?: CreatePlaceholder;
  /** Open on this side (the context menu's "New event…" / "New task…"); it becomes the kept choice. */
  tab?: CreateKind;
}

interface Props {
  seed: CreateSeed;
  onClose: () => void;
  onCreateTask: (input: CreateTaskInput) => Promise<Task>;
  /** Present when the calendar source is writable — enables the Event side. */
  onCreateEvent?: (input: CreateEventInput) => Promise<unknown>;
}

export function QuickCreatePopover({ seed, onClose, onCreateTask, onCreateEvent }: Props) {
  const { tasks } = useTasksContext();
  const projectRegistry = useProjectRegistry();
  // Event by default; the last side the user picked after that (2026-11-16, the
  // user: "default event instead of task", and remember the one chosen).
  const [kind, setKind] = usePageView<CreateKind>('calendar', 'createKind', 'event', isCreateKind);
  // A context menu's "New event…" / "New task…" opens on that side and makes it
  // the kept choice; a click on the switch then wins as usual.
  const [openedAs, setOpenedAs] = useState(seed.tab);
  useEffect(() => {
    if (seed.tab) setKind(seed.tab);
  }, [seed.tab, setKind]);
  const pick = (k: CreateKind) => {
    setOpenedAs(undefined);
    setKind(k);
  };
  // The page's canCreateEvent gate is OPTIMISTIC while calendar sources load; if
  // it settles to "no writable source", the Task side shows (the kept choice stays).
  const shown: CreateKind = onCreateEvent ? (openedAs ?? kind) : 'task';

  const blockRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(seed.anchorEl ?? null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorPoint = useMemo(
    () => (seed.placeholder || seed.anchorEl || !seed.anchorPoint ? null : seed.anchorPoint),
    [seed.placeholder, seed.anchorEl, seed.anchorPoint],
  );
  // The placeholder is committed with the popover (a portal in the same render),
  // so the hook's layout pass already finds it.
  const [preview, setPreview] = useState<EventPreview | null>(null);
  // No calendar can take an event: open on Task this time (the kept choice stays).
  const onNoCalendar = useCallback(() => setOpenedAs((cur) => cur ?? 'task'), []);
  const placement = useMenuPlacement(true, seed.placeholder ? blockRef : anchorRef, menuRef, {
    anchorPoint,
    beside: !anchorPoint,
    gap: anchorPoint ? 2 : 12,
    align: 'left',
    onAnchorLost: onClose,
    // The block moves with the form's day and start time: follow it.
    anchorKey: preview ? `${preview.day}|${preview.allDay}|${preview.startMin}` : undefined,
  });

  const onPreview = useCallback((p: EventPreview) => setPreview(p), []);

  // Window-level Escape: the composer/form inputs handle Escape only while
  // focused; after clicking non-focusable popover chrome focus sits on <body>.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A flyout's own Escape (EventCreateForm) stops the event before it gets here.
      if (e.key === 'Escape' && !e.isComposing) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Flat list of existing project names for the composer's datalist. Registry
  // first (an existing-but-EMPTY project must not be badged "new"), then names
  // seen on tasks while that fetch is in flight. Deduped case-insensitively.
  const projectOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const name of projectRegistry.projectNames) {
      if (name.trim()) seen.set(name.trim().toLowerCase(), name.trim());
    }
    for (const task of tasks) {
      if (task.title.startsWith('.metadata') || !task.project) continue;
      const key = task.project.toLowerCase();
      if (!seen.has(key)) seen.set(key, task.project);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [tasks, projectRegistry.projectNames]);

  // A drag-selected range is the task's working block (start→end), NOT a deadline.
  const initialDates = useMemo(() => ({ start: seed.start, end: seed.end }), [seed.start, seed.end]);

  return createPortal(
    <>
      {/* Instinctive double-clicks must not toggle-close: the popover the 1st
          click opened puts this backdrop under the 2nd click. detail>1 = later
          clicks of a multi-click: swallow them. mousedown too: QuickTaskComposer
          closes itself on any document mousedown outside. */}
      <div
        className="cal-popover-backdrop"
        onMouseDown={(e) => {
          if (e.detail > 1) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onClick={(e) => {
          if (e.detail <= 1) onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      {seed.placeholder && (
        <PlaceholderBlock
          blockRef={blockRef}
          placeholder={seed.placeholder}
          seed={seed}
          kind={shown}
          preview={shown === 'event' ? preview : null}
        />
      )}
      <div
        className="cal-create-popover"
        ref={menuRef}
        style={menuPlacementStyle(placement)}
        data-kind={shown}
        onPointerDown={(e) => e.stopPropagation()}
        // QuickTaskComposer closes on any document mousedown outside itself; the
        // popover's own padding, gaps and scrollbar are not outside.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {onCreateEvent && (
          <div
            className="cal-create-tabs"
            role="tablist"
            aria-label="New item kind"
          >
            <button role="tab" aria-selected={shown === 'event'} className={shown === 'event' ? 'active' : ''} onClick={() => pick('event')}>
              Event
            </button>
            <button role="tab" aria-selected={shown === 'task'} className={shown === 'task' ? 'active' : ''} onClick={() => pick('task')}>
              Task
            </button>
          </div>
        )}
        {/* The event form stays mounted while Task shows, so a switch there and
            back keeps the times and calendar the user set. */}
        {onCreateEvent && (
          <div className="cal-create-side" hidden={shown !== 'event'}>
            <EventCreateForm seed={seed} onClose={onClose} onCreateEvent={onCreateEvent} onPreview={onPreview} onNoCalendar={onNoCalendar} active={shown === 'event'} />
          </div>
        )}
        {shown === 'task' && (
          <QuickTaskComposer
            open
            onClose={onClose}
            projectOptions={projectOptions}
            initialDates={initialDates}
            onCreate={async (input) => {
              // pinnedTier needs the Focus Bar plumbing MainPage owns: out of scope here.
              await onCreateTask({
                title: input.title,
                priority: input.priority,
                project: input.project,
                due_date: input.due_date,
                start_date: input.start_date,
                end_date: input.end_date,
                ...(input.local ? { source: 'local' } : {}),
              });
              onClose();
            }}
          />
        )}
      </div>
      {/* After the popover, at its z-index: over its border, under a flyout opened from it. */}
      <PopoverArrow arrow={placement?.arrow} />
    </>,
    document.body
  );
}

/** The arrow on the popover's edge, pointing at the block (a sibling: the popover clips its own overflow). */
function PopoverArrow({ arrow }: { arrow?: PlacementArrow }) {
  if (!arrow) return null;
  return (
    <div
      className="cal-create-arrow"
      data-edge={arrow.edge}
      style={{ position: 'fixed', left: arrow.x, top: arrow.y, zIndex: 9999 }}
      aria-hidden="true"
    />
  );
}

/**
 * The block being created, drawn in the grid itself (a portal into the day
 * column or all-day cell), so it sits exactly where the event will land and
 * scrolls with the grid. Event side: the form's live title, times and colour.
 */
function PlaceholderBlock({
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
  if (preview?.color && kind === 'event') style['--cal-chip-tint'] = preview.color;
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
      style={style}
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
