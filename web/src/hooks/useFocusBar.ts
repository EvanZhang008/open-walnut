import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEvent } from './useWebSocket';
import { log } from '@/utils/log';
import * as focusApi from '@/api/focus';
import type { FocusTier, CustomTierDef } from '@/api/focus';
import type { Task } from '@open-walnut/core';
import { useTasksContext } from '@/contexts/TasksContext';

export interface UseFocusBarReturn {
  pinnedIds: string[];
  pinnedTasks: Task[];
  focusIds: string[];
  satelliteIds: string[];
  backlogIds: string[];
  waitIds: string[];
  focusTasks: Task[];
  satelliteTasks: Task[];
  backlogTasks: Task[];
  waitTasks: Task[];
  /** User-defined tiers (Settings → Focus Tiers), registry order. */
  customTiers: CustomTierDef[];
  /** False until the first registry fetch resolves. Consumers that self-heal
   *  away from a stale ct_* reference MUST wait for this — the initial []
   *  is indistinguishable from "user has no custom tiers". */
  customTiersLoaded: boolean;
  /** Per custom-tier-id ordered pinned task ids. Identity-stable. */
  customTierIds: Record<string, string[]>;
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
function tierField(tier: FocusTier): string | undefined {
  return tier === 'satellite' ? undefined : tier;
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
 *
 * Custom tiers: the registry (id+label defs) is the ONE piece that is not
 * derivable from tasks — fetched once and refreshed on
 * config:changed{focus_tiers}. Tier membership still derives from
 * task.focus_tier; a task pointing at an unregistered tier id renders in
 * Satellite (mirrors server splitTiers self-heal).
 */
export function useFocusBar(): UseFocusBarReturn {
  const { tasks, patchTasksLocal, guardEcho } = useTasksContext();

  const [visible, setVisibleState] = useState(readVisible);

  // ── Custom tier registry ──
  const [customTiersRaw, setCustomTiers] = useState<CustomTierDef[]>([]);
  const [customTiersLoaded, setCustomTiersLoaded] = useState(false);
  useEffect(() => {
    focusApi.fetchCustomTiers()
      .then((r) => { setCustomTiers(r.tiers); setCustomTiersLoaded(true); })
      // Not silent: a failed fetch hides every custom tier (tabs, subgroups,
      // picker entries) with no other symptom — leave a trace for triage.
      .catch((err) => { log.warn('focus', 'custom tier registry fetch failed', { err: String(err) }); });
  }, []);
  const customTiers = useStableDefs(customTiersRaw);
  const customIdSet = useMemo(() => new Set(customTiers.map((t) => t.id)), [customTiers]);

  // ── Derivation ──
  const orderedPinned = useMemo(() =>
    tasks
      .filter((t) => t.pinned && t.phase !== 'COMPLETE' && t.status !== 'done')
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)),
  [tasks]);

