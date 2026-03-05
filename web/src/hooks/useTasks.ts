import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '@walnut/core';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import * as tasksApi from '@/api/tasks';
import { perf } from '@/utils/perf-logger';

/**
 * Optimistic default status for a newly-linked session (before the first
 * session:status-changed event arrives). Avoids the brief "? / ?" flash.
 */
const OPTIMISTIC_STARTING_STATUS = { work_status: 'in_progress' as const, process_status: 'running' as const };

/**
 * Merge an incoming WS task update with the existing local task,
 * preserving enriched fields (plan_session_status, exec_session_status)
 * that only come from the REST API, not from bus events.
 *
 * If a session slot changed (different ID or cleared), the stale status is dropped.
 * If a brand-new session ID appears, an optimistic in_progress/running default is used
 * so the badge never shows "? / ?".
 */
function mergeTask(existing: Task, incoming: Task): Task {
  // Preserve enriched session_id: REST API backfills it from session records,
  // but WS events send the raw task where session_id may be unset.
  // Don't preserve when the task is completed — applyPhase('COMPLETE') explicitly
  // clears all session slots and we must honor that.
  const completed = incoming.phase === 'COMPLETE' || incoming.status === 'completed';
  const mergedSessionId = incoming.session_id ?? (completed ? undefined : existing.session_id);

  return {
    ...incoming,
    session_id: mergedSessionId,
    // Preserve enriched session status only if the slot ID is unchanged.
    // For a newly-linked session (different ID), use an optimistic default
    // so the badge doesn't flash "? / ?" while waiting for session:status-changed.
    session_status: incoming.session_status
      ?? (mergedSessionId && mergedSessionId === existing.session_id
        ? existing.session_status
        : mergedSessionId
          ? OPTIMISTIC_STARTING_STATUS
          : undefined),
    plan_session_status: incoming.plan_session_status
      ?? (incoming.plan_session_id && incoming.plan_session_id === existing.plan_session_id
        ? existing.plan_session_status
        : incoming.plan_session_id
          ? OPTIMISTIC_STARTING_STATUS
          : undefined),
    exec_session_status: incoming.exec_session_status
      ?? (incoming.exec_session_id && incoming.exec_session_id === existing.exec_session_id
        ? existing.exec_session_status
        : incoming.exec_session_id
          ? OPTIMISTIC_STARTING_STATUS
          : undefined),
    // Preserve session_work_statuses enrichment from REST API
    session_work_statuses: incoming.session_work_statuses ?? existing.session_work_statuses,
  };
}

/** Rearrange tasks within a category/project group to match the given ID order. */
function applyReorder(tasks: Task[], category: string, project: string, taskIds: string[]): Task[] {
  const idOrder = new Map(taskIds.map((id, i) => [id, i]));
  const result = [...tasks];
  const inGroup: Task[] = [];
  const slots: number[] = [];
  for (let i = 0; i < result.length; i++) {
    if (result[i].category === category && result[i].project === project) {
      inGroup.push(result[i]);
      slots.push(i);
    }
  }
  inGroup.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
  for (let i = 0; i < slots.length; i++) {
    result[slots[i]] = inGroup[i];
  }
  return result;
}


/** How long (ms) an operation error banner stays visible before auto-dismissing. */
const OPERATION_ERROR_TIMEOUT_MS = 6000;

interface UseTasksReturn {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  operationError: string | null;
  clearOperationError: () => void;
  showOperationError: (msg: string) => void;
  refetch: () => void;
  create: (input: tasksApi.CreateTaskInput) => Promise<Task>;
  update: (id: string, updates: tasksApi.UpdateTaskInput) => Promise<Task>;
  toggleComplete: (id: string) => Promise<Task>;
  setPhase: (id: string, phase: string) => Promise<Task>;
  star: (id: string) => Promise<Task>;
  reorder: (category: string, project: string, taskIds: string[]) => void;
  moveTask: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
}

