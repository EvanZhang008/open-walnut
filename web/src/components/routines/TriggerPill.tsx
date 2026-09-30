/**
 * TRIGGER pill: a task with a walnut-trigger shows it next to its title, the way
 * a live CLI cron job shows CRON. The pill is the trigger's own handle: clicking
 * it opens the trigger itself (name, what it does, cadence, the check command and
 * host, the last check the daemon reported) with Run check now / Pause / Delete,
 * never a generic page. Rendered on the task rows, the Focus cards and the
 * session header from the one shared routines store.
 *
 * A paused trigger stays: the pill turns muted and reads TRIGGER · PAUSED (or
 * "· 1 PAUSED" beside armed ones), and its flyout row offers Resume. Switching
 * one off used to make it vanish, which read as a delete. A trigger the server
 * stopped after its check kept failing stays the same way, marked STOPPED.
 *
 * On a task snoozed until something happens (task.waiting) the same pill reads
 * SNOOZED, in the snooze's amber: a snoozed row shows why it is quiet the way a
 * time-snoozed one shows its start date. Its flyout leads with what the task
 * waits for and Unsnooze, then the trigger behind it. It needs the task for that,
 * and shows from the task alone, before the routines store has loaded.
 *
 * Overlay rules (web/src/AGENTS.md): placed by useMenuPlacement, portalled to
 * <body>, root stops pointerdown propagation (the rows are dnd-kit draggables),
 * outside-click closer exempts `.trigger-jobs-flyout`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { isTaskWaiting, type Task } from '@open-walnut/core';
import type { Routine, RoutineAuditEntry } from '@/api/routines';
import { useTaskTriggers } from '@/hooks/useTaskTriggers';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { removeRoutine, runRoutineNow, setRoutineEnabled } from '@/stores/routines-store';
import {
  auditClock, auditHistory, describeAuditEntry, describeCheck, describeFireTally, describeLastCheck,
  describeNextRun, describeSchedule, describeTriggerOff, triggerRunState,
} from '@/utils/routine-format';
import '@/styles/trigger-state.css';
import { openSessionOnHome } from '@/utils/open-session';
import { WaitingLine, waitingBackBy } from '@/components/tasks/TaskStatusControl';
import '@/styles/routine-description.css';
import { log } from '@/utils/log';

export interface TriggerPillProps {
  taskId: string | null | undefined;
  /** The task itself: a snoozed one (task.waiting) makes this the SNOOZED pill. */
  task?: Task | null;
}

type PillTrigger = Pick<Routine, 'id' | 'enabled'> & { state?: Routine['state'] };

/** "PAUSED" / "STOPPED" for a set of switched-off triggers ("OFF" when they differ). */
function offWord(off: readonly PillTrigger[]): string {
  const states = new Set(off.map((r) => triggerRunState(r)));
  if (states.size !== 1) return 'OFF';
  return states.has('stopped') ? 'STOPPED' : states.has('paused') ? 'PAUSED' : 'OFF';
}

/**
 * The pill's text: SNOOZED leads on a snoozed task, other triggers ride after it.
 * Switched-off triggers say so: `TRIGGER · PAUSED` when none polls,
 * `TRIGGER ×3 · 1 PAUSED` when some do.
 */
export function triggerPillLabel(triggers: readonly PillTrigger[], snoozedOn?: string | null): string {
  const others = snoozedOn ? triggers.filter((r) => r.id !== snoozedOn) : triggers;
  const off = others.filter((r) => !r.enabled);
  let trigger = '';
  if (others.length) {
    trigger = `TRIGGER${others.length > 1 ? ` ×${others.length}` : ''}`;
    if (off.length === others.length) trigger += ` · ${offWord(off)}`;
    else if (off.length) trigger += ` · ${off.length} ${offWord(off)}`;
  }
  if (!snoozedOn) return trigger;
  const own = triggers.find((r) => r.id === snoozedOn);
  const snooze = own && !own.enabled ? `SNOOZED · ${offWord([own])}` : 'SNOOZED';
  return trigger ? `${snooze} · ${trigger}` : snooze;
}

/** The hover text: one line per trigger, so the pill alone tells what is polling. */
export function triggerPillTitle(routines: readonly Routine[], nowMs = Date.now()): string {
  return routines
    .map((r) => {
      const off = describeTriggerOff(r, nowMs);
      return `${r.name}${off ? ` (${off.toLowerCase()})` : ''}: ${r.description ? `${r.description.replace(/\s+/g, ' ')} · ` : ''}${describeSchedule(r.schedule)}, ${r.check ? describeCheck(r.check) : ''}, ${describeFireTally(r.state, nowMs)}, last check ${describeLastCheck(r.state.lastCheck, nowMs)}`;
    })
    .join('\n');
}

/**
 * The triggers the pill shows. The routine behind a snooze wait that has ended
 * is switched off by the wait itself (task-waiting.ts), kept only so the session
 * can re-arm it: not a trigger anyone paused, so it stays hidden. It is known by
 * its own stamp (waitEndedAtMs) or, for one switched off before that stamp
 * existed, by the task's ended wait; until the task is known, no switched-off
 * trigger shows, so none flashes as Paused and then vanishes.
 */
