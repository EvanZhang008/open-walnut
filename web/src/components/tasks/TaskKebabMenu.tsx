/**
 * TaskKebabMenu — "⋮" dropdown menu for task row actions.
 *
 * Consolidates: source badge, external link, details, priority, star, pin
 * into a single kebab button to reduce visual noise per task row.
 */

import { useState, useRef, useEffect, useCallback, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import * as ICONS from '../common/Icons';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { useShowPriority } from '@/hooks/useShowPriority';
import { DatePicker, formatDateDisplay, formatStartDateDisplay } from '../common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { SnoozeUntilEvent, WAIT_UNTIL_ICON } from './TaskStatusControl';
import { TaskMenuRows } from './TaskMenuRows';
import { AgentMemoryPanel } from '@/components/org/AgentMemoryPanel';
import type { DraftTaskField } from '@/components/sessions/draft-column';
import { KebabIcon } from './KebabIcon';

type TaskListProjection = Task & {
  /** Precomputed by fields=list because that projection intentionally omits ext. */
  has_synced?: boolean;
  /** Legacy MS To-Do sync marker retained for pre-ext task records. */
  ms_todo_id?: string;
};

interface TaskKebabMenuProps {
  task: TaskListProjection;
  isFocused: boolean;
  /** Whether the detail pane is actually visible (not just focused/selected). */
  isDetailOpen?: boolean;
  isPinned: boolean;
  pinnedTier?: FocusTier;
  isDone: boolean;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onSetPriority?: (id: string, priority: string) => void;
  onPinTask?: (id: string) => void;
  onUnpinTask?: (id: string) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  /** Accepted for call-site compatibility; the menu no longer has an
   *  open-session row (clicking the task row opens its session). */
  onOpenSession?: (sessionId: string) => void;
  /** Launch a session FOR this task (reusing it). Only rendered when the task
   *  owns no session yet; a task with a session is opened by clicking its row. */
  onStartSession?: (task: Task) => void;
  onSetDate?: (id: string, date: string | null) => void;
  onSetStartDate?: (id: string, date: string | null) => void;
  /** Promote a subtask to top-level (remove parent_task_id). Only shown when task has a parent. */
  onUnparent?: (id: string) => void;
  /** Move task up one slot among its siblings. Pass undefined when task is already first. */
  onMoveUp?: (id: string) => void;
  onMoveDown?: (id: string) => void;
  /** Remove this task from its virtual group. Only shown when task.group_id is set. */
  onUngroup?: (id: string) => void;
  /** True when this task's group is hidden from the Focus area — enables "Unhide group". */
  isGroupHidden?: boolean;
  /** Unhide this task's group back into the Focus area. Only shown when isGroupHidden. */
  onUnhideGroup?: (groupId: string) => void;
  /** Enter multi-select mode with this task picked (to group several tasks). Only on list rows. */
  onStartSelect?: (id: string) => void;
  /** Move this task to another project ('' = Inbox). Renders the "Move to project" section. */
  onMoveToProject?: (id: string, project: string) => void;
  onDelete?: (id: string) => void;
  /** Set the status from the menu's Status row (falls back to the board store). */
  onSetPhase?: (id: string, phase: string) => void;
}

export const TIER_OPTIONS: { value: FocusTier; label: string; icon: ReactNode }[] = [
  { value: 'focus', label: 'Focus', icon: ICONS.ICON_TIER_FOCUS },
  { value: 'satellite', label: 'Satellite', icon: ICONS.ICON_TIER_SATELLITE },
  { value: 'wait', label: 'Parked', icon: ICONS.ICON_TIER_WAIT },
];

// Parked (id `wait`) is amber (set aside): the old grey half-circle was
// indistinguishable from Satellite's grey outline at a glance.
export const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  satellite: 'var(--tier-satellite, #5856d6)',
  wait: 'var(--tier-wait, #ff9f0a)',
};

const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

