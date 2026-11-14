/**
 * "Moved from <task>" / "Moved to <task>": the two ends of a transfer, as the
 * same task pill chat uses (`a.task-link`). Shown in the task details and as
 * one quiet line at the top of a session panel's body (never in its header).
 */
import { useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { fetchTask } from '@/api/tasks';
import { useTaskLabel } from '@/hooks/useEntityLabels';
import '@/styles/transfer.css';
import { taskPath } from '@/utils/task-path';
import { useOpenTask } from '@/hooks/useOpenTask';

/** Titles of tasks the board list does not carry (a completed source), read once per page. */
const fetched = new Map<string, Promise<string | null>>();

/** A task's live title: the label store's, else read once from the server. */
export function useTaskTitle(taskId: string): string | null {
  const label = useTaskLabel(taskId);
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (label?.title) return;
    let cancelled = false;
    let p = fetched.get(taskId);
    if (!p) {
      p = fetchTask(taskId).then((t) => t.title || null).catch(() => null);
      fetched.set(taskId, p);
    }
    void p.then((t) => { if (!cancelled) setTitle(t); });
    return () => { cancelled = true; };
  }, [taskId, label?.title]);
  return label?.title ?? title;
}

export function TaskRefLink({ taskId }: { taskId: string }) {
  const openTask = useOpenTask();
  const title = useTaskTitle(taskId);
  return (
    <a
      href={taskPath(taskId)}
      className="task-link"
      data-task-id={taskId}
      title={title ?? taskId}
      onClick={(e) => {
        // A modifier click keeps the browser's own open of the href in a new view.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { e.stopPropagation(); return; }
        e.preventDefault();
        e.stopPropagation();
        openTask(taskId);
      }}
    >
      {title ?? 'Loading…'}
    </a>
  );
}

type TransferFields = Pick<Task, 'transferred_from' | 'transferred_to'>;

export function hasTransferLinks(task: TransferFields | null | undefined): boolean {
  return !!task && (!!task.transferred_from || !!task.transferred_to);
}

/** Both ends of a transfer, each a clickable task pill. Nothing when the task has neither. */
export function TransferLinks({ task, className, testId }: {
  task: TransferFields | null | undefined;
  className?: string;
  testId?: string;
}) {
  if (!task || !hasTransferLinks(task)) return null;
  return (
    <div className={`xfer-links${className ? ` ${className}` : ''}`} data-testid={testId ?? 'transfer-links'}>
      {task.transferred_from && (
        <span className="xfer-link-item" data-link="from">
          <span>Moved from</span>
          <TaskRefLink taskId={task.transferred_from} />
        </span>
      )}
      {task.transferred_to && (
        <span className="xfer-link-item" data-link="to">
          <span>Moved to</span>
          <TaskRefLink taskId={task.transferred_to} />
        </span>
      )}
    </div>
  );
}