  const pinnedIds = useStableIds(useMemo(() => orderedPinned.map((t) => t.id), [orderedPinned]));
  const focusIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id), [orderedPinned]));
  // Satellite is the default tier: anything not a non-default built-in
  // (focus/backlog/wait) and not in a REGISTERED custom tier falls here (incl.
  // the retired 'next' value and ids of deleted custom tiers on legacy tasks)
  // — mirrors server splitTiers().
  const isSatellite = useCallback((t: Task) =>
    !(t.focus_tier && (t.focus_tier === 'focus' || t.focus_tier === 'backlog' || t.focus_tier === 'wait' || customIdSet.has(t.focus_tier))),
  [customIdSet]);
  const satelliteIds = useStableIds(useMemo(
    () => orderedPinned.filter(isSatellite).map((t) => t.id), [orderedPinned, isSatellite]));
  const backlogIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'backlog').map((t) => t.id), [orderedPinned]));
  const waitIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'wait').map((t) => t.id), [orderedPinned]));
  const customTierIds = useStableTierMap(useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const def of customTiers) {
      map[def.id] = orderedPinned.filter((t) => t.focus_tier === def.id).map((t) => t.id);
    }
    return map;
  }, [orderedPinned, customTiers]));

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
    // custom_tier_tasks is typed optional ("absent on old servers"): a payload
    // with the built-in split but no custom map must not wipe custom-tier
    // members to satellite — keep each task's existing custom assignment then.
    const hasCustomSplit = data.custom_tier_tasks !== undefined;
    // Same defense for backlog_tasks (absent on pre-Backlog servers).
    const hasBacklogSplit = data.backlog_tasks !== undefined;
    const focusSet = new Set(data.focus_tasks ?? []);
    const backlogSet = new Set(data.backlog_tasks ?? []);
    const waitSet = new Set(data.wait_tasks ?? []);
    // Reverse lookup taskId → custom tier id from the per-tier arrays.
    const customOf = new Map<string, string>();
    for (const [tierId, ids] of Object.entries(data.custom_tier_tasks ?? {})) {
      for (const id of ids) customOf.set(id, tierId);
    }
    const currentCustomOf = (id: string): string | undefined => {
      const cur = tasksRef.current.find((t) => t.id === id)?.focus_tier;
      return cur && customIdSet.has(cur) ? cur : undefined;
    };
    const currentBacklogOf = (id: string): string | undefined =>
      tasksRef.current.find((t) => t.id === id)?.focus_tier === 'backlog' ? 'backlog' : undefined;
    const pinnedSet = new Set(data.pinned_tasks);
    const patches: Record<string, Partial<Task>> = {};
    data.pinned_tasks.forEach((id, i) => {
      patches[id] = {
        pinned: true,
        pin_order: i,
        ...(hasTierSplit
          ? {
            focus_tier: focusSet.has(id) ? 'focus' : waitSet.has(id) ? 'wait'
              : (hasBacklogSplit ? (backlogSet.has(id) ? 'backlog' : undefined) : currentBacklogOf(id))
              ?? (hasCustomSplit ? customOf.get(id) : currentCustomOf(id)),
          }
          : {}),
      };
    });
    for (const t of tasksRef.current) {
      if (t.pinned && !pinnedSet.has(t.id)) {
        patches[t.id] = { pinned: false, focus_tier: undefined, pin_order: undefined };
      }
    }
    patchTasksLocal(patches);
  }, [patchTasksLocal, customIdSet]);

  // Cross-client convergence: another client's pin/reorder emits
  // config:changed{focus_bar}. pin_order reorders carry no per-task WS events,
  // so pull the snapshot. Cooldown skips our own echoes (we already applied
  // the same change optimistically). config:changed{focus_tiers} = the custom
  // tier registry changed (Settings CRUD, any client) — always refetch defs;
  // tier membership self-corrects via task:updated echoes.
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key === 'focus_tiers') {
      focusApi.fetchCustomTiers()
        .then((r) => { setCustomTiers(r.tiers); setCustomTiersLoaded(true); })
        .catch((err) => { log.warn('focus', 'custom tier registry refetch failed', { err: String(err) }); });
      return;
    }
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
    if (backlogIds.includes(taskId)) return 'backlog';
    if (waitIds.includes(taskId)) return 'wait';
    for (const [tierId, ids] of Object.entries(customTierIds)) {
      if (ids.includes(taskId)) return tierId;
    }
    return 'satellite';
  }, [focusIds, backlogIds, waitIds, customTierIds]);

  // Resolved Task arrays (identity follows `tasks` — consumers needing stability
  // should key on the ID arrays, as FocusBarContext's memo does).
  const focusTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'focus'), [orderedPinned]);
  const satelliteTasks = useMemo(() => orderedPinned.filter(isSatellite), [orderedPinned, isSatellite]);
  const backlogTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'backlog'), [orderedPinned]);
  const waitTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'wait'), [orderedPinned]);

  return {
    pinnedIds, pinnedTasks: orderedPinned,
    focusIds, satelliteIds, backlogIds, waitIds,
    focusTasks, satelliteTasks, backlogTasks, waitTasks,
    customTiers, customTiersLoaded, customTierIds,
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

/** Identity-stable custom tier defs (compared by id+label sequence). */
function useStableDefs(defs: CustomTierDef[]): CustomTierDef[] {
  const ref = useRef<CustomTierDef[]>(defs);
  const same = ref.current.length === defs.length
    && ref.current.every((d, i) => d.id === defs[i].id && d.label === defs[i].label);
  if (!same) ref.current = defs;
  return ref.current;
}

/** Identity-stable tierId → ids map (compared by keys + array contents). */
function useStableTierMap(map: Record<string, string[]>): Record<string, string[]> {
  const ref = useRef<Record<string, string[]>>(map);
  const prev = ref.current;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(map);
  const same = prevKeys.length === nextKeys.length
    && nextKeys.every((k) => prev[k] !== undefined && arraysEqual(prev[k], map[k]));
  if (!same) ref.current = map;
  return ref.current;
}
