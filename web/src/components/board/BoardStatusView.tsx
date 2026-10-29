/**
 * The Board's Status view, its default (2026-10-25, the user's pick "C" of three designs):
 * a brief in plain words that names what needs the user and counts the rest, the four
 * state chips that filter, and one table of the team: status, task, where it stands, next
 * and who, when. Every word comes from the one user status (src/core/user-status.ts), which
 * the server keeps on each task, so the numbers here are the Org page's, the task list's
 * and the phone's. Nothing here is written by the lead by hand.
 *
 * A row opens its task the way a chip does (the session panel's peek); a choice that needs
 * the user opens the Page at it. Narrow panes stack each row (board-status.css).
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { USER_STATE_LABELS, USER_STATES, dueAtMs, resultIsPartial, type UserState } from '@open-walnut/user-status';
import { CEO_LABEL, VP_LABEL, orgDisplayTitle } from '@open-walnut/org-tree';
import { RECENT_COMPLETED_DAYS } from '@/api/tasks';
import { formatWaitUntil } from '@/components/tasks/TaskStatusControl';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { apiPost } from '@/api/client';
import { LiveActivityLine } from './LiveActivityLine';
import { useLiveActivity } from '@/stores/live-activity-store';
import {
  briefCountsLine, buildStatusBoard, filteredRows, rowTime, statusBrief, waitingLine,
  type StatusFilter, type StatusRow,
} from './board-status-model';
import '@/styles/board-overview.css';
import '@/styles/board-status.css';

export interface BoardStatusViewProps {
  ownerId: string;
  ownerTitle: string;
  tasks: readonly Task[];
  /** The task store has not answered yet. */
  loading: boolean;
  onOpenTask: (taskId: string) => void;
  /** Show the Page (a choice that needs the user is answered there). */
  onOpenPage?: () => void;
  /** Under a team of one (the owner alone): what the user can do next (ask its leader for a page). */
  soloExtra?: ReactNode;
}

const ago = (ms: number): string => (ms ? timeAgo(new Date(ms).toISOString()) : '');

const EMPTY_TEXT: Record<StatusFilter, string> = {
  open: 'No open tasks on this team.',
  needs: 'Nothing needs you right now.',
  working: 'Nothing is working right now.',
  waiting: 'Nothing is waiting right now.',
  done: `Nothing was done in the last ${RECENT_COMPLETED_DAYS} days.`,
};

function StatusPill({ row }: { row: StatusRow }) {
  const { state, kind } = row.status;
  if (state === 'waiting' && kind === 'stuck') {
    return <span className="bs-pill bs-pill-stuck" data-state="stuck">Stuck</span>;
  }
  const main = <span className={`bs-pill bs-pill-${state}`} data-state={state}><span className="bs-dot" />{USER_STATE_LABELS[state]}</span>;
  // Its latest result left things not done (structured-reply.ts): "Done" alone would overstate it.
  if (!resultIsPartial(row.task.result_report)) return main;
  return <>{main}<span className="bs-pill bs-pill-partial" data-testid="board-partial-pill">Partial</span></>;
}

function WhereCell({ row }: { row: StatusRow }) {
  const s = row.status;
  const live = useLiveActivity(s.state === 'working' ? row.task.id : undefined);
  return (
    <>
      {s.state === 'waiting' && <span className={`bs-on${s.kind === 'stuck' ? ' bs-on-stuck' : ''}`}>{waitingLine(s, formatWaitUntil)}</span>}
      {s.state === 'working' && <LiveActivityLine taskId={row.task.id} />}
      {s.now && <span className="bs-now">{s.now}</span>}
      {!s.now && !live && s.state === 'working' && <span className="bs-muted">Running a turn now.</span>}
      {s.due && (
        <span className={`bs-due bs-due-${s.due.state}`} data-testid="board-due" data-due={s.due.state}>
          {s.due.state === 'overdue' ? `Overdue: was due ${formatDue(s.due.at)}` : `Due ${formatDue(s.due.at)}`}
        </span>
      )}
      {resultIsPartial(row.task.result_report) && (
        <span className="bs-partial" data-testid="board-partial">Not done: {row.task.result_report!.not_done!.join('; ')}</span>
      )}
      {s.stale && <span className="bs-stale" title="Its session has not written an update for a day or more">No update in {compactDays(s.at)}</span>}
    </>
  );
}

/** "today 6 PM", "Oct 30", for a due date (a bare date or a time). */
function formatDue(at: string): string {
  const ms = dueAtMs(at);
  if (!Number.isFinite(ms)) return at;
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(at.trim());
  if (sameDay) return bare ? 'today' : `today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + (bare ? '' : ` ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
}

