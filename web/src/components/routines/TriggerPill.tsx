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
import type { Routine, RoutineAuditEntry } from '@/api/routines';
import { useTaskTriggers } from '@/hooks/useTaskTriggers';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { removeRoutine, runRoutineNow, toggleRoutine } from '@/stores/routines-store';
import {
  auditClock, auditHistory, describeAuditEntry, describeCheck, describeFireTally, describeLastCheck,
  describeNextRun, describeSchedule,
} from '@/utils/routine-format';
import { openSessionOnHome } from '@/utils/open-session';
import { log } from '@/utils/log';

export interface TriggerPillProps {
  taskId: string | null | undefined;
}

/** The hover text: one line per trigger, so the pill alone tells what is polling. */
export function triggerPillTitle(routines: readonly Routine[], nowMs = Date.now()): string {
  return routines
    .map((r) => `${r.name}: ${describeSchedule(r.schedule)}, ${r.check ? describeCheck(r.check) : ''}, ${describeFireTally(r.state, nowMs)}, last check ${describeLastCheck(r.state.lastCheck, nowMs)}`)
    .join('\n');
}

/** The prompt a fire injects — what this trigger will say to the session. */
function promptOf(routine: Routine): string {
  const config = (routine.executor?.config ?? {}) as { prompt?: unknown; instructions?: unknown };
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  const instructions = typeof config.instructions === 'string' ? config.instructions : '';
  return (prompt || instructions).trim();
}

/**
 * One audit row. A fire opens to show the message the session actually received
 * (the answer to "what is the injected context") plus a way into that session;
 * a quiet or failed check is the sentence alone, since there is nothing to open.
 */
function AuditRow({ entry, onOpenSession }: { entry: RoutineAuditEntry; onOpenSession: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const sessionId = entry.delivery?.sessionId;
  const canOpen = entry.outcome === 'fired' && (!!entry.injected || !!sessionId);
  // The list scrolls inside a bounded flyout, so a row opened near its bottom edge
  // puts the injected text half below the fold with nothing saying to scroll. The
  // whole ROW is scrolled, not just the detail: bringing only the detail into view
  // pushed its own headline out, leaving text with nothing saying what it belongs to.
  useEffect(() => {
    if (open) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  return (
    <li ref={rowRef} className="trigger-audit-row" data-outcome={entry.outcome} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="trigger-audit-line"
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        onClick={() => canOpen && setOpen((v) => !v)}
      >
        <span className="trigger-audit-clock">{auditClock(entry.atMs)}</span>
        <span className="trigger-audit-what">{describeAuditEntry(entry)}</span>
        {canOpen && <span className={`trigger-audit-chevron${open ? ' open' : ''}`}>›</span>}
      </button>
      {open && (
        <div className="trigger-audit-detail">
          {entry.injected ? (
            <>
              <div className="trigger-audit-detail-label">
                Injected into the session ({entry.injected.chars} chars)
              </div>
              <pre className="trigger-audit-injected">{entry.injected.preview}</pre>
            </>
          ) : (
            <div className="trigger-audit-detail-label">No injected text was recorded for this fire.</div>
          )}
          {sessionId && (
            <button type="button" className="trigger-jobs-link" onClick={() => onOpenSession(sessionId)}>
              Open that session
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function TriggerRow({ routine, onOpenSession }: { routine: Routine; onOpenSession: (sessionId: string) => void }) {
  const [busy, setBusy] = useState<'run' | 'disable' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const prompt = promptOf(routine);
  const fireCount = routine.state.fireCount ?? routine.state.fireLog?.length ?? 0;
  const nextRun = describeNextRun(routine.state);
  // checkLog carries the fires too (a fire absent from it would read as a gap in
  // the clock), and fireLog is the fire-only memory that survives a burst of quiet
  // checks; auditHistory merges them so one fire is one row.
  const history = auditHistory(routine.state);

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
      {/* The one line that answers "does this actually work": how many times it
          has fired, and when — not just what the newest check decided. */}
      <div className="trigger-jobs-tally" data-fired={fireCount > 0 ? 'true' : 'false'}>
        {describeFireTally(routine.state)}
        {nextRun ? ` · ${nextRun.toLowerCase()}` : ''}
      </div>
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
      {/* What it WILL inject: the prompt, before any fire has happened. */}
      {prompt && (
        <div className="trigger-jobs-fold">
          <button type="button" className="trigger-jobs-fold-toggle" aria-expanded={showPrompt} onClick={() => setShowPrompt((v) => !v)}>
            <span>What it injects when it fires</span>
            <span className={`trigger-audit-chevron${showPrompt ? ' open' : ''}`}>›</span>
          </button>
          {showPrompt && <pre className="trigger-audit-injected">{prompt}</pre>}
        </div>
      )}
      {/* The audit trail: every check the daemon reported, newest first. */}
      <div className="trigger-jobs-fold">
        <button
          type="button"
          className="trigger-jobs-fold-toggle"
          aria-expanded={showHistory}
          disabled={history.length === 0}
          onClick={() => setShowHistory((v) => !v)}
          data-testid="trigger-audit-toggle"
        >
          {/* The count is of RECORDED checks, not of everything the trigger ever
              did: the fire tally above is the total. Saying "0 fired" here read as
              "it has never fired" on a trigger that fired before this trail
              existed, which is the opposite of the truth. */}
          <span>
            {history.length
              ? `History (${history.length} recorded ${history.length === 1 ? 'check' : 'checks'})`
              : 'No checks recorded yet'}
          </span>
          {history.length > 0 && <span className={`trigger-audit-chevron${showHistory ? ' open' : ''}`}>›</span>}
        </button>
        {showHistory && (
          <ul className="trigger-audit-list" data-testid="trigger-audit-list">
            {history.map((entry, i) => (
              <AuditRow key={`${entry.atMs}-${entry.outcome}-${entry.seq ?? i}`} entry={entry} onOpenSession={onOpenSession} />
            ))}
          </ul>
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
                {triggers.map((r) => (
                  <TriggerRow
                    key={r.id}
                    routine={r}
                    onOpenSession={(sessionId) => { close(false); openSessionOnHome(sessionId, navigate); }}
                  />
                ))}
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
