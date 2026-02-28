import { useMemo, type CSSProperties } from 'react';
import type { Task } from '@walnut/core';

interface CategoryDetailPaneProps {
  category: string;
  tasks: Task[];
  onClose: () => void;
  onShowProject?: (category: string, project: string) => void;
  style?: CSSProperties;
}

export function CategoryDetailPane({ category, tasks, onClose, onShowProject, style }: CategoryDetailPaneProps) {
  // Compute project list with counts from props
  const { projects, totalCounts, source } = useMemo(() => {
    const projMap = new Map<string, { todo: number; active: number; done: number }>();
    let detectedSource = 'local';
    for (const t of tasks) {
      if (t.category !== category) continue;
      if (t.source) detectedSource = t.source;
      const proj = t.project || category;
      if (!projMap.has(proj)) projMap.set(proj, { todo: 0, active: 0, done: 0 });
      const entry = projMap.get(proj)!;
      if (t.phase === 'TODO') entry.todo++;
      else if (t.phase === 'COMPLETE') entry.done++;
      else entry.active++;
    }
    const total = { todo: 0, active: 0, done: 0 };
    const list = [...projMap.entries()].map(([name, counts]) => {
      total.todo += counts.todo;
      total.active += counts.active;
      total.done += counts.done;
      return { name, counts, total: counts.todo + counts.active + counts.done };
    });
    // Sort by total tasks descending
    list.sort((a, b) => b.total - a.total);
    return { projects: list, totalCounts: total, source: detectedSource };
  }, [tasks, category]);

  return (
    <div className="todo-detail-pane category-detail-pane" style={style}>
      <div className="todo-detail-header">
        <span className="todo-detail-category">{category}</span>
        <span className={`detail-source-badge source-${source}`}>{source}</span>
        <button className="todo-detail-close" onClick={onClose} title="Close">&times;</button>
      </div>

      {/* Projects list */}
      <div className="detail-section">
        <div className="detail-section-title">Projects ({projects.length})</div>
        <div className="detail-project-list">
          {projects.map(({ name, total }) => (
            <button
              key={name}
              className="detail-project-row"
              onClick={() => onShowProject?.(category, name)}
              title="View project details"
            >
              <span className="detail-project-name">{name}</span>
              <span className="detail-project-count">{total}</span>
            </button>
          ))}
          {projects.length === 0 && (
            <span className="text-muted text-sm">No projects</span>
          )}
        </div>
      </div>

      {/* Total statistics */}
      <div className="detail-section">
        <div className="detail-section-title">Total Tasks</div>
        <div className="detail-stat-grid">
          <div className="detail-stat-item">
            <span className="detail-stat-number">{totalCounts.todo}</span>
            <span className="detail-stat-label">Todo</span>
          </div>
          <div className="detail-stat-item">
            <span className="detail-stat-number">{totalCounts.active}</span>
            <span className="detail-stat-label">Active</span>
          </div>
          <div className="detail-stat-item">
            <span className="detail-stat-number">{totalCounts.done}</span>
            <span className="detail-stat-label">Done</span>
          </div>
        </div>
      </div>
    </div>
  );
}
