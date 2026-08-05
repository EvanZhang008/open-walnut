/**
 * CalendarTaskList — the left rail of unscheduled tasks (no own start_date),
 * each row a dnd-kit draggable that can be dropped onto any calendar surface.
 * Deliberately slim (NOT a TodoPanel embed — that component owns its own
 * DndContexts and nesting them invites sensor conflicts).
 */
import { memo, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task } from '@open-walnut/core';
import { PriorityBadge } from '@/components/common/PriorityBadge';

const DONE_PHASES = new Set(['COMPLETE', 'CANCELLED']);

interface Props {
  tasks: Task[];
}

export const TaskListChip = memo(function TaskListChip({
  task,
  overlay,
}: {
  task: Task;
  overlay?: boolean;
}) {
  return (
    <div className={`cal-rail-chip${overlay ? ' cal-rail-chip-overlay' : ''}`}>
      <PriorityBadge priority={task.priority} />
      <span className="cal-rail-chip-title">{task.title}</span>
    </div>
  );
});

const RailRow = memo(function RailRow({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `cal-task:${task.id}`,
    data: { task },
  });
  return (
    <div
      ref={setNodeRef}
      className={`cal-rail-row${isDragging ? ' dragging' : ''}`}
      data-task-id={task.id}
      {...listeners}
      {...attributes}
    >
      <TaskListChip task={task} />
    </div>
  );
});

export const CalendarTaskList = memo(function CalendarTaskList({ tasks }: Props) {
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const unscheduled = tasks.filter(
      (t) => !DONE_PHASES.has(t.phase) && !t.start_date && (!q || t.title.toLowerCase().includes(q))
    );
    // Group by project. Inbox is the ABSENCE of a project, so its bucket key is
    // '' (the same sentinel the rest of the app uses) and the "Inbox" label is
    // applied only at render — keying on the literal 'Inbox' would silently merge
    // a real project of that name into the no-project bucket. '' sorts last.
    const byProject = new Map<string, Task[]>();
    for (const t of unscheduled) {
      const key = t.project || '';
      const list = byProject.get(key);
      if (list) list.push(t);
      else byProject.set(key, [t]);
    }
    return [...byProject.entries()].sort((a, b) =>
      a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0]));
  }, [tasks, filter]);

  return (
    <div className="cal-rail" data-testid="cal-rail">
      <div className="cal-rail-header">
        <span className="cal-rail-title">Unscheduled</span>
        <input
          className="cal-rail-search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="cal-rail-scroll">
        {groups.length === 0 && <div className="cal-rail-empty">No unscheduled tasks</div>}
        {groups.map(([project, list]) => (
          // Prefixed key: '' is a legal-but-ambiguous React key, and the prefix
          // also keeps a project literally named 'inbox' distinct from the bucket.
          <div key={`p:${project}`} className="cal-rail-group">
            <div className="cal-rail-group-label">{project || 'Inbox'}</div>
            {list.map((t) => (
              <RailRow key={t.id} task={t} />
            ))}
          </div>
        ))}
      </div>
      <div className="cal-rail-hint">Drag a task onto the calendar to schedule it</div>
    </div>
  );
});
