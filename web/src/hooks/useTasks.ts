import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import * as tasksApi from '@/api/tasks';
import { ApiError } from '@/api/client';
import { perf } from '@/utils/perf-logger';
import { log } from '@/utils/log';
import { scrollLog } from '@/utils/scroll-debug';

/**
 * Optimistic default status for a newly-linked session (before the first
 * session:status-changed event arrives). Avoids the brief "? / ?" flash.
 */
const OPTIMISTIC_STARTING_STATUS = { process_status: 'running' as const };

/**
 * Merge an incoming WS task update with the existing local task,
 * preserving enriched fields (plan_session_status, exec_session_status)
 * that only come from the REST API, not from bus events.
 *
 * If a session slot changed (different ID or cleared), the stale status is dropped.
 * If a brand-new session ID appears, an optimistic in_progress/running default is used
 * so the badge never shows "? / ?".
 */
/**
 * Shallow equality over UI-visible task fields. Used to suppress no-op
 * `setTasks` calls from secondary WS echoes (e.g. plugin sync writes
 * `ext`/`_syncedAt` and re-emits TASK_UPDATED — nothing UI-visible changed,
 * but a naive `setTasks` still creates a new tasks array identity and
 * re-renders every row). The list below intentionally excludes `ext`,
 * `_syncedAt`, and other backend-only fields.
 */
function tasksShallowEqual(a: Task, b: Task): boolean {
  const scalarKeys: (keyof Task)[] = [
    'title', 'status', 'phase', 'priority', 'category', 'project',
    'parent_task_id', 'group_id', 'starred', 'due_date', 'completed_at', 'updated_at',
    'sync_error', 'external_url', 'needs_attention', 'source', 'sprint',
    'cwd', 'session_id', 'plan_session_id', 'exec_session_id',
  ];
  for (const k of scalarKeys) if (a[k] !== b[k]) return false;
  const arrKeys: (keyof Task)[] = ['tags', 'depends_on'];
  for (const k of arrKeys) {
    const av = (a[k] as string[] | undefined) ?? [];
    const bv = (b[k] as string[] | undefined) ?? [];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  }
  // Session status slots (nested objects) — compare on the process_status/activity
  // fields we actually render; deeper equality not needed because session:status-changed
  // is a separate WS event that delivers those changes with its own merge path.
  const cmpStatus = (x: Task['session_status'], y: Task['session_status']): boolean =>
    (x?.process_status ?? null) === (y?.process_status ?? null) &&
    (x?.activity ?? null) === (y?.activity ?? null);
  return cmpStatus(a.session_status, b.session_status)
    && cmpStatus(a.plan_session_status, b.plan_session_status)
    && cmpStatus(a.exec_session_status, b.exec_session_status);
}

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
  // `needs_attention` is a read/seen marker, not content. Clearing it on focus
  // must NOT bump updated_at, or the task jumps to the top of an updated_at-sorted
  // list seconds after the user merely selects it. Mirror task-manager.updateTask.
  const changedKeys = Object.keys(updates).filter((k) => updates[k] !== undefined);
  const onlyAttentionMarker = changedKeys.length > 0 && changedKeys.every((k) => k === 'needs_attention');
  return tasks.map(t => t.id === id
    ? (onlyAttentionMarker ? { ...t, ...filtered } : { ...t, ...filtered, updated_at: now })
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
  reparentTask: (taskId: string, newParentId: string | null, opts?: { insertAfterId?: string }) => void;
  /**
   * Rearrange the local tasks array so the given IDs come first in the given order,
   * preserving relative order of any tasks not in the list. Local-only (no backend sync).
   * Used by manual-sort auto-switch so the display doesn't reshuffle across sort modes.
   */
  bakeOrder: (orderedIds: string[]) => void;
  /** Virtual-group name registry: group_id → label. */
  taskGroups: Record<string, string>;
  /** Create a virtual group from ≥2 task ids (label AI-generated if omitted). */
  groupTasks: (taskIds: string[], label?: string) => void;
  /** Remove task(s) from their virtual group. */
  ungroupTasks: (taskIds: string[]) => void;
  /** Rename a virtual group. */
  renameGroup: (groupId: string, label: string) => void;
}

