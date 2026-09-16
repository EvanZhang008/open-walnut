/**
 * TRIGGER pill: a task with an armed walnut-trigger shows it next to its title,
 * the way a live CLI cron job shows CRON. The pill is the trigger's own handle:
 * clicking it opens the trigger itself (name, cadence, the check command and
 * host, the last check the daemon reported) with Run now / Disable / Delete,
 * never a generic page. Rendered on the task rows, the Focus cards and the
 * session header from the one shared routines store.
 *
 * Overlay rules (web/src/AGENTS.md): placed by useMenuPlacement, portalled to
 * <body>, root stops pointerdown propagation (the rows are dnd-kit draggables),
 * outside-click closer exempts `.trigger-jobs-flyout`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Routine } from '@/api/routines';
import { useTaskTriggers } from '@/hooks/useTaskTriggers';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { removeRoutine, runRoutineNow, toggleRoutine } from '@/stores/routines-store';
import { describeCheck, describeLastCheck, describeSchedule } from '@/utils/routine-format';
import { log } from '@/utils/log';

export interface TriggerPillProps {
  taskId: string | null | undefined;
}

/** The hover text: one line per trigger, so the pill alone tells what is polling. */
export function triggerPillTitle(routines: readonly Routine[], nowMs = Date.now()): string {
  return routines
    .map((r) => `${r.name}: ${describeSchedule(r.schedule)}, ${r.check ? describeCheck(r.check) : ''}, last check ${describeLastCheck(r.state.lastCheck, nowMs)}`)
    .join('\n');
}

function TriggerRow({ routine }: { routine: Routine }) {
  const [busy, setBusy] = useState<'run' | 'disable' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Disable and Delete need no close step: the store drops the routine from the
  // task's list at once, and the pill closes itself when none is left.
  const act = async (kind: 'run' | 'disable' | 'delete', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      log.info('trigger-pill', `trigger ${kind}`, { routineId: routine.id, name: routine.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="trigger-jobs-row" data-routine-id={routine.id}>
      <div className="trigger-jobs-heading">
        <strong>{routine.name}</strong>
        <span className="trigger-jobs-cadence">{describeSchedule(routine.schedule)}</span>
      </div>
      {routine.check && <code className="trigger-jobs-run" title={routine.check.run}>{describeCheck(routine.check)}</code>}
      <div className="trigger-jobs-last" data-outcome={routine.state.lastCheck?.outcome ?? 'none'}>
        last check: {describeLastCheck(routine.state.lastCheck)}
      </div>
      {error && <div className="trigger-jobs-error" role="alert">{error}</div>}
      <div className="trigger-jobs-actions">
        <button type="button" disabled={busy !== null} onClick={() => void act('run', () => runRoutineNow(routine.id))}>
          {busy === 'run' ? 'Running…' : 'Run check now'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void act('disable', () => toggleRoutine(routine.id))}>
          {busy === 'disable' ? 'Disabling…' : 'Disable'}
        </button>
        {confirmDelete ? (
          <button
            type="button"
            className="trigger-jobs-danger"
            disabled={busy !== null}
            onClick={() => void act('delete', () => removeRoutine(routine.id))}
          >
            {busy === 'delete' ? 'Deleting…' : 'Confirm delete'}
          </button>
        ) : (
          <button type="button" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>Delete</button>
        )}
      </div>
    </li>
  );
}

export function TriggerPill({ taskId }: TriggerPillProps) {
  const triggers = useTaskTriggers(taskId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const placement = useMenuPlacement(open, triggerRef, menuRef, {
    align: 'start',
    preferSide: 'down',
    minHeight: 120,
    onAnchorLost: () => {
      log.info('trigger-pill', 'flyout closed: anchor lost', { taskId });
      setOpen(false);
    },
  });

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // The last trigger disabled or deleted from the flyout takes the pill with it.
  useEffect(() => {
    if (open && triggers.length === 0) setOpen(false);
  }, [open, triggers.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.trigger-jobs-flyout')) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!taskId || triggers.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="task-trigger-pill"
        title={triggerPillTitle(triggers)}
        aria-label={open ? 'Trigger armed. Hide trigger details' : 'Trigger armed. Show trigger details'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="task-trigger-pill"
        data-trigger-count={triggers.length}
        onPointerDown={(e) => e.stopPropagation()}
        // WebKit never focuses a button on click, so the mousedown would focus the
        // row around the pill instead; the row then scrolls itself into view between
        // mousedown and mouseup and the click lands on whatever moved under the
        // pointer (traced in Playwright WebKit: pointerdown on the pill, click on a
        // group header). Keyboard focus is unaffected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
      >
        TRIGGER{triggers.length > 1 ? ` ×${triggers.length}` : ''}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="trigger-jobs-flyout"
              role="dialog"
              aria-label="Armed triggers"
              data-testid="trigger-jobs-flyout"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="trigger-jobs-title">
                <span>{triggers.length === 1 ? 'Trigger' : `${triggers.length} triggers`} on this task</span>
                <button
                  type="button"
                  className="trigger-jobs-link"
                  onClick={() => { close(false); navigate('/routines'); }}
                >
                  Open Routines
                </button>
              </div>
              <ul className="trigger-jobs-list">
                {triggers.map((r) => <TriggerRow key={r.id} routine={r} />)}
              </ul>
              <div className="trigger-jobs-foot">
                The check runs on the daemon; a fire is delivered into this task&apos;s session.
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
