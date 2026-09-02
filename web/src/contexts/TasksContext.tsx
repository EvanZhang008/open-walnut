import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useTasks, type CreateHooks, type FolderMeta } from '@/hooks/useTasks';
import type { Task } from '@open-walnut/core';
import type { BatchTaskOutcome, CreateTaskInput, UpdateTaskInput } from '@/api/tasks';
import { syncTasks as syncEntityLabels } from '@/stores/entity-label-store';

/** The shape exposed by TasksContext — mirrors useTasks() return. */
export interface TasksContextValue {
  tasks: Task[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  operationError: string | null;
  clearOperationError: () => void;
  showOperationError: (msg: string) => void;
  refetch: () => void;
  create: (input: CreateTaskInput, hooks?: CreateHooks) => Promise<Task>;
  update: (id: string, updates: UpdateTaskInput) => void;
  toggleComplete: (id: string) => void;
  setPhase: (id: string, phase: string) => void;
  /** Reorder within ONE project group. `project: ''` = Inbox. */
  reorder: (project: string, taskIds: string[]) => void;
  /** Move a task to another project ('' = Inbox), optionally next to a sibling. */
  moveTask: (taskId: string, project: string, insertNearTaskId?: string) => void;
  reparentTask: (taskId: string, newParentId: string | null, opts?: { insertAfterId?: string }) => void;
  deleteTask: (id: string) => void;
  /** Multi-select batch ops — one round-trip; resolve with the per-task `failed` list. */
  batchSetPhase: (ids: string[], phase: string) => Promise<BatchTaskOutcome[]>;
  batchDelete: (ids: string[], opts?: { force?: boolean }) => Promise<BatchTaskOutcome[]>;
  bakeOrder: (orderedIds: string[]) => void;
  /** Local-only batch patch (no API call) — for optimistic flows (Focus Bar pin/tier). */
  patchTasksLocal: (patches: Record<string, Partial<Task>>) => void;
  /** Suppress the next WS echo for a key (e.g. `update:<id>`) — pair with own API call. */
  guardEcho: (key: string) => void;
  taskGroups: Record<string, string>;
  hiddenGroups: Set<string>;
  folderMeta: Record<string, FolderMeta>;
  groupTasks: (taskIds: string[], label?: string) => void;
  addToGroup: (groupId: string, taskIds: string[]) => void;
  ungroupTasks: (taskIds: string[]) => void;
  renameGroup: (groupId: string, label: string) => void;
  setGroupHidden: (groupId: string, hidden: boolean) => void;
  createFolder: (label: string, project: string, parentId?: string) => void;
  deleteFolder: (groupId: string) => void;
  setFolderParent: (groupId: string, parentId: string | null) => void;
  /** Move a folder to another project ('' = Inbox): subfolders + members come
   *  along. Resolves true only when the server accepted the move. */
  moveFolderToProject: (groupId: string, project: string) => Promise<boolean>;
}

const TasksContext = createContext<TasksContextValue | null>(null);

/** Provider that wraps useTasks() into a shared context — one fetch for all consumers. */
export function TasksProvider({ children }: { children: ReactNode }) {
  const t = useTasks();

  // Feed the entity-label store (task-ref pill titles). Every mutation path
  // (REST refetch, WS events, optimistic edits) funnels into t.tasks, so this
  // one effect covers them all. The loading guard matters: the pre-fetch []
  // would otherwise wipe the registry on boot.
  useEffect(() => {
    if (!t.loading) syncEntityLabels(t.tasks);
  }, [t.tasks, t.loading]);

  // Stabilize context value: useMemo prevents new object identity on every render.
  // useTasks callbacks are already stable (useCallback), so only data fields trigger
  // updates. EVERY data field must be listed — folderMeta was missing, so a folder's
  // project/parent change (create, re-parent, move to another project) reached the
  // context only when some OTHER field happened to change in the same render.
  const value = useMemo<TasksContextValue>(() => t,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t's callbacks are stable via useCallback
    [t.tasks, t.taskGroups, t.hiddenGroups, t.folderMeta, t.loading, t.refreshing, t.error, t.operationError]);

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

/**
 * Consume shared tasks from TasksContext.
 * Must be used within a TasksProvider (AppShell wraps the entire app).
 */
export function useTasksContext(): TasksContextValue {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error('useTasksContext must be used within a TasksProvider');
  return ctx;
}

/**
 * Same store, but null outside a TasksProvider (pop-out windows mount none).
 *
 * The rule this enables: inside one browser the task store is the ONLY truth
 * for a task row. A surface that shows a task reads it from here and writes
 * through the store's optimistic mutators, so every other surface (board row,
 * session header, detail pane) changes in the same frame. The REST round-trip
 * and its WS echo only confirm. A component may keep a private REST copy only
 * as the fallback for when this returns null or the row is not in the list.
 */
export function useTasksContextSafe(): TasksContextValue | null {
  return useContext(TasksContext);
}

/** The store's row for `taskId`, or null when there is no store or no row. */
export function useStoreTask(taskId: string | null | undefined): Task | null {
  const tasks = useContext(TasksContext)?.tasks;
  return useMemo(
    () => (taskId && tasks ? tasks.find((t) => t.id === taskId) ?? null : null),
    [tasks, taskId],
  );
}
