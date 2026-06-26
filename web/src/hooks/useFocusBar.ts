import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as focusApi from '@/api/focus';
import type { FocusTier } from '@/api/focus';
import type { Task } from '@open-walnut/core';

export interface TierLimits {
  focus: number;
  satellite: number;
  wait: number;
}

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
  setTier: (taskId: string, tier: FocusTier) => Promise<void>;
  /**
   * Local-only optimistic pin into a tier (no server call). Used by quick-add so a
   * newly-created task shows up in its Focus tier the instant the user hits Enter,
   * before the create round-trip returns the real id. Pair with replaceLocalPinId
   * (swap temp→real id) + commitPin (persist) once the server id is known, or
   * removeLocalPin to roll back on failure.
   */
  addLocalPin: (taskId: string, tier: FocusTier) => void;
  /** Swap a temp id for the real one across all tier arrays (same position). */
  replaceLocalPinId: (tempId: string, realId: string) => void;
  /** Remove a (temp or real) id from all tier arrays — rollback path. */
  removeLocalPin: (taskId: string) => void;
  /** Persist a pin+tier to the server (no optimistic state change here). */
  commitPin: (taskId: string, tier: FocusTier) => Promise<void>;
  isPinned: (taskId: string) => boolean;
  tierOf: (taskId: string) => FocusTier;
  visible: boolean;
  setVisible: (v: boolean) => void;
  tierLimits: TierLimits;
  setTierLimits: (limits: TierLimits) => void;
}

const SELF_CHANGE_COOLDOWN = 3000;
const VISIBLE_KEY = 'open-walnut-focus-dock-visible';
const TIER_LIMITS_KEY = 'open-walnut-focus-tier-limits';
export const DEFAULT_TIER_LIMITS: TierLimits = { focus: 7, satellite: 5, wait: 5 };

function readVisible(): boolean {
  try { return localStorage.getItem(VISIBLE_KEY) === 'true'; } catch { return false; }
}

function readTierLimits(): TierLimits {
  try {
    const raw = localStorage.getItem(TIER_LIMITS_KEY);
    if (!raw) return DEFAULT_TIER_LIMITS;
    const parsed = JSON.parse(raw);
    return {
      focus: Number(parsed.focus) || DEFAULT_TIER_LIMITS.focus,
      satellite: Number(parsed.satellite) || DEFAULT_TIER_LIMITS.satellite,
      wait: Number(parsed.wait) || DEFAULT_TIER_LIMITS.wait,
    };
  } catch { return DEFAULT_TIER_LIMITS; }
}

