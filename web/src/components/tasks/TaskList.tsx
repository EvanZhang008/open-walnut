import { useState, useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { TaskCard } from './TaskCard';
import { EmptyState } from '../common/EmptyState';

interface TaskListProps {
  tasks: Task[];
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onAdd?: () => void;
}

export function TaskList({ tasks, onComplete, onStar, onAdd }: TaskListProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const map = new Map<string, { direct: Task[]; projects: Map<string, Task[]> }>();
    for (const task of tasks) {
      const cat = task.category || 'Uncategorized';
      const hasDistinctProject = task.project && task.project !== task.category;
      if (!map.has(cat)) map.set(cat, { direct: [], projects: new Map() });
      const entry = map.get(cat)!;
      if (hasDistinctProject) {
        const proj = task.project!;
        if (!entry.projects.has(proj)) entry.projects.set(proj, []);
        entry.projects.get(proj)!.push(task);
      } else {
        entry.direct.push(task);
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, { direct, projects: projMap }]) => ({
        category: cat,
        directTasks: direct,
        projects: Array.from(projMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([proj, tasks]) => ({ project: proj, tasks })),
      }));
  }, [tasks]);

  if (tasks.length === 0) {
    return <EmptyState message="No tasks found" actionLabel={onAdd ? 'Add Task' : undefined} onAction={onAdd} />;
  }

  const toggleCategory = (key: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="task-list">
      {grouped.map(({ category, directTasks, projects }) => (
        <div key={category} className="task-group">
          <button className="task-group-header" onClick={() => toggleCategory(category)}>
            <span className="task-group-arrow">{collapsedCategories.has(category) ? '\u25B6' : '\u25BC'}</span>
            <span className="task-group-name">{category}</span>
            <span className="task-group-count text-muted text-xs">
              {directTasks.length + projects.reduce((sum, p) => sum + p.tasks.length, 0)}
            </span>
          </button>
          {!collapsedCategories.has(category) && (
            <>
              {/* Tasks without a distinct project — directly under category */}
              {directTasks.length > 0 && (
                <div className="task-subgroup-items">
                  {directTasks.map((task) => (
                    <TaskCard key={task.id} task={task} onComplete={onComplete} onStar={onStar} />
                  ))}
                </div>
              )}
              {/* Tasks with distinct projects — collapsible sub-groups */}
              {projects.map(({ project, tasks: projTasks }) => {
                const projKey = `${category}/${project}`;
                return (
                  <div key={projKey} className="task-subgroup">
                    <button className="task-subgroup-header" onClick={() => toggleProject(projKey)}>
                      <span className="task-group-arrow">{collapsedProjects.has(projKey) ? '\u25B6' : '\u25BC'}</span>
                      <span className="task-subgroup-name">{project}</span>
                      <span className="task-group-count text-muted text-xs">{projTasks.length}</span>
                    </button>
                    {!collapsedProjects.has(projKey) && (
                      <div className="task-subgroup-items">
                        {projTasks.map((task) => (
                          <TaskCard key={task.id} task={task} onComplete={onComplete} onStar={onStar} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