export function visibleTaskTriggers(triggers: readonly Routine[], task: Task | null | undefined, taskId: string | null | undefined): Routine[] {
  const known = !!task && task.id === taskId;
  const settled = known && task!.waiting && !isTaskWaiting(task!) ? task!.waiting.routine_id : null;
  if (known && !settled && triggers.every((r) => r.enabled || triggerRunState(r) !== 'wait-ended')) return triggers as Routine[];
  return triggers.filter((r) => r.enabled || (known && r.id !== settled && triggerRunState(r) !== 'wait-ended'));
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
  const [busy, setBusy] = useState<'run' | 'pause' | 'resume' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const prompt = promptOf(routine);
  const fireCount = routine.state.fireCount ?? routine.state.fireLog?.length ?? 0;
  const run = triggerRunState(routine);
  const off = describeTriggerOff(routine);
  const nextRun = off ? null : describeNextRun(routine.state);
  // checkLog carries the fires too (a fire absent from it would read as a gap in
  // the clock), and fireLog is the fire-only memory that survives a burst of quiet
  // checks; auditHistory merges them so one fire is one row.
  const history = auditHistory(routine.state);

  // Delete needs no close step: the store drops the routine from the task's list
  // at once, and the pill closes itself when none is left. Pause keeps the row.
  const act = async (kind: 'run' | 'pause' | 'resume' | 'delete', fn: () => Promise<unknown>) => {
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
    <li className="trigger-jobs-row" data-routine-id={routine.id} data-state={run}>
      <div className="trigger-jobs-heading">
        <strong>{routine.name}</strong>
        <span className="trigger-jobs-heading-side">
          {off && (
            <span className="trigger-jobs-state" data-state={run} data-testid="trigger-jobs-state">
              {run === 'stopped' ? 'Stopped' : 'Paused'}
            </span>
          )}
          <span className="trigger-jobs-cadence">{describeSchedule(routine.schedule)}</span>
        </span>
      </div>
      {routine.description && (
        <p className="routine-description trigger-jobs-description" title={routine.description}>{routine.description}</p>
      )}
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
      {/* What switching it back on will do, said before the user presses it. */}
      {off && (
        <div className="trigger-jobs-off" data-state={run} data-testid="trigger-jobs-off">
          {run === 'stopped'
            ? `${off}. Resume retries the check; one more failure stops it again.`
            : `${off}: not checking. On Resume, anything that appeared meanwhile arrives once, as one fire.`}
        </div>
      )}
      {error && <div className="trigger-jobs-error" role="alert">{error}</div>}
      <div className="trigger-jobs-actions">
        {off ? (
          <button
            type="button"
            className="trigger-jobs-resume"
            disabled={busy !== null}
            onClick={() => void act('resume', () => setRoutineEnabled(routine.id, true))}
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
        ) : (
          <>
            <button type="button" disabled={busy !== null} onClick={() => void act('run', () => runRoutineNow(routine.id))}>
              {busy === 'run' ? 'Running…' : 'Run check now'}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act('pause', () => setRoutineEnabled(routine.id, false))}>
              {busy === 'pause' ? 'Pausing…' : 'Pause'}
            </button>
          </>
        )}
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

export function TriggerPill({ taskId, task }: TriggerPillProps) {
  const all = useTaskTriggers(taskId);
  const triggers = useMemo(() => visibleTaskTriggers(all, task, taskId), [all, task, taskId]);
  const snoozed = !!task && task.id === taskId && isTaskWaiting(task) && !!task.waiting;
  const snoozedOn = snoozed ? task!.waiting!.routine_id : null;
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

  // The last trigger deleted from the flyout takes the pill with it, and so does
  // Unsnooze: a pill that comes back later must not come back open.
  useEffect(() => {
    if (open && triggers.length === 0 && !snoozed) setOpen(false);
  }, [open, triggers.length, snoozed]);

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

  if (!taskId || (triggers.length === 0 && !snoozed)) return null;

  const condition = snoozed ? task!.waiting!.condition : '';
  const backBy = snoozed ? waitingBackBy(task) : '';
  // Nothing on the task polls: the pill goes muted instead of away.
  const allOff = triggers.length > 0 && triggers.every((r) => !r.enabled);
  const what = snoozed
    ? `Snoozed until: ${condition}${backBy ? ` (back by ${backBy})` : ''}`
    : allOff ? `Trigger ${offWord(triggers).toLowerCase()}` : 'Trigger armed';
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`task-trigger-pill${snoozed ? ' is-snoozed' : allOff ? ' is-paused' : ''}`}
        title={snoozed ? [what, triggerPillTitle(triggers)].filter(Boolean).join('\n') : triggerPillTitle(triggers)}
        aria-label={`${what}. ${open ? 'Hide' : 'Show'} ${snoozed ? 'snooze' : 'trigger'} details`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="task-trigger-pill"
        data-trigger-count={triggers.length}
        data-snoozed={snoozed ? 'true' : undefined}
        data-paused={allOff ? 'true' : undefined}
        data-off={allOff ? offWord(triggers).toLowerCase() : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        // WebKit never focuses a button on click, so the mousedown would focus the
        // row around the pill instead; the row then scrolls itself into view between
        // mousedown and mouseup and the click lands on whatever moved under the
        // pointer (traced in Playwright WebKit: pointerdown on the pill, click on a
        // group header). Keyboard focus is unaffected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
      >
        {triggerPillLabel(triggers, snoozedOn)}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="trigger-jobs-flyout"
              role="dialog"
              aria-label={snoozed ? 'Snooze and its trigger' : 'Triggers on this task'}
              data-testid="trigger-jobs-flyout"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {snoozed && (
                <div className="trigger-jobs-snooze">
                  <WaitingLine task={task!} testId="trigger-jobs-snooze" />
                </div>
              )}
              <div className="trigger-jobs-title">
                <span>
                  {triggers.length === 0 ? 'Its trigger is not loaded yet'
                    : triggers.length === 1 ? 'Trigger on this task' : `${triggers.length} triggers on this task`}
                </span>
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
