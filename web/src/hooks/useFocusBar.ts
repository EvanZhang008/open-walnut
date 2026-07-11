import { useState, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as focusApi from '@/api/focus';
import type { FocusTier } from '@/api/focus';
import type { Task } from '@open-walnut/core';
import { useTasksContext } from '@/contexts/TasksContext';

export interface UseFocusBarReturn {
  pinnedIds: string[];
  pinnedTasks: Task[];
  focusIds: string[];
  satelliteIds: string[];
  waitIds: string[];
  focusTasks: Task[];
  satelliteTasks: Task[];
  waitTasks: Task[];
  pin: (taskId: string) => Promise<void>;
  unpin: (taskId: string) => Promise<void>;
  reorder: (newIds: string[]) => Promise<void>;
  setTier: (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => Promise<void>;
  /**
   * Local-only optimistic pin into a tier (no server call). Used by quick-add so a
   * newly-created task shows up in its Focus tier the instant the user hits Enter,
   * before the create round-trip returns the real id. Pair with replaceLocalPinId
   * (swap temp→real id) + commitPin (persist) once the server id is known, or
   * removeLocalPin to roll back on failure.
   */
  addLocalPin: (taskId: string, tier: FocusTier) => void;
  /** Carry the temp id's optimistic pin state over to the real id (same position). */
  replaceLocalPinId: (tempId: string, realId: string) => void;
  /** Remove a (temp or real) id's pin state — rollback path. */
  removeLocalPin: (taskId: string) => void;
  /** Persist a pin+tier to the server (no optimistic state change here). */
  commitPin: (taskId: string, tier: FocusTier) => Promise<void>;
  isPinned: (taskId: string) => boolean;
  tierOf: (taskId: string) => FocusTier;
  visible: boolean;
  setVisible: (v: boolean) => void;
}

const SELF_CHANGE_COOLDOWN = 3000;
const VISIBLE_KEY = 'open-walnut-focus-dock-visible';

function readVisible(): boolean {
  try { return localStorage.getItem(VISIBLE_KEY) === 'true'; } catch { return false; }
}

/** Shallow-compare two string arrays — used to keep derived array identities stable. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Normalize a tier for storage on the task object: satellite = undefined (default). */
function tierField(tier: FocusTier): 'focus' | 'wait' | undefined {
  return tier === 'focus' || tier === 'wait' ? tier : undefined;
}

/**
 * Focus Bar state, DERIVED from TasksContext — the task objects' pinned /
 * focus_tier / pin_order fields are the single client-side source of truth.
 *
 * History: this hook used to keep its own four ID arrays fed by
 * GET /api/focus/tasks + config:changed refetches. That second copy of the
 * truth could go stale independently of the task list (fork landing in
 * Satellite while the task said focus_tier=focus; complete-from-session-panel
 * leaving the pin card behind for seconds) and had no self-healing path.
 * Now every surface renders the same task objects, mutations patch them
 * optimistically in one frame, and WS task:updated echoes are the correction
 * channel. GET /api/focus/tasks remains only as a cross-client convergence
 * snapshot on non-self config:changed{focus_bar} (pin_order reorders don't
 * emit per-task events).
 */
export function useFocusBar(): UseFocusBarReturn {
  const { tasks, patchTasksLocal, guardEcho } = useTasksContext();

  const [visible, setVisibleState] = useState(readVisible);

  // ── Derivation ──
  const orderedPinned = useMemo(() =>
    tasks
      .filter((t) => t.pinned && t.phase !== 'COMPLETE' && t.status !== 'done')
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)),
  [tasks]);

  const pinnedIds = useStableIds(useMemo(() => orderedPinned.map((t) => t.id), [orderedPinned]));
  const focusIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id), [orderedPinned]));
  // Satellite is the default tier: anything not focus and not wait (incl. the
  // retired 'next' value on legacy tasks) falls here — mirrors server splitTiers().
  const satelliteIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier !== 'focus' && t.focus_tier !== 'wait').map((t) => t.id), [orderedPinned]));
  const waitIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'wait').map((t) => t.id), [orderedPinned]));

  // Refs for async closures (commitPin, event handlers) — always-current values
  // without re-creating the callbacks each render.
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  const pinnedIdsRef = useRef<string[]>(pinnedIds);
  pinnedIdsRef.current = pinnedIds;

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    try { localStorage.setItem(VISIBLE_KEY, String(v)); } catch { /* ignore */ }
  }, [setVisibleState]);

  const lastWriteRef = useRef(0);

  // Apply a server tier snapshot as task patches. Only used for cross-client
  // convergence + post-reorder confirmation; own optimistic patches already
  // mirror server semantics.
  //
  // DEFENSIVE: only rewrite focus_tier when the payload actually carries the tier
  // arrays. A pinned-only payload (e.g. a reorder response that forgot to include
  // them) would otherwise treat focus/wait as empty and wipe every task's tier to
  // satellite — the "Focus tasks vanish after adding a task" bug. When the tier
  // split is absent we touch only pinned + pin_order and leave focus_tier intact.
  const applyFocusData = useCallback((data: Partial<focusApi.FocusBarData>) => {
    if (!data.pinned_tasks) return;
    const hasTierSplit = data.focus_tasks !== undefined || data.wait_tasks !== undefined;
    const focusSet = new Set(data.focus_tasks ?? []);
    const waitSet = new Set(data.wait_tasks ?? []);
    const pinnedSet = new Set(data.pinned_tasks);
    const patches: Record<string, Partial<Task>> = {};
    data.pinned_tasks.forEach((id, i) => {
      patches[id] = {
        pinned: true,
        pin_order: i,
        ...(hasTierSplit
          ? { focus_tier: focusSet.has(id) ? 'focus' as const : waitSet.has(id) ? 'wait' as const : undefined }
          : {}),
      };
    });
    for (const t of tasksRef.current) {
      if (t.pinned && !pinnedSet.has(t.id)) {
        patches[t.id] = { pinned: false, focus_tier: undefined, pin_order: undefined };
      }
    }
    patchTasksLocal(patches);
  }, [patchTasksLocal]);

  // Cross-client convergence: another client's pin/reorder emits
  // config:changed{focus_bar}. pin_order reorders carry no per-task WS events,
  // so pull the snapshot. Cooldown skips our own echoes (we already applied
  // the same change optimistically).
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key !== 'focus_bar') return;
    if (Date.now() - lastWriteRef.current < SELF_CHANGE_COOLDOWN) return;
    focusApi.fetchPinnedTasks().then(applyFocusData).catch(() => {});
  });

  // Auto-unpin completed tasks. Display already excludes them (orderedPinned
  // filter), but the phase-update server path (updateTask phase=COMPLETE) does
  // not clear pinned server-side — completeTask/toggleComplete do. Keep the DB
  // tidy so the pin doesn't resurrect on reopen.
  const autoUnpinIfCompleted = useCallback((data: unknown) => {
    const { task } = data as { task: { id: string; phase?: string; status?: string; pinned?: boolean } | null };
    if (!task?.id) return;
    const done = task.phase === 'COMPLETE' || task.status === 'done';
    if (!done) return;
    const local = tasksRef.current.find((t) => t.id === task.id);
    if (!(task.pinned ?? local?.pinned)) return;
    lastWriteRef.current = Date.now();
    patchTasksLocal({ [task.id]: { pinned: false, focus_tier: undefined, pin_order: undefined } });
    focusApi.unpinTask(task.id).catch(() => {});
  }, [patchTasksLocal]);
  useEvent('task:completed', autoUnpinIfCompleted);
  useEvent('task:updated', autoUnpinIfCompleted);

  // ── Mutations: optimistic patch (mirrors server semantics) + API call.
  // The WS echo of our own call merges as a no-op (same values); on API error
  // we roll back / re-pull. ──

  const pin = useCallback(async (taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (task && (task.status === 'done' || task.phase === 'COMPLETE')) return;
    lastWriteRef.current = Date.now();
    // Mirror backend togglePin: new pins surface at the TOP of their tier
    // (pin_order = min existing - 1). If either side flips, the optimistic
    // order and the echo order diverge and the row visibly jumps.
    const orders = tasksRef.current.filter((t) => t.pinned).map((t) => t.pin_order ?? 0);
    const minOrder = orders.length ? Math.min(...orders) : 0;
    patchTasksLocal({ [taskId]: { pinned: true, pin_order: minOrder - 1, focus_tier: undefined } });
    try {
      await focusApi.pinTask(taskId);
    } catch {
      patchTasksLocal({ [taskId]: { pinned: false, focus_tier: undefined, pin_order: undefined } });
    }
  }, [patchTasksLocal]);

  const unpin = useCallback(async (taskId: string) => {
    lastWriteRef.current = Date.now();
    patchTasksLocal({ [taskId]: { pinned: false, focus_tier: undefined, pin_order: undefined } });
    try {
      await focusApi.unpinTask(taskId);
    } catch {
      focusApi.fetchPinnedTasks().then(applyFocusData).catch(() => {});
    }
  }, [patchTasksLocal, applyFocusData]);

  const reorder = useCallback(async (newIds: string[]) => {
    lastWriteRef.current = Date.now();
    const patches: Record<string, Partial<Task>> = {};
    newIds.forEach((id, i) => { patches[id] = { pin_order: i }; });
    patchTasksLocal(patches);
    try {
      await focusApi.reorderPinnedTasks(newIds);
    } catch {
      focusApi.fetchPinnedTasks().then(applyFocusData).catch(() => {});
    }
  }, [patchTasksLocal, applyFocusData]);

  const setTier = useCallback(async (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => {
    lastWriteRef.current = Date.now();
    const patches: Record<string, Partial<Task>> = {
      [taskId]: { focus_tier: tierField(tier) },
    };
    if (newPinnedOrder) {
      newPinnedOrder.forEach((id, i) => {
        patches[id] = { ...(patches[id] ?? {}), pin_order: i };
      });
    }
    patchTasksLocal(patches);
    try {
      // When reordering, persist order FIRST so the setTier response
      // (which includes pinned_tasks) reflects the correct position.
      if (newPinnedOrder) await focusApi.reorderPinnedTasks(newPinnedOrder);
      await focusApi.setTaskTier(taskId, tier);
    } catch {
      focusApi.fetchPinnedTasks().then(applyFocusData).catch(() => {});
    }
  }, [patchTasksLocal, applyFocusData]);

  // ── Optimistic local pin helpers (quick-add: show in tier before the create
  // round-trip returns a real id). Pure task patches + a separate persist call so
  // the editor can pipeline temp-id → real-id without a perceptible gap. ──

  // Remember each temp id's tier/order so replaceLocalPinId can re-apply them to
  // the real task (create() swaps the temp task object out wholesale).
  const localPinsRef = useRef(new Map<string, { tier: FocusTier; order: number }>());

  const addLocalPin = useCallback((taskId: string, tier: FocusTier) => {
    lastWriteRef.current = Date.now();
    // Append to the BOTTOM of its tier — the task stays exactly where the user
    // added it (the "+ Add to …" line is at the bottom), like Apple Reminders.
    // commitPin then persists this bottom position so it survives a reload.
    const orders = tasksRef.current.filter((t) => t.pinned).map((t) => t.pin_order ?? 0);
    const maxOrder = orders.length ? Math.max(...orders) : 0;
    localPinsRef.current.set(taskId, { tier, order: maxOrder + 1 });
    patchTasksLocal({ [taskId]: { pinned: true, pin_order: maxOrder + 1, focus_tier: tierField(tier) } });
  }, [patchTasksLocal]);

  const replaceLocalPinId = useCallback((tempId: string, realId: string) => {
    const entry = localPinsRef.current.get(tempId);
    localPinsRef.current.delete(tempId);
    if (!entry) return;
    // The temp task object is gone (create() swapped in the server task, which
    // says pinned=false until commitPin persists) — re-apply the pin state.
    patchTasksLocal({ [realId]: { pinned: true, pin_order: entry.order, focus_tier: tierField(entry.tier) } });
  }, [patchTasksLocal]);

  const removeLocalPin = useCallback((taskId: string) => {
    localPinsRef.current.delete(taskId);
    patchTasksLocal({ [taskId]: { pinned: false, focus_tier: undefined, pin_order: undefined } });
  }, [patchTasksLocal]);

  const commitPin = useCallback(async (taskId: string, tier: FocusTier) => {
    lastWriteRef.current = Date.now();
    // The backend pins at the TOP (pin_order = min - 1) and emits task:updated
    // echoes with that transient state; our optimistic patch says bottom. Guard
    // the two echoes (togglePin + setFocusTier) so the row doesn't jump to the
    // top and back while the reorder below settles.
    guardEcho(`update:${taskId}`);
    guardEcho(`update:${taskId}`);
    await focusApi.pinTask(taskId);
    await focusApi.setTaskTier(taskId, tier);
    // Persist the bottom position: take the current pinned order (already has
    // taskId via replaceLocalPinId) and push it; apply the echo as truth.
    const desiredOrder = pinnedIdsRef.current.includes(taskId)
      ? pinnedIdsRef.current
      : [...pinnedIdsRef.current, taskId];
    const result = await focusApi.reorderPinnedTasks(desiredOrder);
    applyFocusData(result);
  }, [guardEcho, applyFocusData]);

  const isPinned = useCallback((taskId: string) => pinnedIds.includes(taskId), [pinnedIds]);

  const tierOf = useCallback((taskId: string): FocusTier => {
    if (focusIds.includes(taskId)) return 'focus';
    if (waitIds.includes(taskId)) return 'wait';
    return 'satellite';
  }, [focusIds, waitIds]);

  // Resolved Task arrays (identity follows `tasks` — consumers needing stability
  // should key on the ID arrays, as FocusBarContext's memo does).
  const focusTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'focus'), [orderedPinned]);
  const satelliteTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier !== 'focus' && t.focus_tier !== 'wait'), [orderedPinned]);
  const waitTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'wait'), [orderedPinned]);

  return {
    pinnedIds, pinnedTasks: orderedPinned,
    focusIds, satelliteIds, waitIds,
    focusTasks, satelliteTasks, waitTasks,
    pin, unpin, reorder, setTier,
    addLocalPin, replaceLocalPinId, removeLocalPin, commitPin,
    isPinned, tierOf,
    visible, setVisible,
  };
}

// ── Small local hooks ──

/** Return the previous array identity when contents are unchanged. */
function useStableIds(ids: string[]): string[] {
  const ref = useRef<string[]>(ids);
  if (!arraysEqual(ref.current, ids)) ref.current = ids;
  return ref.current;
}
