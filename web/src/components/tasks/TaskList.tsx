import { useState, useMemo, useCallback } from 'react';
import type { Task } from '@open-walnut/core';
import { TaskCard, type CardGroupInfo } from './TaskCard';
import { EmptyState } from '../common/EmptyState';
import { useConfirm, usePrompt } from '@/hooks/useConfirm';
import type { BatchTaskOutcome } from '@/api/tasks';

interface TaskListProps {
  tasks: Task[];
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Multi-select batch ops — one round-trip for the whole selection. Without these
   *  the selection bar can only group, which is what made multi-select look broken. */
  onBatchSetPhase?: (ids: string[], phase: string) => Promise<BatchTaskOutcome[]>;
  onBatchDelete?: (ids: string[], opts?: { force?: boolean }) => Promise<BatchTaskOutcome[]>;
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
  onBatchSetPhase,
  onBatchDelete,
  onAdd,
  taskGroups,
  onGroupTasks,
  onUngroupTask,
  onRenameGroup,
}: TaskListProps) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const prompt = usePrompt();
  const confirm = useConfirm();
  // ── Multi-select for group building ── (Cmd/Ctrl/Shift-click a card to toggle.)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Project is the single grouping layer: one flat lane per project, '' = Inbox (last).
  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const proj = task.project || '';
      if (!map.has(proj)) map.set(proj, []);
      map.get(proj)!.push(task);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([project, projTasks]) => ({ project, tasks: clusterByGroup(projTasks) }));
  }, [tasks]);

  // taskId → render metadata. Count members per group from the displayed set so a
  // group needs ≥2 *visible*, contiguous members to box (a lone survivor gets no rail).
  const groupRenderMap = useMemo(() => {
    const map = new Map<string, CardGroupInfo>();
    const lanes: Task[][] = grouped.filter((g) => g.tasks.length).map((g) => g.tasks);
    for (const lane of lanes) {
      const counts = new Map<string, number>();
      for (const t of lane) if (t.group_id) counts.set(t.group_id, (counts.get(t.group_id) ?? 0) + 1);
      const firstSeen = new Set<string>();
      const lastIdx = new Map<string, number>();
      lane.forEach((t, i) => { if (t.group_id && (counts.get(t.group_id) ?? 0) >= 1) lastIdx.set(t.group_id, i); });
      lane.forEach((t, i) => {
        const gid = t.group_id;
        if (!gid || (counts.get(gid) ?? 0) < 1) return;
        const isLead = !firstSeen.has(gid);
        if (isLead) firstSeen.add(gid);
        map.set(t.id, { groupId: gid, label: taskGroups?.[gid] ?? '', isLead, isLast: lastIdx.get(gid) === i });
      });
    }
    return map;
  }, [grouped, taskGroups]);

  const childStats = useMemo(() => {
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const stats = new Map<string, { done: number; total: number }>();
    for (const child of tasks) {
      if (!child.parent_task_id) continue;
      const parent = taskById.get(child.parent_task_id)
        ?? tasks.find((candidate) => candidate.id.startsWith(child.parent_task_id!));
      if (!parent) continue;
      const current = stats.get(parent.id) ?? { done: 0, total: 0 };
      current.total++;
      if (child.status === 'done' || child.phase === 'COMPLETE') current.done++;
      stats.set(parent.id, current);
    }
    return stats;
  }, [tasks]);

  const onSelectToggle = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  }, []);

  // Resolve selection → tasks. Grouping has NO scope rule — any ≥2 tasks can be
  // grouped regardless of project (a group is a pure visual cluster).
  const selectionInfo = useMemo(() => {
    const picked = tasks.filter((t) => selectedIds.has(t.id));
    const doneCount = picked.filter((t) => t.status === 'done' || t.phase === 'COMPLETE').length;
    return { tasks: picked, canGroup: picked.length >= 2, doneCount };
  }, [tasks, selectedIds]);

  const handleGroupSelected = useCallback(() => {
    if (!onGroupTasks || selectionInfo.tasks.length < 2) return;
    onGroupTasks(selectionInfo.tasks.map((t) => t.id));
    setSelectedIds(new Set());
  }, [onGroupTasks, selectionInfo]);

  // Batch complete / delete for this surface. One round-trip via the batch props;
  // falls back to a per-task fan-out for a consumer that only wired the singles.
  const handleCompleteSelected = useCallback(() => {
    const ids = selectionInfo.tasks.map((t) => t.id);
    if (ids.length === 0) return;
    setSelectedIds(new Set());
    if (onBatchSetPhase) { void onBatchSetPhase(ids, 'COMPLETE'); return; }
    ids.forEach((id) => onComplete(id));
  }, [selectionInfo, onBatchSetPhase, onComplete]);

  const handleDeleteSelected = useCallback(async () => {
    const picked = selectionInfo.tasks;
    if (picked.length === 0) return;
    const ok = await confirm({
      title: picked.length === 1 ? `Delete “${picked[0].title}”?` : `Delete ${picked.length} tasks?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const ids = picked.map((t) => t.id);
    setSelectedIds(new Set());
    if (onBatchDelete) { void onBatchDelete(ids); return; }
    ids.forEach((id) => onDelete?.(id));
  }, [selectionInfo, confirm, onBatchDelete, onDelete]);

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
      childStats={childStats.get(task.id)}
      groupInfo={groupRenderMap.get(task.id)}
      isSelected={selectedIds.has(task.id)}
      onSelectToggle={onGroupTasks ? onSelectToggle : undefined}
      onRenameGroup={handleRenameGroup}
      onUngroup={onUngroupTask}
    />
  );

  return (
    <div className="task-list">
      {grouped.map(({ project, tasks: projTasks }) => (
        <div key={project || '__inbox__'} className="task-group">
          <button className="task-group-header" onClick={() => toggleProject(project)}>
            <span className="task-group-arrow">{collapsedProjects.has(project) ? '▶' : '▼'}</span>
            <span className="task-group-name">{project || 'Inbox'}</span>
            <span className="task-group-count text-muted text-xs">{projTasks.length}</span>
          </button>
          {!collapsedProjects.has(project) && (
            <div className="task-subgroup-items">
              {projTasks.map(renderCard)}
            </div>
          )}
        </div>
      ))}

      {/* Floating action bar — appears once ≥2 tasks are multi-selected. Carries the
          whole batch verb set (Complete / Delete / Group), not just Group: a bar that
          could only group is exactly why multi-select read as broken here. */}
      {onGroupTasks && selectionInfo.tasks.length >= 2 && (
        <div className="task-selection-bar">
          <span className="task-selection-count">{selectionInfo.tasks.length} selected</span>
          {/* Hidden when everything picked is already done — nothing left to complete. */}
          {selectionInfo.doneCount < selectionInfo.tasks.length && (
            <button
              className="task-selection-action-btn"
              title="Mark the selected tasks complete"
              onClick={handleCompleteSelected}
            >
              ✓ Complete
            </button>
          )}
          <button
            className="task-selection-group-btn"
            disabled={!selectionInfo.canGroup}
            title={selectionInfo.canGroup ? 'Group these tasks together' : 'Select at least 2 tasks'}
            onClick={handleGroupSelected}
          >
            ⑂ Group
          </button>
          {(onBatchDelete || onDelete) && (
            <button
              className="task-selection-action-btn task-selection-action-danger"
              title="Delete the selected tasks"
              onClick={handleDeleteSelected}
            >
              Delete
            </button>
          )}
          <button className="task-selection-clear-btn" onClick={() => setSelectedIds(new Set())}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