export function useTasks(filter?: tasksApi.TaskFilter): UseTasksReturn {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskGroups, setTaskGroups] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresh the group-name registry (group_id → label). Cheap, separate from
  // the task list; called on initial load + whenever groups change.
  const refetchGroups = useCallback(() => {
    tasksApi.fetchTaskGroups()
      .then((groups) => {
        const map: Record<string, string> = {};
        for (const g of groups) map[g.group_id] = g.label;
        setTaskGroups(map);
      })
      .catch(() => { /* groups are best-effort UI sugar — ignore fetch errors */ });
  }, []);

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

  const refetch = useCallback((attempt = 0) => {
    const MAX_RETRIES = 3;
    if (attempt === 0) {
      setLoading(true);
      setError(null);
      // Reset WS event counters on fresh fetch
      wsEventCounts.current = { created: 0, updated: 0, completed: 0, sessionChanged: 0, lastLogAt: 0 };
    }
    const endPerf = attempt === 0 ? perf.start('tasks:fetch') : undefined;
    const t0 = performance.now();
    log.info('tasks', 'fetch started', { attempt, filter, wsState: wsClient.state });
    // minimal: home list never renders summary/description/ext — the detail
    // pane lazy-loads them on focus. Cuts the list payload ~4MB -> ~0.4MB.
    tasksApi.fetchTasks(filter, { minimal: true })
      .then((tasks) => {
        const elapsed = Math.round(performance.now() - t0);
        endPerf?.(`${tasks.length} tasks`);
        log.info('tasks', 'fetch complete', { count: tasks.length, elapsed, attempt });
        setTasks(tasks);
        setLoading(false);
      })
      .catch((e: Error) => {
        const elapsed = Math.round(performance.now() - t0);
        endPerf?.('error');
        const isRetryable = e.name === 'TimeoutError' || e.name === 'TypeError' || (e instanceof ApiError && e.status >= 500);
        log.error('tasks', 'fetch FAILED', { error: e.message, elapsed, attempt, isRetryable, isTimeout: e.name === 'TimeoutError' });
        if (isRetryable && attempt < MAX_RETRIES) {
          const delayMs = 2000 * (attempt + 1);
          log.info('tasks', `auto-retry in ${delayMs}ms`, { attempt: attempt + 1 });
          setTimeout(() => refetch(attempt + 1), delayMs);
        } else {
          setError(e.message);
          setLoading(false);
        }
      });
  }, [filter]);

  useEffect(() => {
    refetch();
    refetchGroups();
  }, [refetch, refetchGroups]);

  // Track WS connection state — refetch tasks on reconnect (server restart, network blip)
  const isFirstConnect = useRef(true);
  const [wsConnected, setWsConnected] = useState(wsClient.state === 'connected');
  useEffect(() => {
    const onStateChange = (state: ConnectionState) => {
      log.info('tasks', `ws state → ${state}`);
      setWsConnected(state === 'connected');
    };
    wsClient.onConnectionChange(onStateChange);
    return () => { wsClient.offConnectionChange(onStateChange); };
  }, []);
  useEffect(() => {
    if (wsConnected) {
      if (isFirstConnect.current) {
        isFirstConnect.current = false;
        return; // skip — initial fetch already handled above
      }
      log.info('tasks', 'ws reconnected → refetching tasks');
      refetch();
    }
  }, [wsConnected, refetch]);

  // WS event counters for startup diagnostics — resets on refetch
  const wsEventCounts = useRef({ created: 0, updated: 0, completed: 0, sessionChanged: 0, lastLogAt: 0 });

  // Real-time event handlers — single source of truth for state changes
  // Server emits { task: <Task> } wrapper objects
  useEvent('task:created', (data) => {
    const { task } = data as { task: Task };
    // Skip tasks with missing or empty titles (e.g. from sync race conditions)
    if (!task.title || task.title.trim() === '') return;
    // Suppress the echo of our own optimistic create (already reconciled locally).
    if (consumeEcho(`create:${task.id}`)) return;
    wsEventCounts.current.created++;
    // Log every 10th event or first event (to spot event storms)
    const c = wsEventCounts.current;
    const now = Date.now();
    if (c.created === 1 || c.created % 10 === 0 || now - c.lastLogAt > 5000) {
      c.lastLogAt = now;
      log.info('tasks', 'ws event counts', { created: c.created, updated: c.updated, completed: c.completed, sessionChanged: c.sessionChanged });
    }
    // Deduplicate: if task with same id already exists, skip
    setTasks((prev) => prev.some((t) => t.id === task.id) ? prev : [task, ...prev]);
  });

  useEvent('task:updated', (data) => {
    wsEventCounts.current.updated++;
    const { task } = data as { task?: Task };
    if (!task) { log.info('tasks', 'ws task:updated bulk → refetch'); scrollLog('drag-trace-ws-updated-bulk-refetch'); refetch(); return; }
    if (consumeEcho(`move:${task.id}`)) { scrollLog('drag-trace-ws-updated-echo-move', { id: task.id.slice(0,12) }); return; }
    if (consumeEcho(`update:${task.id}`)) { scrollLog('drag-trace-ws-updated-echo-update', { id: task.id.slice(0,12) }); return; }
    if (consumeEcho(`phase:${task.id}`)) { scrollLog('drag-trace-ws-updated-echo-phase', { id: task.id.slice(0,12) }); return; }
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return prev;
      const merged = mergeTask(prev[idx], task);
      if (tasksShallowEqual(prev[idx], merged)) {
        scrollLog('drag-trace-ws-updated-bail-shallowEqual', { id: task.id.slice(0,12) });
        return prev;
      }
      scrollLog('drag-trace-ws-updated-APPLY', { id: task.id.slice(0,12), parent: task.parent_task_id });
      const next = prev.slice();
      next[idx] = merged;
      return next;
    });
  });

  useEvent('task:completed', (data) => {
    wsEventCounts.current.completed++;
    const { task } = data as { task?: Task };
    if (!task) { log.info('tasks', 'ws task:completed bulk → refetch'); refetch(); return; }
    if (consumeEcho(`complete:${task.id}`)) return;
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return prev;
      const merged = mergeTask(prev[idx], task);
      if (tasksShallowEqual(prev[idx], merged)) return prev;
      const next = prev.slice();
      next[idx] = merged;
      return next;
    });
  });

  useEvent('task:starred', (data) => {
    const { task } = data as { task?: Task };
    if (!task) { refetch(); return; }
    if (consumeEcho(`star:${task.id}`)) return;
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return prev;
      const merged = mergeTask(prev[idx], task);
      if (tasksShallowEqual(prev[idx], merged)) return prev;
      const next = prev.slice();
      next[idx] = merged;
      return next;
    });
  });

  useEvent('task:deleted', (data) => {
    const { id } = data as { id: string };
    setTasks((prev) => prev.filter((t) => t.id !== id));
  });

  useEvent('task:reordered', (data) => {
    const { category, project, taskIds } = data as { category: string; project: string; taskIds: string[] };
    if (consumeEcho(`reorder:${category}/${project}`)) { scrollLog('drag-trace-ws-reordered-echo', { cat: category, proj: project }); return; }
    scrollLog('drag-trace-ws-reordered-APPLY', { cat: category, proj: project, count: taskIds.length });
    setTasks((prev) => applyReorder(prev, category, project, taskIds));
  });

  // Virtual task group created / renamed / dissolved. Membership lives on the
  // tasks' group_id (carried by task:created/task:updated) but the group LABEL
  // lives in a separate registry, so the simplest correct refresh is a refetch.
  useEvent('task:groups-changed', () => {
    log.info('tasks', 'ws task:groups-changed → refetch tasks + groups');
    refetch();
    refetchGroups();
  });

  // When a session's status changes, update the enriched session status on the affected task
  useEvent('session:status-changed', (data) => {
    wsEventCounts.current.sessionChanged++;
    const { sessionId, taskId, phase, process_status, mode, activity, planCompleted } = data as {
      sessionId?: string; taskId?: string; phase?: string; process_status?: string;
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
        process_status: (process_status ?? 'stopped') as NonNullable<Task['plan_session_status']>['process_status'],
        ...(activity ? { activity } : {}),
        ...(mode ? { mode: mode as NonNullable<Task['session_status']>['mode'] } : {}),
        ...(planCompleted ? { planCompleted: true } : {}),
      };
      if (matchesSingle) updated.session_status = { ...updated.session_status, ...statusInfo };
      if (matchesPlan) updated.plan_session_status = { ...updated.plan_session_status, ...statusInfo };
      if (matchesExec) updated.exec_session_status = { ...updated.exec_session_status, ...statusInfo };
      // Update task phase if provided in the event
      if (phase) updated.phase = phase as Task['phase'];
      return updated;
    }));
  });

  // Shared error handler for optimistic operations: show banner + refetch truth from server
  const onOpError = useCallback((err: Error) => {
    showOperationError(err.message);
    refetch();
  }, [showOperationError, refetch]);

  const create = useCallback(async (input: tasksApi.CreateTaskInput) => {
    // Optimistic local-first insert: show the task immediately under a temp id,
    // then reconcile with the server's real task (or roll back on failure).
    const tmpId = `tmp-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic = {
      id: tmpId,
      title: input.title,
      status: 'todo',
      priority: (input.priority ?? 'none'),
      phase: 'TODO',
      category: input.category,
      project: input.project,
      created_at: now,
      updated_at: now,
    } as unknown as Task;
    setTasks((prev) => [optimistic, ...prev]);
    try {
      const task = await tasksApi.createTask(input);
      // Suppress the incoming task:created WS echo so we don't double-insert.
      guardEcho(`create:${task.id}`);
      setTasks((prev) => {
        const withoutTmp = prev.filter((t) => t.id !== tmpId);
        return withoutTmp.some((t) => t.id === task.id) ? withoutTmp : [task, ...withoutTmp];
      });
      return task;
    } catch (err) {
      setTasks((prev) => prev.filter((t) => t.id !== tmpId));
      onOpError(err as Error);
      throw err;
    }
  }, [guardEcho, onOpError]);

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

  const reparentTask = useCallback((
    taskId: string,
    newParentId: string | null,
    opts?: { insertAfterId?: string }
  ) => {
    scrollLog('drag-trace-reparentTask-start', { id: taskId.slice(0,12), newParent: newParentId?.slice(0,12) ?? 'null', insertAfter: opts?.insertAfterId?.slice(0,12) });
    guardEcho(`move:${taskId}`);

    // Snapshot current state so we can derive the task's old parent + group
    // info for the unparent-specific reorder persistence below.
    const snapshot = tasks;
    const current = snapshot.find((t) => t.id === taskId);
    const isUnparent = newParentId === null;
    const oldParentFullId = current?.parent_task_id
      ? snapshot.find((t) => t.id.startsWith(current.parent_task_id!))?.id ?? null
      : null;

    // Position priority for optimistic reposition:
    //   1. insertAfterId (drag drop target) — user's chosen drop spot, always respected
    //   2. Unparent fallback: just below old parent — keeps kebab Move-left visually stable
    //   3. Otherwise no reposition.
    let optimisticGroupIds: { cat: string; proj: string; ids: string[] } | null = null;
    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === taskId
          ? { ...t, parent_task_id: newParentId || undefined }
          : t
      );

      let anchorIdx = -1;
      if (opts?.insertAfterId) {
        anchorIdx = next.findIndex((t) => t.id === opts.insertAfterId);
      } else if (isUnparent && oldParentFullId) {
        anchorIdx = next.findIndex((t) => t.id === oldParentFullId);
      }

      if (anchorIdx !== -1) {
        const fromIdx = next.findIndex((t) => t.id === taskId);
        if (fromIdx !== -1 && fromIdx !== anchorIdx + 1) {
          const [moved] = next.splice(fromIdx, 1);
          // anchorIdx shifts left by 1 if we removed an item before it
          const effectiveAnchor = fromIdx < anchorIdx ? anchorIdx - 1 : anchorIdx;
          next.splice(effectiveAnchor + 1, 0, moved);
        }
      }

      if (isUnparent && current) {
        const cat = current.category;
        const proj = current.project ?? current.category;
        optimisticGroupIds = {
          cat,
          proj,
          ids: next
            .filter((t) => t.category === cat && (t.project ?? t.category) === proj)
            .map((t) => t.id),
        };
      }
      return next;
    });

    // Backend does NOT cascade category/project on parent change
    // (verified in task-manager.ts updateTask: parent_task_id is the only
    // field touched). So the optimistic state above is authoritative; the
    // `move:<id>` echoGuard eats the primary WS event and the sync-echo
    // is filtered by tasksShallowEqual. Do NOT refetch — replacing the
    // whole tasks array unmounts every SortableTaskItem and causes the
    // post-drag "flash / lost my task" the user has been hitting.
    //
    // Unparent still persists the new ordering via reorderTasks so the
    // server doesn't send a stale order on next organic fetch.
    withRetry(() => tasksApi.updateTask(taskId, { parent_task_id: newParentId ?? '' }))
      .then((freshTask) => {
        scrollLog('drag-trace-reparentTask-response', { id: taskId.slice(0,12), isUnparent });
        if (isUnparent && optimisticGroupIds) {
          const { cat, proj, ids } = optimisticGroupIds;
          guardEcho(`reorder:${cat}/${proj}`);
          return withRetry(() => tasksApi.reorderTasks(cat, proj, ids));
        }
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === freshTask.id);
          if (idx === -1) return prev;
          const merged = mergeTask(prev[idx], freshTask);
          if (tasksShallowEqual(prev[idx], merged)) {
            scrollLog('drag-trace-reparentTask-response-bail-shallowEqual', { id: taskId.slice(0,12) });
            return prev;
          }
          scrollLog('drag-trace-reparentTask-response-APPLY', { id: taskId.slice(0,12) });
          const next = prev.slice();
          next[idx] = merged;
          return next;
        });
      })
      .catch(onOpError);
  }, [tasks, guardEcho, onOpError]);

  const bakeOrder = useCallback((orderedIds: string[]) => {
    if (orderedIds.length === 0) return;
    setTasks((prev) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      // Stable sort: keep tasks not in orderedIds in place relative to each other.
      const decorated = prev.map((t, origIdx) => ({ t, origIdx, rank: rank.get(t.id) }));
      decorated.sort((a, b) => {
        if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
        if (a.rank !== undefined) return -1;
        if (b.rank !== undefined) return 1;
        return a.origIdx - b.origIdx;
      });
      return decorated.map((d) => d.t);
    });
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    withRetry(() => tasksApi.deleteTask(taskId)).catch((err) => {
      onOpError(err);
      refetch();
    });
  }, [onOpError, refetch]);

  // ── Virtual task groups ── (optimistic group_id flips + API; WS groups-changed
  // reconciles labels/membership; on error we refetch to resync.)
  const groupTasksCb = useCallback((taskIds: string[], label?: string) => {
    tasksApi.createTaskGroup(taskIds, label)
      .then((g) => {
        setTasks((prev) => prev.map((t) => g.member_ids.includes(t.id) ? { ...t, group_id: g.group_id } : t));
        setTaskGroups((prev) => ({ ...prev, [g.group_id]: g.label }));
      })
      .catch((err) => { onOpError(err); refetch(); refetchGroups(); });
  }, [onOpError, refetch, refetchGroups]);

  const ungroupTasksCb = useCallback((taskIds: string[]) => {
    const idSet = new Set(taskIds);
    setTasks((prev) => prev.map((t) => idSet.has(t.id) ? { ...t, group_id: undefined } : t));
    // Removing a member can auto-dissolve the whole group (backend prunes groups left
    // with <2 members), which also ungroups the lone survivor — a task NOT in taskIds.
    // The optimistic flip above only clears the removed ids, so refetch on success to
    // pick up the survivor's cleared group_id (the WS event may also arrive, but a
    // direct refetch makes the resync deterministic).
    tasksApi.removeTasksFromGroup(taskIds)
      .then(() => { refetch(); refetchGroups(); })
      .catch((err) => { onOpError(err); refetch(); refetchGroups(); });
  }, [onOpError, refetch, refetchGroups]);

  const renameGroupCb = useCallback((groupId: string, label: string) => {
    setTaskGroups((prev) => ({ ...prev, [groupId]: label }));
    tasksApi.renameTaskGroup(groupId, label)
      .catch((err) => { onOpError(err); refetchGroups(); });
  }, [onOpError, refetchGroups]);

  return { tasks, taskGroups, loading, error, operationError, clearOperationError, showOperationError, refetch, create, update, toggleComplete, setPhase, star, reorder, moveTask, reparentTask, bakeOrder, deleteTask, groupTasks: groupTasksCb, ungroupTasks: ungroupTasksCb, renameGroup: renameGroupCb };
}
