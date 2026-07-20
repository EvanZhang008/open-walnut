import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTasks, type CreateHooks } from '@/hooks/useTasks';
import type { Task } from '@open-walnut/core';
import type { CreateTaskInput, UpdateTaskInput } from '@/api/tasks';

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
  star: (id: string) => void;
  reorder: (category: string, project: string, taskIds: string[]) => void;
  moveTask: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
  reparentTask: (taskId: string, newParentId: string | null, opts?: { insertAfterId?: string }) => void;
  deleteTask: (id: string) => void;
  bakeOrder: (orderedIds: string[]) => void;
  /** Local-only batch patch (no API call) — for optimistic flows (Focus Bar pin/tier). */
  patchTasksLocal: (patches: Record<string, Partial<Task>>) => void;
  /** Suppress the next WS echo for a key (e.g. `update:<id>`) — pair with own API call. */
  guardEcho: (key: string) => void;
  taskGroups: Record<string, string>;
  hiddenGroups: Set<string>;
  groupTasks: (taskIds: string[], label?: string) => void;
  addToGroup: (groupId: string, taskIds: string[]) => void;
  ungroupTasks: (taskIds: string[]) => void;
  renameGroup: (groupId: string, label: string) => void;
  setGroupHidden: (groupId: string, hidden: boolean) => void;
}

const TasksContext = createContext<TasksContextValue | null>(null);

/** Provider that wraps useTasks() into a shared context — one fetch for all consumers. */
export function TasksProvider({ children }: { children: ReactNode }) {
  const t = useTasks();

  // Stabilize context value: useMemo prevents new object identity on every render.
  // useTasks callbacks are already stable (useCallback), so only data fields trigger updates.
  const value = useMemo<TasksContextValue>(() => t,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t's callbacks are stable via useCallback
    [t.tasks, t.taskGroups, t.hiddenGroups, t.loading, t.refreshing, t.error, t.operationError]);

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
