/**
 * "Moved from <task>" / "Moved to <task>": the two ends of a transfer, as the
 * same task pill chat uses (`a.task-link`). Shown in the task details and as
 * one quiet line at the top of a session panel's body (never in its header).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { fetchTask } from '@/api/tasks';
import { useTaskLabel } from '@/hooks/useEntityLabels';
import '@/styles/transfer.css';

/** Titles of tasks the board list does not carry (a completed source), read once per page. */
const fetched = new Map<string, Promise<string | null>>();

function useTaskTitle(taskId: string): string | null {
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

export function TaskRefLink({ taskId, onOpen }: { taskId: string; onOpen?: (taskId: string) => void }) {
  const navigate = useNavigate();
  const title = useTaskTitle(taskId);
  return (
    <a
      href={`/tasks/${taskId}`}
      className="task-link"
      data-task-id={taskId}
      title={title ?? taskId}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onOpen) onOpen(taskId);
        else navigate(`/tasks/${taskId}`);
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
export function TransferLinks({ task, onOpenTask, className, testId }: {
  task: TransferFields | null | undefined;
  onOpenTask?: (taskId: string) => void;
  className?: string;
  testId?: string;
}) {
  if (!task || !hasTransferLinks(task)) return null;
  return (
    <div className={`xfer-links${className ? ` ${className}` : ''}`} data-testid={testId ?? 'transfer-links'}>
      {task.transferred_from && (
        <span className="xfer-link-item" data-link="from">
          <span>Moved from</span>
          <TaskRefLink taskId={task.transferred_from} onOpen={onOpenTask} />
        </span>
      )}
      {task.transferred_to && (
        <span className="xfer-link-item" data-link="to">
          <span>Moved to</span>
          <TaskRefLink taskId={task.transferred_to} onOpen={onOpenTask} />
        </span>
      )}
    </div>
  );
}
