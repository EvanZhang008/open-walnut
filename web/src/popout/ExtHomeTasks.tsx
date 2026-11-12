/**
 * Home's task panel on the extension's first page (ExtHome loads this file lazily, so the composer
 * paints first): TodoPanel itself, on Home's task store and Focus bar, with the same tabs (All,
 * Focus, Satellite, the projects, More), search, Needs you rows and status, as on a desktop
 * however narrow the panel (PopoutExtPanel `markNotAPhone`). The tab picked is Home's own view memory (`usePageView('home',
 * ...)`): the panel and Home show the same tab.
 *
 * What it does not do here: open Home's detail pane or session columns. A row opens in the frame
 * (`onOpen`): a task's conversation, or its detail for one with none yet.
 */
import { useCallback, useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { TodoPanel } from '@/components/tasks/TodoPanel';
import { useTasksContext } from '@/contexts/TasksContext';
import { useUndoableTaskActions } from '@/undo/TaskUndoContext';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useCommittedRef } from '@/hooks/useCommittedRef';
import { useFavorites } from '@/hooks/useFavorites';
import { useOrdering } from '@/hooks/useOrdering';
import { resolveTaskSessionId, taskOfSession } from '@/utils/session-status';

/** How a row opens in the frame: its conversation (by its session), or its detail. */
export type OpenTask = (task: Task, how: { sessionId: string } | 'detail') => void;

export default function ExtHomeTasks({ onOpen }: { onOpen: OpenTask }) {
  const { tasks, loading, create, update, reorder, moveTask, reparentTask, bakeOrder, showOperationError, taskGroups, hiddenGroups, folderMeta } = useTasksContext();
  // Completes and phase changes take one Undo, as on Home (TaskUndoContext; the store's own when none).
  const { toggleComplete, setPhase } = useUndoableTaskActions();
  const focusBar = useFocusBarContext();
  const favorites = useFavorites();
  const ordering = useOrdering();
  const pinnedTaskIds = useMemo(() => new Set(focusBar.pinnedIds), [focusBar.pinnedIds]);
  const focusTaskIds = useMemo(() => new Set(focusBar.focusIds), [focusBar.focusIds]);
  const customTierIds = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const [tid, ids] of Object.entries(focusBar.customTierIds)) map[tid] = new Set(ids);
    return map;
  }, [focusBar.customTierIds]);
  const onCreate = useCallback((input: { title: string; priority: string; project?: string }) => create({ title: input.title, priority: input.priority, project: input.project }), [create]);
  // A row's click (TodoPanel handleTaskClick, the search rows through it): a task with a session
  // opens its conversation (onOpenSession, then a focus with `openDetail: false`, left alone here).
  const tasksRef = useCommittedRef(tasks);
  const onOpenSession = useCallback((sessionId: string) => {
    const task = taskOfSession(tasksRef.current, sessionId);
    if (task) onOpen(task, { sessionId });
  }, [onOpen]);
  // A row's click with no conversation to open, and the row's detail button: its detail here (on a
  // desktop a click only focuses the row, and the panel has no side detail to show it in).
  const onFocusTask = useCallback((task: Task, opts?: { openDetail?: boolean }) => {
    if (!opts || opts.openDetail || !resolveTaskSessionId(task)) onOpen(task, 'detail');
  }, [onOpen]);
  return (
    <TodoPanel
      tasks={tasks}
      loading={loading}
      onComplete={toggleComplete}
      onSetPhase={setPhase}
      onCreate={onCreate}
      onUpdate={update}
      onFocusTask={onFocusTask}
      onOpenSession={onOpenSession}
      favorites={favorites}
      ordering={ordering}
      onReorder={reorder}
      onMoveTask={moveTask}
      onReparentTask={reparentTask}
      onBakeOrder={bakeOrder}
      taskGroups={taskGroups}
      hiddenGroups={hiddenGroups}
      folderMeta={folderMeta}
      onPinTask={focusBar.pin}
      onUnpinTask={focusBar.unpin}
      onReorderPinned={focusBar.reorder}
      onSetTier={focusBar.setTier}
      pinnedTaskIds={pinnedTaskIds}
      focusTaskIds={focusTaskIds}
      customTiers={focusBar.customTiers}
      customTiersLoaded={focusBar.customTiersLoaded}
      customTierIds={customTierIds}
      suppressDetail
      tabBarAlways
      onOperationError={showOperationError}
    />
  );
}