function compactDays(at: string | undefined): string {
  const ms = at ? Date.now() - Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return 'a while';
  const days = Math.max(1, Math.floor(ms / 86_400_000));
  return days === 1 ? '1 day' : `${days} days`;
}

function NextCell({ row, onOpenPage }: { row: StatusRow; onOpenPage?: () => void }) {
  const s = row.status;
  if (s.state === 'needs') {
    return (
      <>
        <span className="bs-you"><b>You:</b> {s.ask}</span>
        {s.source === 'choice' && onOpenPage && (
          <button type="button" className="bs-act" onClick={(e) => { e.stopPropagation(); onOpenPage(); }} data-testid="board-status-answer">Answer on the Page</button>
        )}
      </>
    );
  }
  return (
    <>
      {s.next && <span>{s.next}</span>}
      {s.until && s.kind !== 'time' && <span className="bs-muted">Checks again {formatWaitUntil(s.until)}</span>}
    </>
  );
}

/** The board owner's word: the org's own names on Main and a project's lead, else "Lead". */
const ownerWord = (t: Pick<Task, 'org_role'> | undefined) => (t?.org_role === 'main' ? CEO_LABEL : t?.org_role === 'lead' ? VP_LABEL : 'Lead');

const Row = memo(function Row({ row, onOpenTask, onOpenPage }: { row: StatusRow; onOpenTask: (id: string) => void; onOpenPage?: () => void }) {
  const t = row.task;
  const title = orgDisplayTitle(t);
  const when = ago(rowTime(row));
  return (
    <tr
      className={`bs-row bs-row-${row.status.state}${row.status.kind === 'stuck' ? ' bs-row-stuck' : ''}`}
      data-testid="board-status-row"
      data-task-id={t.id}
      data-state={row.status.state}
      tabIndex={0}
      role="button"
      aria-label={`${title}: ${USER_STATE_LABELS[row.status.state]}. Open the task`}
      onClick={() => onOpenTask(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenTask(t.id); } }}
    >
      <td className="bs-c-status"><StatusPill row={row} /></td>
      <td className="bs-c-task">
        <span className="bs-title">{title}</span>
        {row.depth === 0 && <span className="bs-sub">{ownerWord(t)}</span>}
        {row.under && <span className="bs-sub">Under {row.under}</span>}
      </td>
      <td className="bs-c-where"><WhereCell row={row} /></td>
      <td className="bs-c-next"><NextCell row={row} onOpenPage={onOpenPage} /></td>
      <td className="bs-c-when" title={when}>{when.replace(/ ago$/, '')}</td>
    </tr>
  );
});

/**
 * Stop the whole team in one step, or say it is stopped and offer the way back
 * (core/sessions/team-stop.ts; the task kebab's Team row has the same two actions).
 */
function TeamStopControl({ owner, ownerId, working }: { owner: Task | undefined; ownerId: string; working: number }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = owner?.team_stop;
  const run = (action: 'team-stop' | 'team-resume') => {
    setBusy(true);
    setError(null);
    setConfirming(false);
    log.info('board', action === 'team-stop' ? 'team stop requested' : 'team resume requested', { taskId: ownerId });
    // A stop waits on each host's confirmation: give it the time a few slow hosts take.
    apiPost(`/api/v1/tasks/${encodeURIComponent(ownerId)}/${action}`, {}, { timeoutMs: 120_000 })
      .then((out) => log.info('board', `${action} done`, { taskId: ownerId, result: out as Record<string, unknown> }))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('board', `${action} failed`, { taskId: ownerId, error: message });
        setError(`${action === 'team-stop' ? 'The team was not stopped' : 'The team was not resumed'}: ${message}`);
      })
      .finally(() => setBusy(false));
  };
  const failed = error ? <span className="bs-team-stop-error" role="alert" data-testid="board-team-error"> {error}</span> : null;
  if (stop) {
    return (
      <p className="bs-team-stop is-stopped" data-testid="board-team-stopped">
        <b>Team stopped</b> {timeAgo(stop.at)}{stop.by === 'human' ? '' : ' by an agent'}: its triggers and wake clocks are off; a task resumes on its next message.{' '}
        <button type="button" className="bs-link" disabled={busy} onClick={() => run('team-resume')} data-testid="board-team-resume">Resume the team</button>
        {failed}
      </p>
    );
  }
  return (
    <p className="bs-team-stop">
      {confirming ? (
        <>
          Stop this task and every open task under it{working > 0 ? `, ${working} working now` : ''}?{' '}
          <button type="button" className="bs-team-stop-btn is-danger" disabled={busy} onClick={() => run('team-stop')} data-testid="board-team-stop-confirm">Stop the team</button>{' '}
          <button type="button" className="bs-team-stop-btn" onClick={() => setConfirming(false)} data-testid="board-team-stop-cancel">Cancel</button>
        </>
      ) : (
        <button
          type="button"
          className="bs-team-stop-btn"
          disabled={busy}
          title="Stop this task and every open task under it: their sessions, triggers and wake clocks"
          onClick={() => setConfirming(true)}
          data-testid="board-team-stop"
        >
          ■ Stop the team{working > 0 ? ` (${working} working)` : ''}
        </button>
      )}
      {failed}
    </p>
  );
}