/**
 * One date field as a collapsed menu row: "Start: Fri" / "Due" with a chevron,
 * and the inline calendar only once the row is clicked. Two always-open
 * calendars used to take ~60% of the menu's height, so every other action sat
 * below the fold on a laptop screen; a date is set far less often than a task
 * is opened, pinned or moved. The menu re-measures itself when the calendar
 * appears (useMenuPlacement observes children), so expanding never clips.
 */
export function KebabDateRow({ label, date, display, onChange, extra, testId, className, icon }: {
  label: string;
  date: string | undefined | null;
  /** Human form of `date` for the collapsed row; empty when no date is set. */
  display: string;
  onChange: (date: string | null) => void;
  /** Shown under the calendar when open (Snooze until's "Something happens…"). */
  extra?: ReactNode;
  testId?: string;
  className?: string;
  /** Leading icon; the calendar by default. */
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`task-kebab-date${className ? ` ${className}` : ''}${open ? ' open' : ''}`} data-testid={testId}>
      <button
        type="button"
        className="task-kebab-item task-kebab-date-toggle"
        aria-expanded={open}
        title={display ? `${label}: ${display}` : undefined}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <span className="task-kebab-icon">{icon ?? ICONS.ICON_CALENDAR}</span>
        <span className="task-kebab-date-label">
          {label}{display ? <>: <b>{display}</b></> : ''}
        </span>
        <span className={`task-kebab-date-caret${open ? ' open' : ''}`}>{ICONS.CHEVRON_GLYPH}</span>
      </button>
      {open && <DatePicker date={date} onChange={onChange} inline />}
      {open && extra}
    </div>
  );
}

/** What a task is snoozed until now: its start date while still to come, and the
 *  watch (an armed trigger) a Waiting task waits on. Empty when neither. */
export function snoozeDisplay(task: Pick<Task, 'start_date' | 'phase' | 'user_status'>): string {
  const start = task.start_date ? formatStartDateDisplay(task.start_date) : '';
  const time = start && start !== 'Started' ? start : '';
  const on = task.phase === 'WAITING' ? task.user_status?.waitingOn ?? '' : '';
  const watch = /^A watch:\s*/i.test(on) ? on.replace(/^A watch:\s*/i, '') : '';
  return [time, watch].filter(Boolean).join(' · ');
}

/**
 * The task menu's first action row (2026-11-02, the user: "snooze until should be
 * top ... as it is so important", "can be time and action"): one click opens both
 * kinds of snooze, until a time (the presets and the calendar, the task's start
 * date) and until something happens (the task's session arms a trigger). The
 * closed row reads what is set now. Dates keeps Start and Due as plain dates.
 */
export function TaskSnoozeRow({ task, onSetStartDate, afterAction }: {
  task: Task;
  onSetStartDate: (date: string | null) => void;
  afterAction: () => void;
}) {
  if (task.phase === 'COMPLETE' || task.status === 'done') return null;
  const display = snoozeDisplay(task);
  return (
    <KebabDateRow
      label={display ? 'Snoozed until' : 'Snooze until'}
      testId="task-snooze-row"
      className="task-snooze-row"
      icon={WAIT_UNTIL_ICON}
      date={task.start_date}
      display={display}
      onChange={(date) => { onSetStartDate(date); afterAction(); }}
      extra={<SnoozeUntilEvent task={task} afterAction={afterAction} />}
    />
  );
}

/** "Use Walnut's pick: <label>": hands one draft field back to the AI. */
function WalnutPickRow({ pick, afterAction }: {
  pick: { label: string; onPick: () => void } | undefined;
  afterAction: () => void;
}) {
  if (!pick) return null;
  return (
    <button
      type="button"
      className="task-kebab-item task-kebab-walnut-pick"
      onClick={(e) => { e.stopPropagation(); pick.onPick(); afterAction(); }}
    >
      <span className="task-kebab-icon" aria-hidden="true">✦</span>
      <span>Use Walnut's pick: {pick.label}</span>
    </button>
  );
}