/** Shallow-compare two string arrays — avoids unnecessary state updates from server echoes. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function useFocusBar(tasks: Task[]): UseFocusBarReturn {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [focusIds, setFocusIds] = useState<string[]>([]);
  const [satelliteIds, setSatelliteIds] = useState<string[]>([]);
  const [waitIds, setWaitIds] = useState<string[]>([]);
  const [visible, setVisibleState] = useState(readVisible);
  const [tierLimits, setTierLimitsState] = useState<TierLimits>(readTierLimits);

  // Mirror of pinnedIds for async closures (commitPin) that need the current
  // order without being re-created on every render.
  const pinnedIdsRef = useRef<string[]>([]);
  pinnedIdsRef.current = pinnedIds;

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    try { localStorage.setItem(VISIBLE_KEY, String(v)); } catch { /* ignore */ }
  }, []);

  const setTierLimits = useCallback((limits: TierLimits) => {
    setTierLimitsState(limits);
    try { localStorage.setItem(TIER_LIMITS_KEY, JSON.stringify(limits)); } catch { /* ignore */ }
  }, []);

  const lastWriteRef = useRef(0);

  // Apply server response — handles both full (GET) and partial (setTier) responses.
  // Uses equality check to skip no-op state updates (prevents render cascade when
  // server echoes the same data that the optimistic update already applied).
  const applyData = useCallback((data: Partial<focusApi.FocusBarData>) => {
    if (data.pinned_tasks) setPinnedIds(prev => arraysEqual(prev, data.pinned_tasks!) ? prev : data.pinned_tasks!);
    if (data.focus_tasks) setFocusIds(prev => arraysEqual(prev, data.focus_tasks!) ? prev : data.focus_tasks!);
    if (data.satellite_tasks) setSatelliteIds(prev => arraysEqual(prev, data.satellite_tasks!) ? prev : data.satellite_tasks!);
    if (data.wait_tasks) setWaitIds(prev => arraysEqual(prev, data.wait_tasks!) ? prev : data.wait_tasks!);
  }, []);

  const fetchPinned = useCallback(() => {
    focusApi.fetchPinnedTasks().then(applyData).catch(() => {});
  }, [applyData]);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);

  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key !== 'focus_bar') return;
    if (Date.now() - lastWriteRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchPinned();
  });

  // Auto-unpin completed tasks
  const removeFromAll = useCallback((taskId: string) => {
    setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    setFocusIds((prev) => prev.filter((id) => id !== taskId));
    setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
    setWaitIds((prev) => prev.filter((id) => id !== taskId));
  }, []);

  useEvent('task:completed', (data: unknown) => {
    const { task } = data as { task: { id: string } };
    if (task?.id && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      removeFromAll(task.id);
      focusApi.unpinTask(task.id).catch(() => {});
    }
  });
  useEvent('task:updated', (data: unknown) => {
    const { task } = data as { task: { id: string; phase?: string; status?: string } | null };
    if (!task?.id) return; // null task = bulk signal from plugin sync batch
    if ((task.phase === 'COMPLETE' || task.status === 'done') && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      removeFromAll(task.id);
      focusApi.unpinTask(task.id).catch(() => {});
    }
  });

  const pin = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task && (task.status === 'done' || task.phase === 'COMPLETE')) return;
    lastWriteRef.current = Date.now();
    // New pin defaults to Satellite, surfacing at the top of its tier. Prepend
    // must mirror the backend, where togglePin assigns pin_order = minOrder - 1
    // (top). If either side flips, the optimistic order and the post-refresh
    // order diverge and the row visibly jumps.
    setPinnedIds((prev) => prev.includes(taskId) ? prev : [taskId, ...prev]);
    setSatelliteIds((prev) => prev.includes(taskId) ? prev : [taskId, ...prev]);
    try {
      await focusApi.pinTask(taskId);
    } catch {
      setPinnedIds((prev) => prev.filter((id) => id !== taskId));
      setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
    }
  }, [tasks]);

  const unpin = useCallback(async (taskId: string) => {
    lastWriteRef.current = Date.now();
    removeFromAll(taskId);
    try {
      await focusApi.unpinTask(taskId);
    } catch {
      fetchPinned();
    }
  }, [removeFromAll, fetchPinned]);

  const reorder = useCallback(async (newIds: string[]) => {
    lastWriteRef.current = Date.now();
    setPinnedIds(newIds);
    try {
      await focusApi.reorderPinnedTasks(newIds);
    } catch {
      fetchPinned();
    }
  }, [fetchPinned]);

  const setTier = useCallback(async (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => {
    lastWriteRef.current = Date.now();
    // Optimistic: remove from old tier, add to new.
    // Only create new array when the item is actually added/removed (avoids no-op state updates).
    const addTo = (prev: string[]) => prev.includes(taskId) ? prev : [...prev, taskId];
    const removeFrom = (prev: string[]) => prev.includes(taskId) ? prev.filter((id) => id !== taskId) : prev;
    setFocusIds(tier === 'focus' ? addTo : removeFrom);
    setSatelliteIds(tier === 'satellite' ? addTo : removeFrom);
    setWaitIds(tier === 'wait' ? addTo : removeFrom);
    if (newPinnedOrder) setPinnedIds(newPinnedOrder);
    try {
      // When reordering, persist order FIRST so the setTier response
      // (which includes pinned_tasks) reflects the correct position.
      if (newPinnedOrder) await focusApi.reorderPinnedTasks(newPinnedOrder);
      const result = await focusApi.setTaskTier(taskId, tier);
      applyData(result);
    } catch {
      fetchPinned();
    }
  }, [applyData, fetchPinned]);

  // ── Optimistic local pin helpers (for quick-add: show in tier before the create
  // round-trip returns a real id). Pure state mutations + a separate persist call so
  // the editor can pipeline temp-id → real-id without a perceptible gap. ──

  // Set the cooldown so the config:changed echo from commitPin doesn't refetch and
  // clobber the optimistic state while the round-trip is still settling.
  const addLocalPin = useCallback((taskId: string, tier: FocusTier) => {
    lastWriteRef.current = Date.now();
    // Append to the BOTTOM of its tier — the task stays exactly where the user added
    // it (the "+ Add to …" line is at the bottom), like Apple Reminders. commitPin then
    // persists this bottom position so it survives a reload.
    setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    const addBottom = (prev: string[]) => prev.includes(taskId) ? prev : [...prev, taskId];
    const drop = (prev: string[]) => prev.includes(taskId) ? prev.filter((id) => id !== taskId) : prev;
    setFocusIds(tier === 'focus' ? addBottom : drop);
    setSatelliteIds(tier === 'satellite' ? addBottom : drop);
    setWaitIds(tier === 'wait' ? addBottom : drop);
  }, []);

  const replaceLocalPinId = useCallback((tempId: string, realId: string) => {
    const swap = (prev: string[]) => {
      const i = prev.indexOf(tempId);
      if (i === -1) return prev;
      const next = prev.slice();
      next[i] = realId;
      return next;
    };
    setPinnedIds(swap);
    setFocusIds(swap);
    setSatelliteIds(swap);
    setWaitIds(swap);
  }, []);

  const removeLocalPin = useCallback((taskId: string) => {
    removeFromAll(taskId);
  }, [removeFromAll]);

  const commitPin = useCallback(async (taskId: string, tier: FocusTier) => {
    lastWriteRef.current = Date.now();
    await focusApi.pinTask(taskId);
    await focusApi.setTaskTier(taskId, tier);
    // The backend pins new tasks at the TOP (pin_order = min - 1), but the user added
    // this at the bottom of its tier. Persist the bottom position by reordering: take
    // the current optimistic pinned order (already has taskId at the end) and push it
    // to the server so a reload keeps the same place. Apply the server's echo as truth.
    const desiredOrder = pinnedIdsRef.current.includes(taskId)
      ? pinnedIdsRef.current
      : [...pinnedIdsRef.current, taskId];
    const result = await focusApi.reorderPinnedTasks(desiredOrder);
    applyData(result);
  }, [applyData]);

  const isPinned = useCallback((taskId: string) => pinnedIds.includes(taskId), [pinnedIds]);

  const tierOf = useCallback((taskId: string): FocusTier => {
    if (focusIds.includes(taskId)) return 'focus';
    if (waitIds.includes(taskId)) return 'wait';
    return 'satellite';
  }, [focusIds, waitIds]);

  // Resolve IDs to Task objects
  const resolve = useCallback((ids: string[], allTasks: Task[]) => {
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    return ids
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done');
  }, []);

  const pinnedTasks = useMemo(() => resolve(pinnedIds, tasks), [resolve, pinnedIds, tasks]);
  const focusTasks = useMemo(() => resolve(focusIds, tasks), [resolve, focusIds, tasks]);
  const satelliteTasks = useMemo(() => resolve(satelliteIds, tasks), [resolve, satelliteIds, tasks]);
  const waitTasks = useMemo(() => resolve(waitIds, tasks), [resolve, waitIds, tasks]);

  return {
    pinnedIds, pinnedTasks,
    focusIds, satelliteIds, waitIds,
    focusTasks, satelliteTasks, waitTasks,
    pin, unpin, reorder, setTier,
    addLocalPin, replaceLocalPinId, removeLocalPin, commitPin,
    isPinned, tierOf,
    visible, setVisible,
    tierLimits, setTierLimits,
  };
}
