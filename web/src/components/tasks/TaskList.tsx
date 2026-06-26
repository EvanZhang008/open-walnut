import { useState, useMemo, useCallback } from 'react';
import type { Task } from '@open-walnut/core';
import { TaskCard, type CardGroupInfo } from './TaskCard';
import { EmptyState } from '../common/EmptyState';
import { usePrompt } from '@/hooks/useConfirm';

interface TaskListProps {
  tasks: Task[];
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onDelete?: (id: string) => void;
  onAdd?: () => void;
  /** group_id → label registry (for the chip text). */
  taskGroups?: Record<string, string>;
  /** Create a virtual group from a multi-selection. */
  onGroupTasks?: (taskIds: string[], label?: string) => void;
  /** Remove a single task from its group. */
  onUngroupTask?: (taskId: string) => void;
  /** Rename a whole group. */
  onRenameGroup?: (groupId: string, label: string) => void;
}

/** Order tasks so members of the same group sit contiguously after their lead
 *  (the first member in the input order). Ungrouped tasks keep their position. */
function clusterByGroup(tasks: Task[]): Task[] {
  const leadIndex = new Map<string, number>(); // group_id → index of its first member
  tasks.forEach((t, i) => {
    if (t.group_id && !leadIndex.has(t.group_id)) leadIndex.set(t.group_id, i);
  });
  // Stable sort: ungrouped keep their own index as the sort key; grouped members
  // borrow their lead's index (so the whole cluster floats to the lead position),
  // with the original index as a tiebreaker to preserve intra-group order.
  return tasks
    .map((t, i) => ({ t, i, key: t.group_id ? leadIndex.get(t.group_id)! : i }))
    .sort((a, b) => (a.key - b.key) || (a.i - b.i))
    .map((x) => x.t);
}

export function TaskList({
  tasks,
  onComplete,
  onStar,
  onDelete,
  onAdd,
  taskGroups,
  onGroupTasks,
  onUngroupTask,
  onRenameGroup,
}: TaskListProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const prompt = usePrompt();
  // ── Multi-select for group building ── (Cmd/Ctrl/Shift-click a card to toggle.)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
        directTasks: clusterByGroup(direct),
        projects: Array.from(projMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([proj, projTasks]) => ({ project: proj, tasks: clusterByGroup(projTasks) })),
      }));
  }, [tasks]);

  // taskId → render metadata. Count members per group from the displayed set so a
  // group needs ≥2 *visible*, contiguous members to box (a lone survivor gets no rail).
  const groupRenderMap = useMemo(() => {
    const map = new Map<string, CardGroupInfo>();
    const lanes: Task[][] = [];
    for (const g of grouped) {
      if (g.directTasks.length) lanes.push(g.directTasks);
      for (const p of g.projects) lanes.push(p.tasks);
    }
    for (const lane of lanes) {
      const counts = new Map<string, number>();
      for (const t of lane) if (t.group_id) counts.set(t.group_id, (counts.get(t.group_id) ?? 0) + 1);
      const firstSeen = new Set<string>();
      const lastIdx = new Map<string, number>();
      lane.forEach((t, i) => { if (t.group_id && (counts.get(t.group_id) ?? 0) >= 2) lastIdx.set(t.group_id, i); });
      lane.forEach((t, i) => {
        const gid = t.group_id;
        if (!gid || (counts.get(gid) ?? 0) < 2) return;
        const isLead = !firstSeen.has(gid);
        if (isLead) firstSeen.add(gid);
        map.set(t.id, { groupId: gid, label: taskGroups?.[gid] ?? '', isLead, isLast: lastIdx.get(gid) === i });
      });
    }
    return map;
  }, [grouped, taskGroups]);

  const onSelectToggle = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  }, []);

  // Resolve selection → tasks + validate same category+project (the hard scope rule).
  const selectionInfo = useMemo(() => {
    const picked = tasks.filter((t) => selectedIds.has(t.id));
    if (picked.length < 2) return { tasks: picked, sameScope: false };
    const { category, project } = picked[0];
    const sameScope = picked.every((t) => t.category === category && t.project === project);
    return { tasks: picked, sameScope };
  }, [tasks, selectedIds]);

  const handleGroupSelected = useCallback(() => {
    if (!onGroupTasks || selectionInfo.tasks.length < 2 || !selectionInfo.sameScope) return;
    onGroupTasks(selectionInfo.tasks.map((t) => t.id));
    setSelectedIds(new Set());
  }, [onGroupTasks, selectionInfo]);

  const handleRenameGroup = useCallback(async (groupId: string, currentLabel: string) => {
    if (!onRenameGroup) return;
    const next = await prompt({ title: 'Rename group', defaultValue: currentLabel, confirmLabel: 'Rename' });
    if (next === null) return; // cancelled or left empty
    const trimmed = next.trim();
    if (!trimmed) return;
    onRenameGroup(groupId, trimmed);
  }, [onRenameGroup, prompt]);

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

  const renderCard = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      onComplete={onComplete}
      onStar={onStar}
      onDelete={onDelete}
      groupInfo={groupRenderMap.get(task.id)}
      isSelected={selectedIds.has(task.id)}
      onSelectToggle={onGroupTasks ? onSelectToggle : undefined}
      onRenameGroup={handleRenameGroup}
      onUngroup={onUngroupTask}
    />
  );

  return (
    <div className="task-list">
      {grouped.map(({ category, directTasks, projects }) => (
        <div key={category} className="task-group">
          <button className="task-group-header" onClick={() => toggleCategory(category)}>
            <span className="task-group-arrow">{collapsedCategories.has(category) ? '▶' : '▼'}</span>
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
                  {directTasks.map(renderCard)}
                </div>
              )}
              {/* Tasks with distinct projects — collapsible sub-groups */}
              {projects.map(({ project, tasks: projTasks }) => {
                const projKey = `${category}/${project}`;
                return (
                  <div key={projKey} className="task-subgroup">
                    <button className="task-subgroup-header" onClick={() => toggleProject(projKey)}>
                      <span className="task-group-arrow">{collapsedProjects.has(projKey) ? '▶' : '▼'}</span>
                      <span className="task-subgroup-name">{project}</span>
                      <span className="task-group-count text-muted text-xs">{projTasks.length}</span>
                    </button>
                    {!collapsedProjects.has(projKey) && (
                      <div className="task-subgroup-items">
                        {projTasks.map(renderCard)}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      ))}

      {/* Floating action bar — appears once ≥2 tasks are multi-selected.
          "Group" is enabled only when they share one category+project (the scope rule). */}
      {onGroupTasks && selectionInfo.tasks.length >= 2 && (
        <div className="task-selection-bar">
          <span className="task-selection-count">{selectionInfo.tasks.length} selected</span>
          <button
            className="task-selection-group-btn"
            disabled={!selectionInfo.sameScope}
            title={selectionInfo.sameScope ? 'Group these tasks together' : 'Tasks must be in the same category and project to group'}
            onClick={handleGroupSelected}
          >
            ⑂ Group
          </button>
          <button className="task-selection-clear-btn" onClick={() => setSelectedIds(new Set())}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
