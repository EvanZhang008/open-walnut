import type { Task } from '@walnut/core';

interface TaskContextBarProps {
  task: Task;
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onClear: () => void;
}

export function TaskContextBar({ task, onClear }: TaskContextBarProps) {
  return (
    <div className="task-context-bar">
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
