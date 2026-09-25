import '@/styles/subtask-pill.css';

/**
 * "Sub" pill: this task is a subtask (it has a parent_task_id). The main list
 * already indents a subtask under its parent, but the pinned tiers show every
 * task as a flat card, and that is where work an agent split off from its own
 * task lands (caller-placement.ts makes it a subtask of the caller). Without the
 * pill a delegated piece of work looked like an unrelated top-level task.
 */
export const SUBTASK_PILL_TITLE = 'Subtask: part of another task. Its parent shows how many subtasks it has.';

export function SubtaskPill({ task, className }: { task: { parent_task_id?: string }; className?: string }) {
  if (!task.parent_task_id) return null;
  return (
    <span
      className={`todo-item-due-pill todo-item-subtask-pill${className ? ` ${className}` : ''}`}
      title={SUBTASK_PILL_TITLE}
      data-testid="subtask-pill"
      data-parent-task-id={task.parent_task_id}
    >
      Sub
    </span>
  );
}
