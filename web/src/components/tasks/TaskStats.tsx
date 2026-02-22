interface TaskStatsProps {
  total: number;
  todo: number;
  done: number;
}

export function TaskStats({ total, todo, done }: TaskStatsProps) {
  return (
    <div className="task-stats">
      <div className="task-stat">
        <span className="task-stat-value">{total}</span>
        <span className="task-stat-label">Total</span>
      </div>
      <div className="task-stat">
        <span className="task-stat-value text-muted">{todo}</span>
        <span className="task-stat-label">Todo</span>
      </div>
      <div className="task-stat">
        <span className="task-stat-value" style={{ color: 'var(--success)' }}>{done}</span>
        <span className="task-stat-label">Done</span>
      </div>
    </div>
  );
}
