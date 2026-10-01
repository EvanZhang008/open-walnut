/**
 * Task status, visible and changeable: the collapsed Status row in the task
 * menu, the clickable status badge in the detail pane, the "Something happens…"
 * row under the menu's Start / Snooze until, and the line above a Waiting
 * task's composer.
 *
 * All five phases are offered. The row checkbox still toggles To Do / Complete;
 * this is where Waiting, In Progress and Need Action can be read and set by hand.
 *
 * Waiting IS a status (2026-09-30): the task is set aside until something
 * happens. A trigger fire, a message from a human or a peer, or a prompt for the
 * human moves it to In Progress, and that turn ends as Need Action as usual. Its
 * `wait_until` is the server's own clock on it: picking Waiting opens an "Until"
 * row under the options; the server fills 3 days from now when none is named
 * (DEFAULT_WAIT_DAYS), the row sets another time or no time limit. A Waiting
 * task keeps its board tier; the Parked TIER is a shelf on the board, a
 * different thing. The task list hides Waiting tasks by default.
 *
 * Overlay rules (web/src/AGENTS.md): the badge's menu is placed by
 * useMenuPlacement, portalled to <body>, stops pointerdown (task rows are dnd
 * draggables) and closes on an outside pointerdown. The until row's calendar is
 * the date rows' inline DatePicker: it grows the menu the way an opened date row
 * does, and the menu re-measures itself (useMenuPlacement observes children).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_WAIT_DAYS, type Task, type TaskPhase } from '@open-walnut/core';
import * as ICONS from '../common/Icons';
import { DatePicker } from '../common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { updateTask as apiUpdateTask } from '@/api/tasks';
import { requestWaitUntil, WAIT_UNTIL_MENU_LABEL, WAIT_UNTIL_TITLE } from '@/utils/wait-until';
// formatDraftDate: a time exactly 7 days out would print as today's weekday with
// the shared formatter.
import { formatDraftDate } from '@/components/sessions/draft-decisions';
import { log } from '@/utils/log';
import '@/styles/task-status.css';

export const STATUS_OPTIONS: { value: TaskPhase; label: string; icon: ReactNode }[] = [
  { value: 'TODO', label: 'To Do', icon: ICONS.ICON_PHASE_TODO },
  { value: 'WAITING', label: 'Waiting', icon: ICONS.ICON_PHASE_WAITING },
  { value: 'IN_PROGRESS', label: 'In Progress', icon: ICONS.ICON_PHASE_IN_PROGRESS },
  { value: 'NEED_ACTION', label: 'Need Action', icon: ICONS.ICON_PHASE_NEED_ACTION },
  { value: 'COMPLETE', label: 'Complete', icon: ICONS.ICON_PHASE_COMPLETE },
];

export function statusLabel(phase: string | undefined): string {
  return STATUS_OPTIONS.find((o) => o.value === phase)?.label ?? phase ?? '';
}

/** Hourglass, 16px stroke=currentColor (the "+" menu's action-icon contract). */
export const WAIT_UNTIL_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 2h12M6 22h12M7 2c0 5 5 6 5 10s-5 5-5 10M17 2c0 5-5 6-5 10s5 5 5 10" />
  </svg>
);

type SetPhase = (id: string, phase: string) => void;
/** Writes a Waiting task's clock: an ISO datetime, or '' to clear it. */
type SetWaitUntil = (id: string, waitUntil: string) => void;

/** The caller's setter, else the board store's, else a plain PATCH. */
function useSetPhase(onSetPhase?: SetPhase): SetPhase {
  const ctx = useTasksContextSafe();
  return useCallback((id: string, phase: string) => {
    log.info('task-status', 'status set by hand', { taskId: id, phase });
    if (onSetPhase) { onSetPhase(id, phase); return; }
    if (ctx) { ctx.setPhase(id, phase); return; }
    void apiUpdateTask(id, { phase: phase as TaskPhase }).catch((err) => {
      log.warn('task-status', 'status write failed', { taskId: id, phase, error: String(err) });
    });
  }, [onSetPhase, ctx]);
}