export function useTasks(filter?: tasksApi.TaskFilter): UseTasksReturn {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showOperationError = useCallback((msg: string) => {
    setOperationError(msg);
    if (opErrorTimer.current) clearTimeout(opErrorTimer.current);
    opErrorTimer.current = setTimeout(() => setOperationError(null), OPERATION_ERROR_TIMEOUT_MS);
  }, []);

  const clearOperationError = useCallback(() => {
    setOperationError(null);
    if (opErrorTimer.current) clearTimeout(opErrorTimer.current);
  }, []);

  // Clean up timer on unmount
  useEffect(() => {
    return () => { if (opErrorTimer.current) clearTimeout(opErrorTimer.current); };
  }, []);

  // Suppress WS echoes of our own optimistic operations.
  // Keys: "reorder:<cat>/<proj>" for reorder echoes, "move:<taskId>" for update echoes.
  // Auto-expire after 5s as safety net.
  const echoGuard = useRef(new Set<string>());
  const guardEcho = useCallback((key: string) => {
    echoGuard.current.add(key);
    setTimeout(() => echoGuard.current.delete(key), 5000);
  }, []);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    const endPerf = perf.start('tasks:fetch');
    tasksApi.fetchTasks(filter)
      .then((tasks) => { endPerf(`${tasks.length} tasks`); setTasks(tasks); })
      .catch((e: Error) => { endPerf('error'); setError(e.message); })
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Track WS connection state — refetch tasks on reconnect (server restart, network blip)
  const isFirstConnect = useRef(true);
  const [wsConnected, setWsConnected] = useState(wsClient.state === 'connected');
  useEffect(() => {
    const onStateChange = (state: ConnectionState) => setWsConnected(state === 'connected');
    wsClient.onConnectionChange(onStateChange);
    return () => { wsClient.offConnectionChange(onStateChange); };
  }, []);
  useEffect(() => {
    if (wsConnected) {
      if (isFirstConnect.current) {
        isFirstConnect.current = false;
        return; // skip — initial fetch already handled above
      }
      refetch();
    }
  }, [wsConnected, refetch]);

  // Real-time event handlers — single source of truth for state changes
  // Server emits { task: <Task> } wrapper objects
  useEvent('task:created', (data) => {
    const { task } = data as { task: Task };
    // Skip tasks with missing or empty titles (e.g. from sync race conditions)
    if (!task.title || task.title.trim() === '') return;
    // Deduplicate: if task with same id already exists, skip
    setTasks((prev) => prev.some((t) => t.id === task.id) ? prev : [task, ...prev]);
  });

  useEvent('task:updated', (data) => {
    const { task } = data as { task?: Task };
    if (!task) { refetch(); return; }  // bulk change (e.g. category rename) — refetch all
    if (echoGuard.current.delete(`move:${task.id}`)) return;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? mergeTask(t, task) : t)));
  });

  useEvent('task:completed', (data) => {
    const { task } = data as { task?: Task };
    if (!task) { refetch(); return; }
    setTasks((prev) => prev.map((t) => (t.id === task.id ? mergeTask(t, task) : t)));
  });

  useEvent('task:starred', (data) => {
    const { task } = data as { task?: Task };
    if (!task) { refetch(); return; }
    setTasks((prev) => prev.map((t) => (t.id === task.id ? mergeTask(t, task) : t)));
  });

  useEvent('task:deleted', (data) => {
    const { id } = data as { id: string };
    setTasks((prev) => prev.filter((t) => t.id !== id));
  });

  useEvent('task:reordered', (data) => {
    const { category, project, taskIds } = data as { category: string; project: string; taskIds: string[] };
    if (echoGuard.current.delete(`reorder:${category}/${project}`)) return;
    setTasks((prev) => applyReorder(prev, category, project, taskIds));
  });

  // When a session's status changes, update the enriched session status on the affected task
  useEvent('session:status-changed', (data) => {
    const { sessionId, taskId, work_status, process_status, mode, activity, planCompleted } = data as {
      sessionId?: string; taskId?: string; work_status?: string; process_status?: string;
      mode?: string; activity?: string; planCompleted?: boolean;
    };
    if (!sessionId) return;
    setTasks((prev) => prev.map((t) => {
      const matchesSingle = t.session_id === sessionId;
      const matchesPlan = t.plan_session_id === sessionId;
      const matchesExec = t.exec_session_id === sessionId;
      if (!matchesSingle && !matchesPlan && !matchesExec) return t;
      const updated = { ...t };
      const statusInfo = {
        work_status: (work_status ?? 'agent_complete') as NonNullable<Task['plan_session_status']>['work_status'],
        process_status: (process_status ?? 'stopped') as NonNullable<Task['plan_session_status']>['process_status'],
        ...(activity ? { activity } : {}),
        ...(mode ? { mode: mode as NonNullable<Task['session_status']>['mode'] } : {}),
        ...(planCompleted ? { planCompleted: true } : {}),
      };
      if (matchesSingle) updated.session_status = { ...updated.session_status, ...statusInfo };
      if (matchesPlan) updated.plan_session_status = { ...updated.plan_session_status, ...statusInfo };
      if (matchesExec) updated.exec_session_status = { ...updated.exec_session_status, ...statusInfo };
      return updated;
    }));
  });

  const create = useCallback(async (input: tasksApi.CreateTaskInput) => {
    const task = await tasksApi.createTask(input);
    return task;
  }, []);

  const update = useCallback(async (id: string, updates: tasksApi.UpdateTaskInput) => {
    const task = await tasksApi.updateTask(id, updates);
    return task;
  }, []);

  const toggleComplete = useCallback(async (id: string) => {
    const task = await tasksApi.toggleCompleteTask(id);
    return task;
  }, []);

  const setPhase = useCallback(async (id: string, phase: string) => {
    const task = await tasksApi.updateTask(id, { phase });
    return task;
  }, []);

  const star = useCallback(async (id: string) => {
    const task = await tasksApi.starTask(id);
    return task;
  }, []);

  const reorder = useCallback((category: string, project: string, taskIds: string[]) => {
    guardEcho(`reorder:${category}/${project}`);
    setTasks((prev) => applyReorder(prev, category, project, taskIds));
    tasksApi.reorderTasks(category, project, taskIds).catch(() => refetch());
  }, [refetch, guardEcho]);

  const moveTask = useCallback((taskId: string, category: string, project: string, insertNearTaskId?: string) => {
    guardEcho(`move:${taskId}`);
    guardEcho(`reorder:${category}/${project}`);

    // Optimistic local state: move task to new category/project + reposition.
    // Also capture the new group order for the subsequent reorder API call.
    let newGroupOrder: string[] = [];
    setTasks((prev) => {
      const result = prev.map((t) =>
        t.id === taskId ? { ...t, category, project } : t
      );
      let final: Task[];
      if (insertNearTaskId) {
        const task = result.find((t) => t.id === taskId);
        if (!task) return result;
        const without = result.filter((t) => t.id !== taskId);
        const targetIdx = without.findIndex((t) => t.id === insertNearTaskId);
        without.splice(targetIdx >= 0 ? targetIdx : without.length, 0, task);
        final = without;
      } else {
        final = result;
      }
      newGroupOrder = final
        .filter((t) => t.category === category && t.project === project)
        .map((t) => t.id);
      return final;
    });

    tasksApi.updateTask(taskId, { category, project })
      .then(() => tasksApi.reorderTasks(category, project, newGroupOrder))
      .catch((err: Error) => { showOperationError(err.message); refetch(); });
  }, [refetch, guardEcho, showOperationError]);

  return { tasks, loading, error, operationError, clearOperationError, showOperationError, refetch, create, update, toggleComplete, setPhase, star, reorder, moveTask };
}
