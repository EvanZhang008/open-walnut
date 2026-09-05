/**
 * One control with two states: "Make a task", and then the task itself.
 *
 * The pill carries the same MARKUP the rest of Walnut uses (`a.task-link` + `data-task-id`, labelled
 * from the shared entity-label store), for a reason worth stating: a second pill invented here would
 * drift in wording, in colour and in what a click does, and the whole point of showing a task in the
 * mail reader is that it is a Walnut task rather than a mail-shaped copy of one. The chip's LOOK is
 * restated in mail.css, because the shared rules are scoped to `.markdown-body a.task-link` and this
 * reader is not a markdown container.
 *
 * Why it REPLACES the button instead of sitting beside it: the reader has to show the state, not
 * offer the action twice. A second press cannot make a second task (the server answers the same id),
 * but a button that stays put after it worked invites exactly that press and then looks broken.
 *
 * The click is handled here rather than by the shared delegation hook, because there is no markdown
 * container in the reader to delegate from: one anchor, one handler, and `href` kept honest so the
 * middle click and the context menu still do the right thing.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTaskLabel } from '@/hooks/useEntityLabels';
import { lookupTaskLabel } from '@/stores/entity-label-store';
import { makeTaskFromMessage } from './mail-task-actions';
import type { MailOpenMessage } from './mail-store';

export function MailTaskButton({ open }: { open: MailOpenMessage }) {
  const taskId = open.message?.taskId;
  if (taskId) return <MailTaskPill taskId={taskId} />;
  return (
    <div className="mail-task-slot">
      <button
        type="button"
        className="mail-compose-btn"
        data-testid="mail-make-task"
        disabled={open.taskBusy || !open.message}
        title="Make a Walnut task from this message"
        onClick={() => { void makeTaskFromMessage(open.accountId, open.messageId); }}
      >
        {open.taskBusy ? 'Making…' : 'Make a task'}
      </button>
      {open.taskError && (
        <span className="mail-task-error" data-testid="mail-task-error">{open.taskError}</span>
      )}
    </div>
  );
}

function MailTaskPill({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const label = useTaskLabel(taskId);
  /*
   * Make the title arrive, for a task that is seconds old.
   *
   * `useTaskLabel` reads the label store without OBSERVING the id, and the store deliberately stays
   * quiet for ids nothing has claimed to be rendering, so without this call the raw id would sit
   * here until something unrelated re-rendered the reader. `lookupTaskLabel` is the observing half.
   *
   * Nothing has to refetch the task list any more: `walnut.tasks.create` now emits `task:created`
   * like every other create path, so the row this pill names reaches this window on its own.
   *
   * In an effect rather than in render: the lookup mutates the store's observed set, and a store
   * write during render is a render-phase update.
   */
  useEffect(() => { lookupTaskLabel(taskId); }, [taskId]);
  return (
    <a
      className="task-link mail-task-pill"
      data-testid="mail-task-pill"
      data-task-id={taskId}
      href={`/tasks/${taskId}`}
      title={label?.project ? `${label.project} / ${label.title}` : taskId}
      onClick={(event) => {
        // A plain left click navigates inside the SPA; anything with a modifier is the human asking
        // for a new tab, and the href is already right for that.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(`/tasks/${taskId}`);
      }}
    >
      {label?.title ?? taskId}
    </a>
  );
}
