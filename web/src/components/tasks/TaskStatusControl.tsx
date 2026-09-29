/**
 * Task status, visible and changeable: the collapsed Status row in the task
 * menu and the clickable status badge in the detail pane. Plus the "snooze until
 * something happens" half of the menu's Start / Snooze until row.
 *
 * All four phases are offered. The row checkbox still toggles To Do / Complete;
 * this is where In Progress and Need Action can be read and set by hand.
 *
 * Waiting on an event is NOT a status (user call 2026-09-28: "keep it todo,
 * still show in Now", and "status is status"). It is the second kind of snooze,
 * next to a time: the Start / Snooze until row holds both, and says what the
 * task is snoozed until. Picking Need Action or Complete ends the wait on the
 * server (applyPhase), so the status options need no special case for it.
 *
 * Overlay rules (web/src/AGENTS.md): the badge's menu is placed by
 * useMenuPlacement, portalled to <body>, stops pointerdown (task rows are dnd
 * draggables) and closes on an outside pointerdown.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { isTaskWaiting, type Task, type TaskPhase } from '@open-walnut/core';
import * as ICONS from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { apiDelete } from '@/api/client';
import { updateTask as apiUpdateTask } from '@/api/tasks';
import { requestWaitUntil, WAIT_UNTIL_MENU_LABEL, WAIT_UNTIL_TITLE } from '@/utils/wait-until';
// formatDraftDate: the default backstop is exactly 7 days out, which the shared
// formatter would print as today's weekday.
import { formatDraftDate } from '@/components/sessions/draft-decisions';
import { log } from '@/utils/log';
import '@/styles/task-status.css';

export const STATUS_OPTIONS: { value: TaskPhase; label: string; icon: ReactNode }[] = [
  { value: 'TODO', label: 'To Do', icon: ICONS.ICON_PHASE_TODO },
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

export async function stopWaiting(taskId: string): Promise<void> {
  log.info('task-status', 'stop waiting', { taskId });
  await apiDelete(`/api/v1/tasks/${encodeURIComponent(taskId)}/wait`);
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

/** When a snooze's backstop brings the task back anyway ('' when it has none). */
export function waitingBackBy(task: Task | null | undefined): string {
  return task?.waiting?.until ? formatDraftDate(task.waiting.until) : '';
}

/** What an event-snoozed task waits for ('' when it is not waiting), for the collapsed row. */
export function waitingSummary(task: Task | null | undefined): string {
  return task && isTaskWaiting(task) && task.waiting ? task.waiting.condition : '';
}

/** "Snoozed until: <condition>" with Unsnooze. Renders nothing for a task that is not waiting. */
export function WaitingLine({ task, compact, note, className, testId }: {
  task: Task;
  compact?: boolean;
  /** A sentence after the condition, in the same line. */
  note?: string;
  className?: string;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isTaskWaiting(task) || !task.waiting) return null;
  return (
    <div
      className={`task-waiting-line${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
      data-testid={testId ?? 'task-waiting-line'}
    >
      <span className="task-waiting-icon" aria-hidden="true">{WAIT_UNTIL_ICON}</span>
      <span
        className="task-waiting-text"
        title={`${task.waiting.condition}${task.waiting.until
          ? `\nIf it has not happened by ${new Date(task.waiting.until).toLocaleString()}, the task comes back anyway.` : ''}`}
      >
        Snoozed until: <b>{task.waiting.condition}</b>
        {task.waiting.until ? <span className="task-waiting-backstop"> · back by {waitingBackBy(task)}</span> : null}
        {note ? <span className="task-waiting-note"> · {note}</span> : null}
      </span>
      <button
        type="button"
        className="task-waiting-stop"
        disabled={busy}
        title="Unsnooze: the task stays To Do and its trigger is deleted"
        onClick={(e) => {
          e.stopPropagation();
          setBusy(true);
          setError(null);
          stopWaiting(task.id)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Unsnoozing…' : 'Unsnooze'}
      </button>
      {error && <span className="task-waiting-error" role="alert">{error}</span>}
    </div>
  );
}

/**
 * Above a waiting task's composer: the snooze still holds. A message no longer
 * ends it (user call 2026-09-29), so a human writing to the session is told so
 * at the moment it matters, next to the one button that does end it.
 */
export function SnoozedComposerNotice({ task }: { task: Task | null | undefined }) {
  if (!task || !isTaskWaiting(task)) return null;
  return (
    <WaitingLine
      task={task}
      className="task-waiting-composer"
      testId="session-snoozed-notice"
      note="Messages here don't cancel it"
    />
  );
}

/**
 * The event half of the menu's Start / Snooze until row, under the times: what
 * the task is snoozed until (with Unsnooze), or "Something happens…", which
 * hands the condition to the task's session (utils/wait-until.ts).
 */
export function SnoozeUntilEvent({ task, afterAction }: { task: Task; afterAction: () => void }) {
  const navigate = useNavigate();
  if (isTaskWaiting(task)) return <WaitingLine task={task} compact />;
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

/** The task menu's Status row: collapsed to the current status, the four options on click. */
export function TaskStatusMenuSection({ task, onSetPhase, afterAction }: {
  task: Task;
  onSetPhase?: SetPhase;
  afterAction: () => void;
}) {
  const setPhase = useSetPhase(onSetPhase);
  const [open, setOpen] = useState(false);
  const option = STATUS_OPTIONS.find((o) => o.value === task.phase);
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
          <span className="task-kebab-status-value">Status: <b>{statusLabel(task.phase)}</b></span>
          <span className={`task-kebab-status-caret${open ? ' open' : ''}`}>{ICONS.CHEVRON_GLYPH}</span>
        </button>
        {open && (
          <div className="task-kebab-status">
            <StatusPills
              task={task}
              onPick={(phase) => { if (phase !== task.phase) setPhase(task.id, phase); afterAction(); }}
            />
          </div>
        )}
      </div>
    </>
  );
}

/** The detail pane's status badge: shows the status, click to change it. */
export function TaskStatusBadge({ task, onSetPhase }: { task: Task; onSetPhase?: SetPhase }) {
  const setPhase = useSetPhase(onSetPhase);
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
            <StatusPills
              task={task}
              onPick={(phase) => { if (phase !== task.phase) setPhase(task.id, phase); close(); }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