/**
 * The caller's setter, else the board store's update (which applies it to the
 * list at once and owns the PATCH), else a plain PATCH. The store's setPhase
 * knows no wait_until, so this goes through its generic update. Every write
 * carries `phase: 'WAITING'`: the server keeps a wait_until on a WAITING task
 * only, and the status write just before it may not have landed yet.
 */
function useSetWaitUntil(onSetWaitUntil?: SetWaitUntil): SetWaitUntil {
  const ctx = useTasksContextSafe();
  return useCallback((id: string, waitUntil: string) => {
    log.info('task-status', 'wait until set by hand', { taskId: id, waitUntil });
    if (onSetWaitUntil) { onSetWaitUntil(id, waitUntil); return; }
    if (ctx && ctx.tasks.some((t) => t.id === id)) {
      ctx.update(id, { phase: 'WAITING', wait_until: waitUntil });
      return;
    }
    void apiUpdateTask(id, { phase: 'WAITING', wait_until: waitUntil }).catch((err) => {
      log.warn('task-status', 'wait until write failed', { taskId: id, waitUntil, error: String(err) });
    });
  }, [onSetWaitUntil, ctx]);
}

/** A Waiting task's clock for display ("Fri 9:00"), '' when it has none. */
export function formatWaitUntil(iso: string | undefined | null): string {
  return iso ? formatDraftDate(iso) : '';
}

/**
 * The wait_until a date picker pick stands for. A day pick ("2026-10-02") is
 * 9:00 local that day: the server reads a bare date as UTC midnight, which is
 * the evening before anywhere west of Greenwich. A time pick passes through.
 */
export function waitUntilFromPick(pick: string): string {
  if (pick.includes('T')) return pick;
  const [y, m, d] = pick.split('-').map(Number);
  const at = new Date(y, m - 1, d, 9, 0, 0, 0);
  return Number.isNaN(at.getTime()) ? pick : at.toISOString();
}

/** The line above a Waiting task's composer, '' for any other phase. */
export function waitingLineText(task: Pick<Task, 'phase' | 'wait_until'>): string {
  if (task.phase !== 'WAITING') return '';
  return `Waiting until ${formatWaitUntil(task.wait_until) || 'something happens'} · a message here moves it to In Progress`;
}

/**
 * Under the status options while the task is (or was just set) Waiting: the
 * time the server wakes it by itself. Collapsed like the date rows, the inline
 * calendar on click. Picking or clearing a time ends the interaction. Before
 * the task prop carries the server's default (the plain-PATCH fallback has no
 * optimistic copy) the label says what that default will be.
 */
function WaitUntilRow({ task, onSet }: { task: Pick<Task, 'id' | 'phase' | 'wait_until'>; onSet: (waitUntil: string) => void }) {
  const [open, setOpen] = useState(false);
  const until = formatWaitUntil(task.wait_until);
  const noClockLabel = task.phase === 'WAITING' ? 'Until: no time limit' : `Until: ${DEFAULT_WAIT_DAYS} days (default)`;
  return (
    <div className={`task-status-until${open ? ' open' : ''}`} data-testid="task-status-until">
      <div className="task-status-until-head">
        <button
          type="button"
          className="task-status-until-toggle"
          aria-expanded={open}
          data-testid="task-status-until-toggle"
          title="When the task comes back by itself if nothing has happened by then"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        >
          <span className="task-status-until-icon" aria-hidden="true">{ICONS.ICON_CALENDAR}</span>
          <span className="task-status-until-label">
            {until ? <>Until: <b>{until}</b></> : noClockLabel}
          </span>
          <span className={`task-kebab-status-caret${open ? ' open' : ''}`} aria-hidden="true">{ICONS.CHEVRON_GLYPH}</span>
        </button>
        {task.wait_until && (
          <button
            type="button"
            className="task-status-until-clear"
            data-testid="task-status-until-clear"
            title="No time limit: it waits until something happens"
            onClick={(e) => { e.stopPropagation(); setOpen(false); onSet(''); }}
          >
            No limit
          </button>
        )}
      </div>
      {open && (
        <DatePicker
          date={task.wait_until}
          inline
          onChange={(pick) => { setOpen(false); onSet(pick ? waitUntilFromPick(pick) : ''); }}
        />
      )}
    </div>
  );
}

