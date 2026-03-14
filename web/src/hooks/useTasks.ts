import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '@walnut/core';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import * as tasksApi from '@/api/tasks';
import { ApiError } from '@/api/client';
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


// ── Optimistic prediction functions ──

function applyToggleStar(tasks: Task[], id: string): Task[] {
  const now = new Date().toISOString();
  return tasks.map(t => t.id === id
    ? { ...t, starred: !t.starred, updated_at: now }
    : t);
}

/** Clear session slots and needs_attention — mirrors server applyPhase('COMPLETE'). */
function clearSessionSlots(t: Task): Task {
  return {
    ...t,
    session_id: undefined,
    plan_session_id: undefined,
    exec_session_id: undefined,
    session_status: undefined,
    plan_session_status: undefined,
    exec_session_status: undefined,
    needs_attention: undefined,
  };
}

function applyToggleComplete(tasks: Task[], id: string): Task[] {
  const now = new Date().toISOString();
  return tasks.map(t => {
    if (t.id !== id) return t;
    const completing = t.status !== 'done';
    const base = completing ? clearSessionSlots(t) : t;
    return {
      ...base,
      status: completing ? 'done' as const : 'todo' as const,
      phase: completing ? 'COMPLETE' : 'TODO',
      completed_at: completing ? now : undefined,
      updated_at: now,
    };
  });
}

/** Map phases to their corresponding task status. */
function phaseToStatus(phase: string): 'done' | 'todo' | 'in_progress' {
  if (phase === 'COMPLETE') return 'done';
  if (phase === 'TODO') return 'todo';
  return 'in_progress';
}

function applyPhaseChange(tasks: Task[], id: string, phase: string): Task[] {
  const now = new Date().toISOString();
  const completing = phase === 'COMPLETE';
  const status = phaseToStatus(phase);
  return tasks.map((t): Task => {
    if (t.id !== id) return t;
    const base = completing ? clearSessionSlots(t) : t;
    return { ...base, phase: phase as Task['phase'], status, completed_at: completing ? now : undefined, updated_at: now };
  });
}

/** Only spread direct-value task fields for optimistic update (not instruction fields like add_tags). */
const OPTIMISTIC_FIELDS = new Set([
  'title', 'status', 'phase', 'priority', 'category', 'project',
  'due_date', 'needs_attention', 'parent_task_id', 'starred',
]);

function applyFieldUpdate(tasks: Task[], id: string, updates: Record<string, unknown>): Task[] {
  const now = new Date().toISOString();
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(updates)) {
    if (OPTIMISTIC_FIELDS.has(key)) filtered[key] = updates[key];
  }
  return tasks.map(t => t.id === id
    ? { ...t, ...filtered, updated_at: now }
    : t);
}

