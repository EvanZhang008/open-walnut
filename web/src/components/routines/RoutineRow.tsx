/**
 * One routine on the Routines page: a single line (the dot, the name, how often it
 * runs and when next, the switch) that opens in place to everything else: what it
 * is for, the task it runs in, the check or the clock, the last error, what it
 * sends, its history, and Run now / Edit / Delete (2026-11-04, the user: "default
 * first page show min info").
 *
 * The line and the switch are siblings, never one inside the other: the line is
 * the button that opens the row, the switch only pauses or resumes.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Routine } from '@/api/routines';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { AuditRow } from './RoutineAuditRow';
import {
  auditHistory, clockHostTitle, describeAgo, describeCheck, describeClockHost, describeClockWait,
  describeAuditEntry, describeExecutorBadge, describeFireTally, describeLastCheck, describeRoutineTiming, describeRunTime,
} from '@/utils/routine-format';
import { describeMissed, describeRunEntry, runEntryFailed } from '@/utils/routine-runs';
import { openSessionOnHome, openTaskOnHome } from '@/utils/open-session';
import {
  collapseRepeats, healthLabel, historyWords, nameTaskIn, offLabel, quietReason, routineError, routineHealth, rowTiming, runOutcome, runStamp, settledRun,
} from './routine-groups';
import '@/styles/routine-description.css';

interface RoutineRowProps {
  routine: Routine;
  executorLabels: Record<string, string>;
  open: boolean;
  /** Just made: drawn out briefly so the person sees where it went. */
  isNew?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pause (false) or Resume (true): the state the row asks for, never a flip. */
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => Promise<unknown> | void;
  /** Run a missed slot now, as that slot's run. */
  onCatchUp?: (id: string, slotMs: number) => Promise<unknown>;
  /** Set a missed run aside. */
  onDismissMissed?: (id: string, slotMs: number) => Promise<unknown>;
  onEdit: (routine: Routine) => void;
  onDelete: (id: string) => void;
  /** A pause, resume or delete the server refused, said on this row. */
  actionError?: string;
  onDismissError?: (id: string) => void;
}

function promptOf(routine: Routine): string {
  const config = (routine.executor?.config ?? {}) as { prompt?: unknown; instructions?: unknown };
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  const instructions = typeof config.instructions === 'string' ? config.instructions : '';
  return (prompt || instructions).trim();
}

/** "2h ago · ok in 14s": the plain routine's own one-line history. */
function lastRunLine(routine: Routine): string | null {
  const s = routine.state;
  if (typeof s.lastRunAtMs !== 'number') return null;
  const outcome = s.lastStatus === 'error' ? 'failed' : s.lastStatus === 'skipped' ? 'skipped' : 'ok';
  const took = typeof s.lastDurationMs === 'number' && s.lastDurationMs >= 1000 ? ` in ${Math.round(s.lastDurationMs / 1000)}s` : '';
  return `${describeAgo(s.lastRunAtMs)} · ${outcome}${took}`;
}