/**
 * The status options, plus the until row once Waiting is picked. The row shows
 * the moment Waiting is clicked, before the task prop catches up (the plain
 * PATCH fallback has no optimistic copy); it goes again if the task's phase
 * then moves anywhere but Waiting.
 */
function StatusOptions({ task, onPick, onPickWaiting, onSetWaitUntil }: {
  task: Pick<Task, 'id' | 'phase' | 'wait_until'>;
  /** A pick other than Waiting: the caller writes it and closes. */
  onPick: (phase: TaskPhase) => void;
  /** Waiting picked: the caller writes it and stays open for the until row. */
  onPickWaiting: () => void;
  onSetWaitUntil: (waitUntil: string) => void;
}) {
  const [pickedWaiting, setPickedWaiting] = useState(false);
  useEffect(() => { setPickedWaiting(false); }, [task.phase]);
  const showUntil = task.phase === 'WAITING' || pickedWaiting;
  return (
    <>
      <StatusPills
        task={task}
        onPick={(phase) => {
          if (phase === 'WAITING') { setPickedWaiting(true); onPickWaiting(); return; }
          onPick(phase);
        }}
      />
      {showUntil && <WaitUntilRow task={task} onSet={onSetWaitUntil} />}
    </>
  );
}

function StatusPills({ task, onPick }: { task: Pick<Task, 'id' | 'phase'>; onPick: (phase: TaskPhase) => void }) {
  return (
    <div className="task-status-options" role="radiogroup" aria-label="Status">
      {STATUS_OPTIONS.map((o) => {
        const current = task.phase === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current}
            className={`task-status-pill task-status-pill-${o.value.toLowerCase()}${current ? ' is-current' : ''}`}
            data-phase={o.value}
            onClick={(e) => { e.stopPropagation(); onPick(o.value); }}
          >
            <span className="task-status-pill-icon" aria-hidden="true">{o.icon}</span>
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Above a Waiting task's composer: what it waits for, and what writing here
 * does. A message into the session is one of the ways out of Waiting, so a
 * human about to send one is told so at the moment it matters. No buttons: the
 * status control is where the status changes.
 */
export function WaitingComposerLine({ task }: { task: Task | null | undefined }) {
  if (!task || task.phase !== 'WAITING') return null;
  const until = formatWaitUntil(task.wait_until);
  return (
    <div
      className="task-waiting-line"
      data-testid="session-waiting-line"
      title={task.wait_until
        ? `Waiting until ${new Date(task.wait_until).toLocaleString()}, or until something happens first`
        : 'Waiting until something happens (a trigger fires, a message arrives)'}
    >
      <span className="task-waiting-icon" aria-hidden="true">{WAIT_UNTIL_ICON}</span>
      <span className="task-waiting-text">
        Waiting until <b>{until || 'something happens'}</b>
        <span className="task-waiting-note"> · a message here moves it to In Progress</span>
      </span>
    </div>
  );
}

/**
 * The event half of the menu's Start / Snooze until row, under the times:
 * "Something happens…", which hands the condition to the task's session
 * (utils/wait-until.ts). Its AI writes the trigger and sets the task to Waiting.
 */
export function SnoozeUntilEvent({ task, afterAction }: { task: Task; afterAction: () => void }) {
  const navigate = useNavigate();
  if (task.phase === 'COMPLETE') return null;
  return (
    <button
      type="button"
      className="task-kebab-item task-snooze-event"
      title={WAIT_UNTIL_TITLE}
      data-testid="task-wait-until"
      onClick={(e) => {
        e.stopPropagation();
        const where = requestWaitUntil(task, navigate);
        log.info('task-status', 'wait until requested', { taskId: task.id, where });
        afterAction();
      }}
    >
      <span className="task-kebab-icon">{WAIT_UNTIL_ICON}</span>
      <span>{WAIT_UNTIL_MENU_LABEL}</span>
    </button>
  );
}

/** The task menu's Status row: collapsed to the current status, the five options on click. */
export function TaskStatusMenuSection({ task, onSetPhase, onSetWaitUntil, afterAction }: {
  task: Task;
  onSetPhase?: SetPhase;
  /** Write wait_until (falls back to the board store, then a plain PATCH). */
  onSetWaitUntil?: SetWaitUntil;
  afterAction: () => void;
}) {
  const setPhase = useSetPhase(onSetPhase);
  const setWaitUntil = useSetWaitUntil(onSetWaitUntil);
  const [open, setOpen] = useState(false);
  const option = STATUS_OPTIONS.find((o) => o.value === task.phase);
  const until = task.phase === 'WAITING' ? formatWaitUntil(task.wait_until) : '';
  return (
    <>
      <div className="task-kebab-divider" />
      {/* The date rows' shape under its own classes: `.task-kebab-date*` means a date. */}
      <div className={`task-kebab-status-row${open ? ' open' : ''}`} data-testid="task-status-row">
        <button
          type="button"
          className="task-kebab-item task-kebab-status-toggle"
          aria-expanded={open}
          data-testid="task-status-toggle"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        >
          <span className="task-kebab-icon">{option?.icon ?? ICONS.ICON_PHASE_TODO}</span>
          <span className="task-kebab-status-value">
            Status: <b>{statusLabel(task.phase)}</b>
            {until ? <span className="task-kebab-status-until"> · until {until}</span> : null}
          </span>
          <span className={`task-kebab-status-caret${open ? ' open' : ''}`}>{ICONS.CHEVRON_GLYPH}</span>
        </button>
        {open && (
          <div className="task-kebab-status">
            <StatusOptions
              task={task}
              onPick={(phase) => { if (phase !== task.phase) setPhase(task.id, phase); afterAction(); }}
              onPickWaiting={() => { if (task.phase !== 'WAITING') setPhase(task.id, 'WAITING'); }}
              onSetWaitUntil={(waitUntil) => { setWaitUntil(task.id, waitUntil); afterAction(); }}
            />
          </div>
        )}
      </div>
    </>
  );
}

/** The detail pane's status badge: shows the status, click to change it. */
export function TaskStatusBadge({ task, onSetPhase, onSetWaitUntil }: { task: Task; onSetPhase?: SetPhase; onSetWaitUntil?: SetWaitUntil }) {
  const setPhase = useSetPhase(onSetPhase);
  const setWaitUntil = useSetWaitUntil(onSetWaitUntil);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pos = useMenuPlacement(open, btnRef, menuRef, { align: 'start', minHeight: 120, onAnchorLost: close });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    // Capture phase, and stopped: this Escape closes the menu only, not the
    // detail modal around the badge, whose own document listener would also run.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
      btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  const option = STATUS_OPTIONS.find((o) => o.value === task.phase);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`badge-phase badge-phase-${task.phase?.toLowerCase()} task-status-badge`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change status"
        data-testid="task-status-badge"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {option?.icon ?? '○'} {statusLabel(task.phase)} <span className="task-status-caret" aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu task-status-menu"
          role="menu"
          style={menuPlacementStyle(pos)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="task-kebab-status">
            <span className="task-kebab-status-label">Status</span>
            <StatusOptions
              task={task}
              onPick={(phase) => { if (phase !== task.phase) setPhase(task.id, phase); close(); }}
              onPickWaiting={() => { if (task.phase !== 'WAITING') setPhase(task.id, 'WAITING'); }}
              onSetWaitUntil={(waitUntil) => { setWaitUntil(task.id, waitUntil); close(); }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