// ── Retry helper ──

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  baseDelay = 300,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Don't retry client errors (4xx) — they won't succeed on retry
      if (lastErr instanceof ApiError && lastErr.status >= 400 && lastErr.status < 500) throw lastErr;
      if (i < retries) await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
    }
  }
  throw lastErr!;
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
  update: (id: string, updates: tasksApi.UpdateTaskInput) => void;
  toggleComplete: (id: string) => void;
  setPhase: (id: string, phase: string) => void;
  star: (id: string) => void;
  reorder: (category: string, project: string, taskIds: string[]) => void;
  moveTask: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
  reparentTask: (taskId: string, newParentId: string | null) => void;
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
  // Counter-based: each guardEcho increments the count, each consumed echo decrements.
  // This correctly handles rapid repeated operations (e.g. double-click star).
  // Auto-expire after 5s as safety net (decrements so counter never stays stuck).
  const echoGuard = useRef(new Map<string, number>());
  const guardEcho = useCallback((key: string) => {
    const map = echoGuard.current;
    map.set(key, (map.get(key) ?? 0) + 1);
    setTimeout(() => {
      const count = map.get(key) ?? 0;
      if (count <= 1) map.delete(key);
      else map.set(key, count - 1);
    }, 5000);
  }, []);
  /** Consume one echo guard for `key`. Returns true if an echo was suppressed. */
  const consumeEcho = useCallback((key: string): boolean => {
    const map = echoGuard.current;
    const count = map.get(key) ?? 0;
    if (count <= 0) return false;
    if (count <= 1) map.delete(key);
    else map.set(key, count - 1);
    return true;
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
    if (consumeEcho(`move:${task.id}`)) return;
    if (consumeEcho(`update:${task.id}`)) return;
    if (consumeEcho(`phase:${task.id}`)) return;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? mergeTask(t, task) : t)));
  });

  useEvent('task:completed', (data) => {
    const { task } = data as { task?: Task };
    if (!task) { refetch(); return; }
    if (consumeEcho(`complete:${task.id}`)) return;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? mergeTask(t, task) : t)));
  });

  useEvent('task:starred', (data) => {
    const { task } = data as { task?: Task };
    if (!task) { refetch(); return; }
    if (consumeEcho(`star:${task.id}`)) return;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? mergeTask(t, task) : t)));
  });

  useEvent('task:deleted', (data) => {
    const { id } = data as { id: string };
    setTasks((prev) => prev.filter((t) => t.id !== id));
  });

  useEvent('task:reordered', (data) => {
    const { category, project, taskIds } = data as { category: string; project: string; taskIds: string[] };
    if (consumeEcho(`reorder:${category}/${project}`)) return;
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

  // Shared error handler for optimistic operations: show banner + refetch truth from server
  const onOpError = useCallback((err: Error) => {
    showOperationError(err.message);
    refetch();
  }, [showOperationError, refetch]);

  const create = useCallback(async (input: tasksApi.CreateTaskInput) => {
    const task = await tasksApi.createTask(input);
    return task;
  }, []);

  const update = useCallback((id: string, updates: tasksApi.UpdateTaskInput) => {
    // Only guard echo + apply optimistic update when the update contains optimistic-safe fields.
    // Non-optimistic fields (description, summary, etc.) need the WS echo to propagate.
    const hasOptimistic = Object.keys(updates).some(k => OPTIMISTIC_FIELDS.has(k));
    if (hasOptimistic) {
      guardEcho(`update:${id}`);
      setTasks(prev => applyFieldUpdate(prev, id, updates as Record<string, unknown>));
    }
    withRetry(() => tasksApi.updateTask(id, updates)).catch(onOpError);
  }, [guardEcho, onOpError]);

  const toggleComplete = useCallback((id: string) => {
    guardEcho(`complete:${id}`);
    setTasks(prev => applyToggleComplete(prev, id));
    withRetry(() => tasksApi.toggleCompleteTask(id)).catch(onOpError);
  }, [guardEcho, onOpError]);

  const setPhase = useCallback((id: string, phase: string) => {
    guardEcho(`phase:${id}`);
    setTasks(prev => applyPhaseChange(prev, id, phase));
    withRetry(() => tasksApi.updateTask(id, { phase })).catch(onOpError);
  }, [guardEcho, onOpError]);

  const star = useCallback((id: string) => {
    guardEcho(`star:${id}`);
    setTasks(prev => applyToggleStar(prev, id));
    withRetry(() => tasksApi.starTask(id)).catch(onOpError);
  }, [guardEcho, onOpError]);

  const reorder = useCallback((category: string, project: string, taskIds: string[]) => {
    guardEcho(`reorder:${category}/${project}`);
    setTasks((prev) => applyReorder(prev, category, project, taskIds));
    withRetry(() => tasksApi.reorderTasks(category, project, taskIds))
      .catch(onOpError);
  }, [guardEcho, onOpError]);

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

    withRetry(() => tasksApi.updateTask(taskId, { category, project }))
      .then(() => withRetry(() => tasksApi.reorderTasks(category, project, newGroupOrder)))
      .catch(onOpError);
  }, [refetch, guardEcho, onOpError]);

  const reparentTask = useCallback((taskId: string, newParentId: string | null) => {
    guardEcho(`move:${taskId}`);
    // Optimistic: update parent_task_id locally
    setTasks((prev) => prev.map((t) =>
      t.id === taskId
        ? { ...t, parent_task_id: newParentId || undefined }
        : t
    ));
    // Backend handles category/project inheritance from new parent
    withRetry(() => tasksApi.updateTask(taskId, { parent_task_id: newParentId ?? '' }))
      .then(() => refetch())  // refetch to get updated category/project
      .catch(onOpError);
  }, [refetch, guardEcho, onOpError]);

  return { tasks, loading, error, operationError, clearOperationError, showOperationError, refetch, create, update, toggleComplete, setPhase, star, reorder, moveTask, reparentTask };
}
