import type { Task, TaskStatus, TaskPhase } from '@open-walnut/core';
import { PHASE_LABELS, taskStatusLabel } from '@/utils/session-status';
import { TaskStateIcon } from './TaskStateIcon';
import { phaseIconState, taskIconState } from '@/utils/task-icon-state';

interface StatusBadgeProps {
  status: TaskStatus;
  phase?: TaskPhase;
  /** The task itself, when the caller holds it: the badge then reads its user status
   *  (taskStatusLabel), not its phase. */
  task?: Pick<Task, 'phase' | 'status' | 'user_status'> | null;
}

const statusLabels: Record<string, string> = {
  todo: 'Todo',
  done: 'Done',
};

export function StatusBadge({ status, phase, task }: StatusBadgeProps) {
  if (phase) {
    return (
      <span className={`badge badge-phase-${phase.toLowerCase()}`}>
        <TaskStateIcon state={task ? taskIconState(task) : phaseIconState(phase)} decorative /> {task ? taskStatusLabel(task) : (PHASE_LABELS[phase] ?? phase)}
      </span>
    );
  }
  return (
    <span className={`badge badge-${status}`}>
      <TaskStateIcon state={status === 'done' ? 'done' : 'todo'} decorative /> {statusLabels[status] ?? status}
    </span>
  );
}
