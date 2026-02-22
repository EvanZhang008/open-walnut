import type { Task } from '@walnut/core';
import { useNavigate } from 'react-router-dom';
import { PriorityBadge } from '../common/PriorityBadge';
import { StatusBadge } from '../common/StatusBadge';

interface TaskContextBarProps {
  task: Task;
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onClear: () => void;
}

export function TaskContextBar({ task, onComplete, onStar, onClear }: TaskContextBarProps) {
  const navigate = useNavigate();

  const subtasksDone = task.subtasks?.filter((s) => s.done).length ?? 0;
  const subtasksTotal = task.subtasks?.length ?? 0;

  return (
    <div className="task-context-bar">
      <div className="task-context-bar-main">
        <span className="task-context-bar-title">{task.title}</span>
        <StatusBadge status={task.status} />
        <PriorityBadge priority={task.priority} />
        {task.category && (
          <span className="text-xs text-muted">{task.category}{task.project && task.project !== task.category ? ` / ${task.project}` : ''}</span>
        )}
        {subtasksTotal > 0 && (
          <span className="text-xs text-muted">{subtasksDone}/{subtasksTotal} subtasks</span>
        )}
      </div>
      <div className="task-context-bar-actions">
        <button
          className="task-context-bar-action"
          onClick={() => onComplete(task.id)}
          title="Complete task"
        >
          &#x2713;
        </button>
        <button
          className="task-context-bar-action"
          onClick={() => onStar(task.id)}
          title={task.starred ? 'Unstar' : 'Star'}
          style={task.starred ? { color: 'var(--warning)' } : undefined}
        >
          &#x2605;
        </button>
        <button
          className="task-context-bar-action task-context-bar-link"
          onClick={() => navigate(`/tasks/${task.id}`)}
          title="View details"
        >
          View details &rarr;
        </button>
        <button
          className="task-context-bar-action task-context-bar-close"
          onClick={onClear}
          title="Clear focus"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
