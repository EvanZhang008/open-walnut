/**
 * A thread's task chips: each task its live status dot and title, one click opens it. The card's
 * own chips and a Known card's "Waiting on" line (ThreadKnown.tsx) draw the same chip.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { TaskStateIcon } from '@/components/common/TaskStateIcon';
import { taskIconState } from '@/utils/task-icon-state';
import { useOpenTask } from '@/hooks/useOpenTask';

/** One task: its dot (when the task is loaded) and its title, or the `fallback` title, else its id. */
export function TaskChip({ id, task, fallback }: { id: string; task: Task | undefined; fallback?: string }) {
  const openTask = useOpenTask();
  // Its live status (TaskStateIcon's dot), when the task is loaded.
  const state = task ? taskIconState(task) : null;
  const title = task?.title ?? fallback ?? id;
  return (
    <button type="button" className="org-thread-task" data-testid="org-thread-task" data-task-id={id} onClick={() => openTask(id)} title={title}>
      {state && <TaskStateIcon state={state} size={12} decorative />}
      <span>{title}</span>
    </button>
  );
}

export function TaskChips({ ids, tasks }: { ids: readonly string[]; tasks: readonly Task[] }) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  return (
    <div className="org-thread-tasks" data-testid="org-thread-tasks">
      {ids.map((id) => <TaskChip key={id} id={id} task={byId.get(id)} />)}
    </div>
  );
}