export function BoardStatusView({ ownerId, ownerTitle, tasks, loading, onOpenTask, onOpenPage, soloExtra }: BoardStatusViewProps) {
  const [filter, setFilter] = useState<StatusFilter>('open');
  // A minute clock is not needed: the server rewrites a status when it moves, and the
  // "updated" column is read again on every render the task list causes.
  const board = useMemo(() => buildStatusBoard({ ownerId, tasks, now: Date.now(), doneWindowDays: RECENT_COMPLETED_DAYS }), [ownerId, tasks]);
  const brief = statusBrief(board);
  const owner = useMemo(() => tasks.find((t) => t.id === ownerId), [tasks, ownerId]);
  const rows = filteredRows(board, filter);
  const open = board.counts.needs + board.counts.working + board.counts.waiting;
  // The owner alone, nothing below it open or recently done.
  const solo = open + board.counts.done <= 1;
  const pick = (f: StatusFilter) => {
    setFilter(f);
    log.info('board', 'status filter picked', { taskId: ownerId, filter: f });
  };

  if (loading && !tasks.length) return <div className="task-board-loading">Loading the board…</div>;

  return (
    <div className="board-status" data-testid="board-status">
      <div className="bs-head">
        <div className="bs-who">Board · {ownerWord(owner)}</div>
        <h2 className="bs-h">{owner ? orgDisplayTitle(owner) : ownerTitle}</h2>
        <p className="bs-brief" data-testid="board-status-brief">
          {brief.needs.length === 0 ? (
            <b className="bs-brief-none">Nothing needs you.</b>
          ) : (
            <>
              <b className="bs-brief-needs">{brief.needs.length} {brief.needs.length === 1 ? 'needs' : 'need'} you:</b>{' '}
              {brief.needs.map((n, i) => (
                <span key={n.id}>
                  {i > 0 && '; '}
                  <button type="button" className="bs-link" onClick={() => onOpenTask(n.id)}>{n.title}</button>
                  {n.ask && <> ({n.ask.replace(/\.$/, '')})</>}
                </span>
              ))}.
            </>
          )}
          <br />
          {briefCountsLine(brief)}
        </p>
        {!solo && <TeamStopControl owner={owner} ownerId={ownerId} working={board.counts.working} />}
        <div className="bs-filters" role="group" aria-label="Show">
          <button type="button" className={`bs-chip${filter === 'open' ? ' is-on' : ''}`} aria-pressed={filter === 'open'} onClick={() => pick('open')} data-testid="board-status-filter-open">
            All open <b>{open}</b>
          </button>
          {USER_STATES.map((s: UserState) => (
            <button
              key={s}
              type="button"
              className={`bs-chip bs-chip-${s}${filter === s ? ' is-on' : ''}`}
              aria-pressed={filter === s}
              onClick={() => pick(s)}
              data-testid={`board-status-filter-${s}`}
            >
              <span className="bs-dot" /><b>{board.counts[s]}</b> {USER_STATE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="bs-empty" data-testid="board-status-empty">
          {EMPTY_TEXT[filter]}
        </p>
      ) : (
        <table className="bs-table">
          <thead>
            <tr><th className="bs-c-status">Status</th><th>Task</th><th>Where it stands</th><th>Next · who</th><th className="bs-c-when">Updated</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => <Row key={r.task.id} row={r} onOpenTask={onOpenTask} onOpenPage={onOpenPage} />)}
          </tbody>
        </table>
      )}
      {solo && (
        <div className="bs-solo" data-testid="board-status-solo">
          <p className="bs-empty">No other tasks on this team yet. Subtasks show here as they start.</p>
          {soloExtra}
        </div>
      )}
      {filter === 'open' && board.counts.done > 0 && (
        <p className="bs-foot">
          <button type="button" className="bs-link" onClick={() => pick('done')}>Show the {board.counts.done} done in the last {RECENT_COMPLETED_DAYS} days</button>
        </p>
      )}
    </div>
  );
}
