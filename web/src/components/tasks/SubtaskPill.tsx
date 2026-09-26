import type { KeyboardEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { locateTaskOnHome } from '@/utils/open-session';
import { resolveTaskSessionId } from '@/utils/session-status';
import '@/styles/subtask-pill.css';

/**
 * "Sub" pill: this task is a subtask (it has a parent_task_id), and the pill
 * leads back to the parent.
 *
 * Work a session files is that session's subtask wherever it lands (see
 * caller-placement.ts): beside it, in another project, or from a Personal AI
 * conversation. The main list indents a subtask under its parent only inside
 * one project; everywhere else (the pinned tiers show every task as a flat
 * card, a subtask in another project is a top-level row there) the pill is the
 * only sign. Clicking it is the same locate a chat task reference does: the
 * parent is selected and scrolled to, its session opens (an ask in the chat
 * slot), and the page goes home when it is not there already.
 */
export function subtaskPillTitle(parentTitle: string | undefined): string {
  return parentTitle
    ? `Subtask of "${parentTitle}". Click to go to that task.`
    : 'Subtask of another task. Click to go to it.';
}

export function SubtaskPill({ task, className }: { task: { parent_task_id?: string }; className?: string }) {
  const navigate = useNavigate();
  const store = useTasksContextSafe();
  const parentId = task.parent_task_id;
  if (!parentId) return null;
  // parent_task_id may be a short prefix (legacy data): the store's rule everywhere.
  const parent = store?.tasks.find((t) => t.id.startsWith(parentId)) ?? null;
  const open = (e: MouseEvent | KeyboardEvent) => {
    // The pill sits inside a clickable, draggable row: this click is the pill's alone.
    e.stopPropagation();
    e.preventDefault();
    const sid = parent ? resolveTaskSessionId(parent) : null;
    locateTaskOnHome(parent?.id ?? parentId, navigate, sid ? { sessionId: sid } : undefined);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`task-team-pill todo-item-subtask-pill${className ? ` ${className}` : ''}`}
      title={subtaskPillTitle(parent?.title)}
      data-testid="subtask-pill"
      data-parent-task-id={parent?.id ?? parentId}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(e); }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      Sub
    </span>
  );
}
