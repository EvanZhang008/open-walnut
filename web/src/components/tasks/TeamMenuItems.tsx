import { useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { AdoptWorkerFlyout } from './AdoptWorkerFlyout';
import { resolveParent } from './adopt-candidates';

const NO_INDEX: ReadonlyMap<string, Task> = new Map();

/**
 * The task kebab's team rows: "Adopt a worker…" on every task (a portalled
 * picker, AdoptWorkerFlyout), and "Leave leader “X”" on a worker. Both write
 * through the store's `reparentTask`, so the Worker and Leader pills follow at
 * once. Rendered only inside a TasksProvider (a pop-out window has none).
 *
 * The picker hangs off its own row and the menu stays open under it, like the
 * Project picker; the menu's outside-click closer exempts `.adopt-worker-flyout`.
 */
export function TeamMenuItems({ task, afterAction }: {
  task: Pick<Task, 'id' | 'title' | 'parent_task_id'>;
  /** Close the host menu. */
  afterAction: () => void;
}) {
  const store = useTasksContextSafe();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (!store) return null;
  const leader = task.parent_task_id ? resolveParent(store.tasks, NO_INDEX, task.parent_task_id) : null;
  return (
    <>
      <div className="task-kebab-divider" />
      <button
        ref={btnRef}
        type="button"
        className={`task-kebab-item${open ? ' task-kebab-item-active' : ''}`}
        data-testid="kebab-adopt-worker"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <span className="task-kebab-icon" aria-hidden="true">+</span>
        <span>Adopt a worker…</span>
      </button>
      {task.parent_task_id && (
        <button
          type="button"
          className="task-kebab-item"
          data-testid="kebab-leave-leader"
          onClick={(e) => {
            e.stopPropagation();
            log.info('tasks', 'worker left its leader', { workerTaskId: task.id, leaderTaskId: leader?.id ?? task.parent_task_id ?? '' });
            store.reparentTask(task.id, null);
            afterAction();
          }}
        >
          <span className="task-kebab-icon" aria-hidden="true">↰</span>
          <span>Leave leader &ldquo;{leader?.title ?? 'its leader'}&rdquo;</span>
        </button>
      )}
      <AdoptWorkerFlyout
        open={open}
        anchorRef={btnRef}
        leader={task}
        onClose={() => setOpen(false)}
        onPicked={afterAction}
      />
    </>
  );
}