/**
 * Shared pin-to-tier / set-priority / set-date blocks — the SAME panel rows the
 * per-task kebab shows, reused by the session panel's kebab (TaskQuickActions)
 * and the multi-select "Group ▸" batch dropdown so there is one definition of
 * these actions (no drift). In batch mode `task` is null: there is no single
 * current value to highlight, so every option renders un-selected and the
 * callback fans out across the caller's selection.
 *
 * Pinning has no separate "Unpin" row: the highlighted tier pill IS the pin, and
 * clicking it again unpins. Priority renders only when Settings says so
 * (`ui.show_priority`, off by default). Dates are collapsed rows (KebabDateRow).
 * The draft menu opts into a few differences through optional props (see the
 * prop docs); the board kebab passes none of them and keeps this behavior.
 */
export function TaskActionMenuItems({
  task, isPinned, pinnedTier, isDone, batchMode,
  onSetPriority, onPinTask, onPinWithTier, onUnpinTask, onSetTier, onSetDate, onSetStartDate, afterAction,
  formatDate, showPriorityLabels, litClickAccepts, tierHeading, walnutPick, startLabel, part,
}: {
  /** Single task (kebab) — null in batch mode. Only the fields the rows READ are
   *  required, so a draft column can hand in its launch meta (the task that
   *  Start will create) shaped like a task — see DraftTaskMenu. */
  task: Pick<Task, 'priority' | 'start_date' | 'due_date'> | null;
  isPinned: boolean;
  /** null = explicitly not pinned (nothing lit, like undefined). */
  pinnedTier?: FocusTier | null;
  isDone: boolean;
  /** Batch mode: tier button calls onSetTier(tier) directly (caller fans out pin+tier per task). */
  batchMode?: boolean;
  onSetPriority?: (priority: string) => void;
  onPinTask?: () => void;
  /** Pin straight INTO a tier, in one step. When given, it replaces the
   *  pin-then-setTier-100ms-later dance below for an unpinned task — for owners
   *  whose pin is one atomic write (a draft's launch meta), where the delayed
   *  half could land after the draft was already launched. */
  onPinWithTier?: (tier: FocusTier) => void;
  onUnpinTask?: () => void;
  onSetTier?: (tier: FocusTier) => void;
  onSetDate?: (date: string | null) => void;
  onSetStartDate?: (date: string | null) => void;
  /** Close the menu after an action fires. */
  afterAction: () => void;
  // The props below are the DRAFT menu's (DraftTaskMenuPopover). Absent, every
  // row behaves exactly as on the board kebab.
  /** Collapsed Start / Due row text. Default: the board's relative format. */
  formatDate?: (iso: string, kind: 'start' | 'due') => string;
  /** Priority buttons read icon + label ("!! Immediate"), not the icon alone. */
  showPriorityLabels?: boolean;
  /** Clicking the lit priority re-sends the same value (accept it). The lit
   *  tier always unpins on a second click, draft menu included: that click IS
   *  "don't pin" (2026-09-25: a separate "Don't pin" button read as clutter). */
  litClickAccepts?: boolean;
  /** Tier block heading instead of "Pinned" / "Pin to". */
  tierHeading?: string;
  /** Per field, a trailing "Use Walnut's pick: <label>" row. */
  walnutPick?: Partial<Record<DraftTaskField, { label: string; onPick: () => void }>>;
  /** The Start row's label. A real task's menu draws its snooze as its own first
   *  row (TaskSnoozeRow), so its Start row is a plain "Start"; the draft and batch
   *  menus keep the default, which also says what a future start does. */
  startLabel?: string;
  /** One half only: the session ⋮ menu draws Pin (and Priority) on its first level
   *  and the dates inside its Dates group. Absent, both halves (the board kebab). */
  part?: 'pin' | 'dates';
}) {
  // Custom tiers append after the built-ins. Safe hook: kebabs also render on
  // isolated surfaces (tests, popouts) that may sit outside the FocusBarProvider.
  const customTiers = useFocusBarContextSafe()?.customTiers ?? [];
  const showPriority = useShowPriority();
  const tierOptions = [
    ...TIER_OPTIONS,
    ...customTiers.map((ct) => ({ value: ct.id, label: ct.label, icon: ICONS.ICON_TIER_CUSTOM })),
  ];
  return (
    <>
      {/* Pin / Tier */}
      {part !== 'dates' && (batchMode ? !!onSetTier : !isDone && (onPinTask || onPinWithTier || isPinned)) && (
        <>
          <div className="task-kebab-divider" />
          <div className="task-kebab-tier">
            <span className="task-kebab-tier-label">{tierHeading ?? (!batchMode && isPinned ? 'Pinned' : 'Pin to')}</span>
            <div className="task-kebab-tier-options">
              {tierOptions.map((t) => {
                const isCurrent = !batchMode && isPinned && pinnedTier === t.value;
                return (
                <button
                  key={t.value}
                  className={`task-kebab-tier-btn${isCurrent ? ' active' : ''}`}
                  style={{ color: TIER_COLORS[t.value] ?? 'var(--tier-custom)' }}
                  title={isCurrent ? `Unpin from ${t.label}` : t.label}
                  aria-pressed={isCurrent || undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (batchMode) {
                      // Caller fans out pin+tier across the whole selection.
                      onSetTier?.(t.value);
                    } else if (isPinned) {
                      // The lit pill is the pin itself: click it again to unpin.
                      if (isCurrent) onUnpinTask?.();
                      else onSetTier?.(t.value);
                    } else if (onPinWithTier) {
                      onPinWithTier(t.value);
                    } else {
                      // Pin first, then set the tier. The 100ms gap is a race guard: the
                      // pin must register (server write + local focus-store update) before
                      // setTier targets it — fired synchronously, setTier hits a task the
                      // focus store doesn't yet know is pinned and the tier is dropped.
                      // (Not a hard guarantee; the proper fix is a pin-with-tier API. This
                      // same pattern is mirrored in TodoPanel.batchPinToTier.)
                      onPinTask?.();
                      setTimeout(() => onSetTier?.(t.value), 100);
                    }
                    afterAction();
                  }}
                >
                  <span className="task-kebab-tier-btn-icon">{t.icon}</span>
                  {t.label}
                </button>
                );
              })}
            </div>
          </div>
          <WalnutPickRow pick={walnutPick?.pinTier} afterAction={afterAction} />
        </>
      )}

      {/* Priority (hidden unless Settings → Tasks → Show task priority) */}
      {part !== 'dates' && onSetPriority && showPriority && (
        <>
          <div className="task-kebab-divider" />
          <div className="task-kebab-priority">
            <span className="task-kebab-priority-label">Priority</span>
            <div className="task-kebab-priority-options">
              {PRIORITY_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  className={`badge badge-${p.value}${task && task.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                  title={p.label}
                  aria-pressed={showPriorityLabels ? (!!task && task.priority === p.value) : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!task || p.value !== task.priority || litClickAccepts) onSetPriority(p.value);
                    afterAction();
                  }}
                >
                  {showPriorityLabels ? `${p.icon} ${p.label}` : p.icon}
                </button>
              ))}
            </div>
          </div>
          <WalnutPickRow pick={walnutPick?.priority} afterAction={afterAction} />
        </>
      )}

      {/* Start (when to begin; drives the Now view's deferral) and Due (the
          deadline): collapsed rows, calendar on click. */}
      {part !== 'pin' && (<>
      {(onSetStartDate || onSetDate) && <div className="task-kebab-divider" />}
      {onSetStartDate && (
        <KebabDateRow
          // The default also says what a future start DOES: it hides the task from
          // Now until then.
          label={startLabel ?? 'Start / Snooze until'}
          testId={startLabel ? 'task-start-row' : 'task-snooze-row'}
          className={startLabel ? undefined : 'task-snooze-row'}
          date={task?.start_date}
          display={task?.start_date ? (formatDate ? formatDate(task.start_date, 'start') : formatStartDateDisplay(task.start_date)) : ''}
          onChange={(date) => { onSetStartDate(date); afterAction(); }}
        />
      )}
      {onSetStartDate && <WalnutPickRow pick={walnutPick?.startDate} afterAction={afterAction} />}
      {onSetDate && (
        <KebabDateRow
          label="Due"
          date={task?.due_date}
          display={task?.due_date ? (formatDate ? formatDate(task.due_date, 'due') : formatDateDisplay(task.due_date)) : ''}
          onChange={(date) => { onSetDate(date); afterAction(); }}
        />
      )}
      {onSetDate && <WalnutPickRow pick={walnutPick?.dueDate} afterAction={afterAction} />}
      </>)}
    </>
  );
}

/**
 * The project OPTION LIST — a portalled flyout of every registry project plus
 * Inbox, anchored to whatever trigger the owner passes. Split out of
 * MoveToProjectSection so any surface needing "pick a project" (kebab, batch
 * dropdown, a composer's project pill) reuses ONE definition of the list, its
 * placement and its guards.
 *
 * A custom option list, NOT a native <select>: the OS popup clashed with the
 * app's menu styling, and on macOS it swallows the pointerup so dnd-kit saw a
 * held-down pointer and started dragging the row after the pick. Options come
 * from the project REGISTRY (not the loaded tasks) so EMPTY projects are valid
 * targets; the registry fetch happens when this component MOUNTS (i.e. per open
 * menu), not per open flyout and not per task row.
 *
 * It is a PORTALLED flyout placed by useMenuPlacement, NOT an inline expansion:
 * inlining it grew the parent menu past the viewport (the registry can be 30+
 * projects). The flyout gets the same flip/clamp/scroll treatment as every other
 * menu, and the parent menu's height never changes. Host menus' outside-click /
 * scroll closers must exempt `.task-kebab-project-flyout` — it is intentionally
 * outside their menu ref.
 */
export function ProjectPickerFlyout({ open, anchorRef, anchorPoint, align, current, onPick, onClose, preferSide }: {
  open: boolean;
  /** The trigger the flyout is placed against. Ignored when `anchorPoint` is set. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Anchor at a viewport POINT instead of a trigger element — used by the folder
   * right-click menu, whose "Move to project…" row has already closed the menu it
   * came from, so there is no element left to hang the flyout on. Must be
   * referentially stable (keep it in state): useMenuPlacement takes it as a dep.
   */
  anchorPoint?: { x: number; y: number } | null;
  /** Horizontal alignment (see useMenuPlacement). Default 'right', as for a kebab. */
  align?: 'right' | 'left' | 'center';
  /** Current project ('' = Inbox), shown with a ✓. null = no single current value. */
  current: string | null;
  onPick: (project: string) => void;
  /** Dismiss request. Fired right after every `onPick` (so a host that stays
   *  mounted — e.g. a composer pill — doesn't have to close itself) and when the
   *  anchor is lost (trigger unmounted / hidden while the flyout was open). */
  onClose: () => void;
  /** Side to prefer when both fit (default 'down'). The draft launch bar passes
   *  'up' so this flyout matches its folder picker — one row, one direction. */
  preferSide?: 'up' | 'down';
}) {
  const { projectNames } = useProjectRegistry();
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, listRef, {
    minHeight: 160,
    preferSide,
    anchorPoint,
    align,
    onAnchorLost: onClose,
  });
  if (!open) return null;
  // The task's own project may be missing from the registry (race, legacy data) —
  // include it so the list always shows the true current value.
  const options = current && !projectNames.includes(current)
    ? [...projectNames, current].sort((a, b) => a.localeCompare(b))
    : projectNames;
  const q = filter.trim().toLowerCase();
  const shown = q ? options.filter((n) => n.toLowerCase().includes(q)) : options;
  const optionRow = (name: string, label?: string) => (
    <button
      key={name || '·inbox·'}
      className={`task-kebab-project-opt${current === name ? ' active' : ''}`}
      onClick={(e) => { e.stopPropagation(); onPick(name); onClose(); }}
    >
      <span className="task-kebab-project-check">{current === name ? '✓' : ''}</span>
      <span className="task-kebab-project-opt-name">{label ?? name}</span>
    </button>
  );
  return createPortal(
    <div
      ref={listRef}
      className="task-kebab-project-flyout"
      style={menuPlacementStyle(placement)}
      onClick={(e) => e.stopPropagation()}
      // Same drag guard as the parent menu: portal events bubble through the
      // React tree to the sortable row, arming dnd-kit's PointerSensor.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {options.length > 6 && (
        <input data-no-draft="search"
          className="task-kebab-project-filter"
          placeholder="Filter projects…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
      )}
      {(!q || 'inbox'.includes(q)) && optionRow('', 'Inbox')}
      {shown.map((name) => optionRow(name))}
      {q && shown.length === 0 && (
        <div className="task-kebab-project-empty">No matching project</div>
      )}
    </div>,
    document.body,
  );
}

/**
 * "Project" row — move the task to another project ('' = Inbox) without dragging.
 * The in-menu trigger; the option list itself is {@link ProjectPickerFlyout}.
 */
export function MoveToProjectSection({ current, onMove, afterAction }: {
  /** Current project ('' = Inbox). null in batch mode — no single current value. */
  current: string | null;
  onMove: (project: string) => void;
  afterAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className="task-kebab-divider" />
      <div className="task-kebab-project">
        <span className="task-kebab-project-label">Project</span>
        <button
          ref={btnRef}
          className={`task-kebab-project-current${open ? ' open' : ''}`}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <span className="task-kebab-project-current-name">
            {current === null ? 'Move to…' : (current || 'Inbox')}
          </span>
          <span className="task-kebab-project-caret">▾</span>
        </button>
      </div>
      <ProjectPickerFlyout
        open={open}
        anchorRef={btnRef}
        current={current}
        onPick={(name) => {
          // Re-picking the current project is a dismiss, not a move (no server
          // PATCH). Batch mode (current === null) always moves — there is no
          // single current value to compare against.
          if (current === null || name !== current) onMove(name);
          afterAction();
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function TaskKebabMenu({ task, isFocused, isDetailOpen, isPinned, pinnedTier, isDone, onExpandDetail, onClearFocus, onSetPriority, onPinTask, onUnpinTask, onSetTier, onStartSession, onSetDate, onSetStartDate, onUnparent, onMoveUp, onMoveDown, onUngroup, isGroupHidden, onUnhideGroup, onStartSelect, onMoveToProject, onDelete, onSetPhase }: TaskKebabMenuProps) {
  const [open, setOpen] = useState(false);
  // Main's, a lead's or a VP's Memory & instructions, opened from the menu.
  const [memoryOpen, setMemoryOpen] = useState(false);
  /** Set only by the right-click path, which anchors the menu at the cursor. */
  const [cursorAnchor, setCursorAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => { setOpen(false); setCursorAnchor(null); }, []);
  // Measured placement + height cap — the menu height is never guessed, so a
  // tall menu in a short window scrolls internally instead of being clipped.
  const menuPos = useMenuPlacement(open, btnRef, menuRef, {
    anchorPoint: cursorAnchor,
    // A task row is filtered out from under an open menu often here (the live
    // todo search re-filters as you type); close rather than strand the menu.
    onAnchorLost: closeMenu,
  });

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      // The Project picker's option list is a separate portal (see
      // MoveToProjectSection) — clicks inside it are NOT "outside the menu". Same
      // for the Adopt a worker picker (TeamMenuItems).
      if ((e.target as HTMLElement).closest?.('.task-kebab-project-flyout, .adopt-worker-flyout')) return;
      closeMenu();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    // Three different scroll cases, deliberately:
    //  1. Inside the menu — the menu scrolls its own overflow now, so this must
    //     NOT dismiss it (that would make the fix unusable).
    //  2. Right-click path (cursorAnchor set) — a cursor anchor is a frozen
    //     viewport point, not an element. Once the page scrolls, it no longer
    //     points at the row it was opened on, so close outright. Safe here
    //     because a right-click never scrolls the row into view, so this can't
    //     fire in the same tick as the open (see case 3).
    //  3. Button path — follow the trigger (useMenuPlacement repositions) and
    //     only close once it truly leaves the viewport. A blanket close-on-scroll
    //     would fire in the SAME tick as the opening click whenever that click
    //     scrolls the row into view, so the menu never appeared at all — the bug
    //     documented in TaskBatchMenu.tsx.
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      // Scrolling the Project (or Adopt) flyout's own list is reading, not page scroll.
      if ((e.target as HTMLElement).closest?.('.task-kebab-project-flyout, .adopt-worker-flyout')) return;
      if (cursorAnchor) { closeMenu(); return; }
      const r = btnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) closeMenu();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, closeMenu, cursorAnchor]);

  // Right-click anywhere on the task row opens this kebab menu at the cursor —
  // the row is an app object, not a document, so the browser context menu is
  // replaced. The row element is found via the [data-task-id] ancestor every
  // task surface (list row, pinned/tier/recent card) already carries.
  useEffect(() => {
    const row = btnRef.current?.closest<HTMLElement>('[data-task-id]');
    if (!row) return;
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Keep the native menu inside text-editing surfaces (inline title edit).
      if (target.isContentEditable) return;
      // Nested/overlapping rows: only the innermost row owns the right-click.
      if (target.closest('[data-task-id]') !== row) return;
      e.preventDefault();
      // Placement (flip, clamp, height cap) is all measured by useMenuPlacement —
      // record only the cursor point it should anchor to.
      setCursorAnchor({ x: e.clientX, y: e.clientY });
      setOpen(true);
    };
    row.addEventListener('contextmenu', handleContextMenu);
    return () => row.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCursorAnchor(null);   // button path anchors to the button, not a cursor
    setOpen(!open);
  };

  // data-menu-open replaces a `:has(.task-kebab-menu)` CSS check that kept the ⋮
  // visible while its menu was open — the menu is portalled to <body> now, so it
  // is no longer a descendant for :has() to find.
  return (
    <div className="task-kebab-wrapper" data-menu-open={open || undefined}>
      <button
        ref={btnRef}
        className="task-kebab-btn"
        onClick={handleToggle}
        title="More actions"
        aria-label="More actions"
      >
        <KebabIcon />
      </button>
      {/* Portalled to <body>: `position: fixed` escapes clipping ancestors but
          NOT stacking contexts, so a z-indexed ancestor (a panel header, a
          sticky bar) caps this menu at the ancestor's layer no matter how high
          its own z-index is. See the note in TaskQuickActions.tsx. */}
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu"
          style={menuPlacementStyle(menuPos)}
          // The portal target is <body>, but React synthetic events still bubble
          // through the PORTAL to this row's component tree — so a pointerdown
          // inside the menu reached useSortable's activator and started a DRAG of
          // the row once the cursor moved 5px (felt as "picking a project drags
          // the task"). Kill pointerdown here so no menu interaction can arm dnd.
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* The task's rows: one definition for every task menu (TaskMenuRows). */}
          <TaskMenuRows
            task={task}
            isPinned={isPinned}
            pinnedTier={pinnedTier}
            isDone={isDone}
            close={closeMenu}
            onSetStartDate={onSetStartDate ? (d) => onSetStartDate(task.id, d) : undefined}
            onSetDate={onSetDate ? (d) => onSetDate(task.id, d) : undefined}
            onSetPhase={onSetPhase}
            onSetPriority={onSetPriority ? (pr) => onSetPriority(task.id, pr) : undefined}
            onPinTask={onPinTask ? () => onPinTask(task.id) : undefined}
            onUnpinTask={onUnpinTask ? () => onUnpinTask(task.id) : undefined}
            onSetTier={onSetTier ? (t) => onSetTier(task.id, t) : undefined}
            onMoveToProject={onMoveToProject ? (pr) => onMoveToProject(task.id, pr) : undefined}
            detail={{ open: isDetailOpen, onToggle: () => (isDetailOpen ? onClearFocus?.() : onExpandDetail?.(task)) }}
            onOpenMemory={() => setMemoryOpen(true)}
            onStartSession={onStartSession && !isDone ? () => onStartSession(task) : undefined}
            list={{ onStartSelect, onUnparent, onMoveUp, onMoveDown, onUngroup, isGroupHidden, onUnhideGroup }}
            onDelete={onDelete ? () => onDelete(task.id) : undefined}
          />
        </div>,
        document.body,
      )}
      {memoryOpen && <AgentMemoryPanel task={task} onClose={() => setMemoryOpen(false)} />}
    </div>
  );
}
