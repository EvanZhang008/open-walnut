/**
 * The Brief's "still open" footer (OrgBrief.tsx): what the program finds open in the team, read
 * from the tasks and the request ledger, never from the letter (briefStillOpen in
 * src/core/user-status.ts). Open work the letter does not name, every not-done list of a Partial
 * result, overdue requests, work past or near its due date, and work on the user or its lead for
 * more than a few hours.
 */
import { USER_STATE_LABELS, type BriefStillOpen, type UserState } from '@open-walnut/user-status';
import type { Task } from '@open-walnut/core';

interface Props {
  open: BriefStillOpen<Task>;
  tasks: readonly Task[];
  states: ReadonlyMap<string, UserState>;
  now: number;
  onOpenTask: (id: string) => void;
}

function span(ms: number): string {
  const h = Math.max(1, Math.round(ms / 3_600_000));
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/** "in 5 hours", "now" for a time ahead. */
function timeAgoish(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 60_000) return 'now';
  return `in ${span(ms)}`;
}

export function BriefStillOpenList({ open, tasks, states, now, onOpenTask }: Props) {
  const { unmentioned, moreUnmentioned, partial, overdue, waitingLong, due, promises } = open;
  if (!unmentioned.length && !partial.length && !overdue.length && !waitingLong.length && !due.length && !promises.length) return null;
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const chip = (t: Task | undefined, fallback?: string) => t
    ? (
      <button type="button" className="org-brief-move" data-task-id={t.id} data-user-state={states.get(t.id)} onClick={() => onOpenTask(t.id)}>
        {t.title}
      </button>
    )
    : <span className="org-muted">{fallback ?? 'a task'}</span>;
  return (
    <div className="org-brief-open" data-testid="org-brief-still-open">
      <div className="org-brief-open-head">Still open <span className="org-muted">(from the tasks, not the letter)</span></div>
      {partial.map(({ task, notDone }) => (
        <div key={`p-${task.id}`} className="org-brief-open-row" data-kind="partial" data-task-id={task.id}>
          <span className="org-brief-partial">Partial</span>{chip(task)}
          <span className="org-brief-open-why">not done: {notDone.join('; ')}</span>
        </div>
      ))}
      {overdue.map((r) => (
        <div key={`o-${r.id}`} className="org-brief-open-row" data-kind="overdue">
          <span className="org-brief-overdue">Overdue</span>
          {chip(r.fromTaskId ? byId.get(r.fromTaskId) : undefined, 'a session')}
          <span className="org-muted">asked</span>
          {chip(r.toTaskId ? byId.get(r.toTaskId) : undefined)}
          <span className="org-brief-open-why" title={r.preview}>"{r.preview}"</span>
        </div>
      ))}
      {due.map(({ task, at, state }) => (
        <div key={`d-${task.id}`} className="org-brief-open-row" data-kind={`due-${state}`} data-task-id={task.id}>
          <span className={state === 'overdue' ? 'org-brief-overdue' : 'org-brief-partial'}>{state === 'overdue' ? 'Past due' : 'Due soon'}</span>
          {chip(task)}
          <span className="org-brief-open-why">due {at}</span>
        </div>
      ))}
      {promises.map(({ task, at, words }) => (
        <div key={`f-${task.id}`} className="org-brief-open-row" data-kind="follow-up" data-task-id={task.id}>
          <span className="org-brief-partial">Follow-up</span>
          {chip(task)}
          <span className="org-brief-open-why" title={words}>"{words}", checks back {timeAgoish(Date.parse(at) - now)}</span>
        </div>
      ))}
      {waitingLong.map(({ task, on, since }) => (
        <div key={`w-${task.id}`} className="org-brief-open-row" data-kind="waiting-long" data-task-id={task.id}>
          {chip(task)}
          <span className="org-brief-open-why">on {on === 'you' ? 'you' : 'its lead'} for {span(now - since)}</span>
        </div>
      ))}
      {unmentioned.length > 0 && (
        <div className="org-brief-open-row" data-kind="unmentioned">
          <span className="org-muted">Not in the letter:</span>
          {unmentioned.map((t) => (
            <span key={t.id} className="org-brief-open-item">
              {chip(t)} <span className="org-muted">{(USER_STATE_LABELS[states.get(t.id) ?? 'waiting']).toLowerCase()}</span>
            </span>
          ))}
          {moreUnmentioned > 0 && <span className="org-muted">and {moreUnmentioned} more</span>}
        </div>
      )}
    </div>
  );
}