export function RoutineRow({
  routine, executorLabels, open, isNew = false, onOpenChange, onToggle, onRunNow, onCatchUp, onDismissMissed, onEdit, onDelete,
  actionError, onDismissError,
}: RoutineRowProps) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [running, setRunning] = useState(false);
  const health = routineHealth(routine);
  const label = healthLabel(routine);
  const detailId = `routine-detail-${routine.id}`;
  // A paused trigger is disarmed on its daemon, which answers a run with
  // "unknown trigger"; Resume is the way to check it again.
  const canRunNow = routine.enabled || !routine.check;
  const waiting = describeClockWait(routine);
  const prompt = promptOf(routine);
  const history = auditHistory(routine.state);
  // A plain routine's own runs (cron/run-log.ts); a trigger's history is its checks.
  const runs = routine.check ? [] : routine.state.runLog ?? [];
  const missed = routine.missed ?? [];
  const runTime = routine.check ? describeRunTime(routine.state.lastCheck, routine.check) : null;
  const [missedBusy, setMissedBusy] = useState<number | null>(null);
  const [missedError, setMissedError] = useState<string | null>(null);
  const actOnMissed = (slotMs: number, act?: (id: string, slotMs: number) => Promise<unknown>) => {
    if (!act) return;
    setMissedBusy(slotMs);
    setMissedError(null);
    act(routine.id, slotMs)
      .catch((err: unknown) => setMissedError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMissedBusy(null));
  };
  const lastRun = routine.check ? null : lastRunLine(routine);
  const switchWord = routine.enabled ? 'Pause' : offLabel(routine) === 'Off' ? 'Turn on' : 'Resume';
  const owner = routine.owner;
  const quiet = quietReason(routine);
  const error = routineError(routine);

  // What the last Run now answered, shown beside the buttons: "Started" until the
  // routine shows how the run ended, then that (a success clears after a few seconds).
  const [ran, setRan] = useState<{ ok: boolean; text: string; before?: string } | null>(null);
  const settled = ran?.ok && ran.before !== undefined ? settledRun(ran.before, routine) : null;
  const outcome = settled ?? ran;
  // "Started" with no word from the routine yet (a long turn) goes quietly after a while.
  const unsettled = ran?.before !== undefined && !settled;
  useEffect(() => {
    if (!outcome?.ok) return;
    const t = setTimeout(() => setRan(null), unsettled ? 15_000 : 4000);
    return () => clearTimeout(t);
  }, [outcome?.ok, outcome?.text, unsettled]);
  const runNow = async () => {
    const before = runStamp(routine);
    setRunning(true);
    setRan(null);
    try {
      const answer = runOutcome(await onRunNow(routine.id));
      setRan(answer.ok ? { ...answer, before } : answer);
    } catch (err) {
      setRan({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <li
      className={`routine-row cron-job-card routine-card${routine.enabled ? '' : ' cron-job-disabled'}${open ? ' routine-row-open' : ''}${isNew ? ' routine-row-new' : ''}`}
      data-routine-id={routine.id}
      data-health={health}
    >
      <div className="routine-row-line">
        <button
          type="button"
          className="routine-row-main"
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          onClick={() => { onOpenChange(!open); setConfirmDelete(false); }}
        >
          <span className={`routine-dot cron-status-dot ${health}`} title={label} aria-label={label} role="img" />
          <span className="routine-row-text">
            <span className="routine-row-name cron-job-name">{routine.name}</span>
            <span className="routine-row-timing cron-job-desc">
              {health === 'error' ? (
                <>
                  <span className="routine-row-flag">{label === 'Stopped' ? 'Stopped' : 'Failed'}</span>
                  <span className="routine-row-flag-sep" aria-hidden="true"> · </span>
                </>
              ) : missed.length > 0 && (
                <>
                  <span className="routine-row-flag routine-row-flag-missed" data-testid="routine-row-missed">
                    {missed.length === 1 ? 'Missed a run' : `Missed ${missed.length} runs`}
                  </span>
                  <span className="routine-row-flag-sep" aria-hidden="true"> · </span>
                </>
              )}
              {rowTiming(routine).replace(/ (AM|PM)\b/g, '\u00a0$1')}
            </span>
          </span>
          <Chevron open={open} />
        </button>
        <span className="routine-row-switch" title={switchWord}>
          <ToggleSwitch
            checked={routine.enabled}
            onChange={(on) => onToggle(routine.id, on)}
            aria-label={`${switchWord} ${routine.name}`}
            data-testid={`routine-switch-${routine.id}`}
          />
        </span>
      </div>
      {actionError && (
        <div className="routine-action-error" role="alert" data-testid="routine-action-error">
          <span>{nameTaskIn(actionError, routine)}</span>
          {onDismissError && (
            <button type="button" className="routine-action-error-dismiss" aria-label="Dismiss" onClick={() => onDismissError(routine.id)}>×</button>
          )}
        </div>
      )}

      {open && (
        <div className="routine-detail" id={detailId}>
          {routine.description && <p className="routine-description routine-card-description">{routine.description}</p>}
          <dl className="routine-facts">
            {quiet && (
              <>
                <dt>State</dt>
                <dd className="routine-quiet">{quiet}</dd>
              </>
            )}
            <dt>When</dt>
            <dd>{describeRoutineTiming(routine.schedule, routine.enabled && !waiting ? routine.state : undefined, routine.wake)}</dd>
            <dt>Runs</dt>
            <dd>
              {routine.check
                ? "In its task's session, when its check finds something"
                : routine.executor?.type === 'session' ? "In its task's session" : describeExecutorBadge(routine.executor, executorLabels)}
            </dd>
            {owner && (
              <>
                <dt>Task</dt>
                <dd className="routine-task-title">{owner.title || owner.taskId}</dd>
              </>
            )}
            {routine.check && (
              <>
                <dt>Check</dt>
                <dd>
                  <code className="routine-check-run" title={routine.check.run}>{describeCheck(routine.check)}</code>
                  <span className={`routine-check-status ${routine.state.lastCheck?.outcome ?? 'pending'}`}>
                    {' · '}last check: {describeLastCheck(routine.state.lastCheck, undefined, routine.check)}
                  </span>
                  {runTime && (
                    <>
                      {' · '}
                      <span className="routine-check-time" data-near={runTime.near ? 'true' : 'false'} data-testid="routine-check-time">
                        {runTime.text}
                      </span>
                    </>
                  )}
                </dd>
                <dt>Fired</dt>
                <dd className="routine-check-tally" data-fired={(routine.state.fireCount ?? 0) > 0 ? 'true' : 'false'}>
                  {describeFireTally(routine.state)}
                  {routine.check.maxFiresPerDay ? ` · at most ${routine.check.maxFiresPerDay} a day` : ''}
                </dd>
              </>
            )}
            {!routine.check && routine.state.clockHost && (
              <>
                <dt>Clock</dt>
                <dd title={clockHostTitle(routine.state.clockHost, routine.executor?.type, routine.state.clockStarts)} data-testid="routine-clock-host">
                  <code className="routine-check-run">{describeClockHost(routine.state)}</code>
                  {waiting && <span className="routine-check-status pending" data-testid="routine-clock-wait"> · {waiting}</span>}
                </dd>
              </>
            )}
            {lastRun && (
              <>
                <dt>Last run</dt>
                <dd>{lastRun}</dd>
              </>
            )}
          </dl>
          {/* A run that did not happen (2026-11-08: the org reflection's day was lost unseen). */}
          {missed.length > 0 && (
            <div className="routine-missed" data-testid="routine-missed">
              {missed.map((m) => (
                <div key={m.slotMs} className="routine-missed-row" data-testid="routine-missed-row" data-slot={m.slotMs}>
                  <span className="routine-missed-text">{describeMissed(m)}</span>
                  <span className="routine-missed-actions">
                    {onCatchUp && (
                      <button type="button" className="btn btn-sm routine-missed-run" data-testid="routine-missed-run"
                        disabled={missedBusy !== null} onClick={() => actOnMissed(m.slotMs, onCatchUp)}>
                        {missedBusy === m.slotMs ? 'Running…' : 'Run it now'}
                      </button>
                    )}
                    {onDismissMissed && (
                      <button type="button" className="btn btn-sm routine-missed-dismiss" data-testid="routine-missed-dismiss"
                        disabled={missedBusy !== null} onClick={() => actOnMissed(m.slotMs, onDismissMissed)}>
                        Dismiss
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {missedError && <div className="routine-row-error cron-job-error" data-testid="routine-missed-error">{missedError}</div>}
            </div>
          )}
          {error && (
            <div className={error.past ? 'routine-row-note' : 'routine-row-error cron-job-error'}>
              {error.text}
              {error.next && <span className="routine-row-error-next">{error.next}</span>}
            </div>
          )}

          {prompt && (
            <div className="routine-fold">
              <button type="button" className="routine-fold-toggle" aria-expanded={showPrompt} onClick={() => setShowPrompt((v) => !v)}>
                <span>{routine.check ? 'What it sends when it fires' : 'What it sends when it runs'}</span>
                <Chevron open={showPrompt} />
              </button>
              {showPrompt && <pre className="trigger-audit-injected">{prompt}</pre>}
            </div>
          )}
          {runs.length > 0 ? (
            <div className="routine-fold">
              <button type="button" className="routine-fold-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)} data-testid="routine-history-toggle">
                <span>History ({runs.length} {runs.length === 1 ? 'run' : 'runs'})</span>
                <Chevron open={showHistory} />
              </button>
              {showHistory && (
                <ul className="routine-history-list trigger-audit-list" data-testid="routine-history-list">
                  {runs.map((e) => (
                    <li key={`${e.atMs}-${e.status}`} className="routine-history-row" data-status={e.status} data-failed={runEntryFailed(e) ? 'true' : 'false'}>
                      {nameTaskIn(describeRunEntry(e), routine)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : history.length > 0 && (
            <div className="routine-fold">
              <button type="button" className="routine-fold-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)} data-testid="routine-history-toggle">
                <span>History ({history.length} recorded {history.length === 1 ? (routine.check ? 'check' : 'run') : (routine.check ? 'checks' : 'runs')})</span>
                <Chevron open={showHistory} />
              </button>
              {showHistory && (
                <ul className="trigger-audit-list">
                  {collapseRepeats(history, (e) => `${e.outcome}|${e.delivery?.status ?? ''}|${describeAuditEntry(e)}`).map(({ item: entry, count }, i) => (
                    <AuditRow key={`${entry.atMs}-${entry.outcome}-${entry.seq ?? i}`} entry={entry} check={routine.check} repeat={count} onOpenSession={(sid) => openSessionOnHome(sid, navigate)} nameTask={(t) => historyWords(t, routine)} />
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="routine-actions">
            {confirmDelete ? (
              <>
                <span className="routine-confirm-text cron-confirm-text">Delete this routine?</span>
                <button type="button" className="btn btn-sm cron-confirm-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button type="button" className="btn btn-sm routine-danger cron-confirm-delete" onClick={() => { setConfirmDelete(false); onDelete(routine.id); }}>Delete</button>
              </>
            ) : (
              <>
                {canRunNow && (
                  <button type="button" className="btn btn-sm" disabled={running} onClick={() => void runNow()}>
                    {running ? 'Starting…' : routine.check ? 'Run check now' : 'Run now'}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => onEdit(routine)}>Edit</button>
                {owner && (
                  <button type="button" className="btn btn-sm" onClick={() => openTaskOnHome(owner.taskId, navigate)}>Open task</button>
                )}
                <button type="button" className="btn btn-sm routine-delete" onClick={() => setConfirmDelete(true)}>Delete</button>
              </>
            )}
          </div>
          {outcome && (
            <div className={`routine-run-outcome ${outcome.ok ? 'ok' : 'error'}`} role="status" data-testid="routine-run-outcome">
              {outcome.ok || settled ? outcome.text : refusedWords(outcome.text, routine)}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The row and fold mark: one drawn shape, the same size pointing right or down. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`routine-row-chevron${open ? ' open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A Run now the server refused, in the words the row already uses: when the reason is
 * the error shown above (its task is complete), the row points at it instead of
 * repeating the daemon's sentence.
 */
function refusedWords(text: string, routine: Routine): string {
  if (/target task .* is complete/i.test(text)) return 'It did not run: the reason is above.';
  return `Did not run: ${historyWords(text, routine)}`;
}
