import type { Task } from '@walnut/core';
import { StatusBadge } from '../common/StatusBadge';

interface TaskContextBarProps {
  task: Task;
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onClear: () => void;
}

export function TaskContextBar({ task, onClear }: TaskContextBarProps) {
  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
  return (
    <div className={`task-context-bar${needsAttention ? ' task-context-bar-attention' : ''}`}>
      <StatusBadge status={task.status} phase={task.phase} />
      <span className="task-context-bar-title">{task.title}</span>
      <button
        className="task-context-bar-action task-context-bar-close"
        onClick={onClear}
        title="Clear focus"
      >
        &times;
      </button>
    </div>
  );
}
