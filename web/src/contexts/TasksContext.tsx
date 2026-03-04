import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTasks } from '@/hooks/useTasks';
import type { Task } from '@walnut/core';
import type { CreateTaskInput, UpdateTaskInput } from '@/api/tasks';

/** The shape exposed by TasksContext — mirrors useTasks() return. */
export interface TasksContextValue {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  operationError: string | null;
  clearOperationError: () => void;
  showOperationError: (msg: string) => void;
  refetch: () => void;
  create: (input: CreateTaskInput) => Promise<Task>;
  update: (id: string, updates: UpdateTaskInput) => Promise<Task>;
  toggleComplete: (id: string) => Promise<Task>;
  setPhase: (id: string, phase: string) => Promise<Task>;
  star: (id: string) => Promise<Task>;
  reorder: (category: string, project: string, taskIds: string[]) => void;
  moveTask: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
}

const TasksContext = createContext<TasksContextValue | null>(null);

/** Provider that wraps useTasks() into a shared context — one fetch for all consumers. */
export function TasksProvider({ children }: { children: ReactNode }) {
  const t = useTasks();

  // Stabilize context value: useMemo prevents new object identity on every render.
  // useTasks callbacks are already stable (useCallback), so only data fields trigger updates.
  const value = useMemo<TasksContextValue>(() => t,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t's callbacks are stable via useCallback
    [t.tasks, t.loading, t.error, t.operationError]);

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
