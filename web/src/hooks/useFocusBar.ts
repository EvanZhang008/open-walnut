import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useCommittedRef } from './useCommittedRef';
import { useEvent } from './useWebSocket';
import { fetchWithRetry } from '@/utils/fetch-retry';
import * as focusApi from '@/api/focus';
import type { FocusTier, CustomTierDef } from '@/api/focus';
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
   * Many tasks at once (a folder's or a project's Pinned row): every task lands in
   * `tier`, the unpinned ones pinned at the bottom in the order given; `null`
   * unpins them all. One request; a completed task is never newly pinned.
   */
  setTierBulk: (taskIds: string[], tier: FocusTier | null, onError?: (message: string, failedIds?: string[]) => void) => Promise<void>;
  /**
   * Local-only optimistic pin into a tier (no server call). Used by quick-add so a
   * newly-created task shows up in its Focus tier the instant the user hits Enter,
   * before the create round-trip returns the real id. The create carries the pin
   * itself; pair with replaceLocalPinId (swap temp→real id) once the server id is
   * known, or removeLocalPin to roll back on failure.
   */
  addLocalPin: (taskId: string, tier: FocusTier) => void;
  /** Carry the temp id's optimistic pin state over to the real id (same position). */
  replaceLocalPinId: (tempId: string, realId: string) => void;
  /** Remove a (temp or real) id's pin state — rollback path. */
  removeLocalPin: (taskId: string) => void;
  isPinned: (taskId: string) => boolean;
  tierOf: (taskId: string) => FocusTier;
  visible: boolean;
  setVisible: (v: boolean) => void;
}

const SELF_CHANGE_COOLDOWN = 3000;
/** How long a quick-add's create may hold Focus Bar answers back (the API's own
 *  timeout is 15s, so a create that is still out past this never reports back). */
const QUICK_ADD_HOLD_MS = 30_000;
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

/**
 * Await one Focus Bar write whose optimistic patch is held (`patchTasksLocal(...,
 * { pending: true })`), and run its settle exactly once when the write is answered,
 * fails or times out (the API's own 15s default), BEFORE the caller reads the
 * outcome: a rollback patch or a snapshot applied while the edit is still held
 * would be laid back under the optimistic values by the next list read.
 */
async function heldWrite<T>(settle: () => void, write: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await write() };
  } catch {
    return { ok: false };
  } finally {
    settle();
  }
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
  const { tasks, patchTasksLocal, guardEcho, showOperationError } = useTasksContext();

  const [visible, setVisibleState] = useState(readVisible);

  // ── Custom tier registry ──
  const [customTiersRaw, setCustomTiers] = useState<CustomTierDef[]>([]);
  const [customTiersLoaded, setCustomTiersLoaded] = useState(false);
  // A failed fetch hides every custom tier (tabs, subgroups, picker entries)
  // with no other symptom, so the load retries on the registry schedule, is
  // re-pulled when the socket comes back, and only ever REPLACES the defs from
  // a successful answer. A newer load supersedes an older one still waiting.
  const tiersGeneration = useRef(0);
  const tiersAbort = useRef<AbortController | null>(null);
  const loadCustomTiers = useCallback(() => {
    tiersAbort.current?.abort();
    const abort = new AbortController();
    tiersAbort.current = abort;
    const generation = ++tiersGeneration.current;
    fetchWithRetry(() => focusApi.fetchCustomTiers(), {
      subsystem: 'focus', label: 'custom tier registry', signal: abort.signal,
    })
      .then((r) => {
        if (generation !== tiersGeneration.current) return;
        setCustomTiers(r.tiers);
        setCustomTiersLoaded(true);
      })
      .catch(() => { /* logged by fetchWithRetry; the next reconnect asks again */ });
  }, []);
  useEffect(() => {
    loadCustomTiers();
    return () => { tiersGeneration.current++; tiersAbort.current?.abort(); };
  }, [loadCustomTiers]);
  // Events during a socket gap are gone for good, and this registry is not
  // polled. One load per reconnect (it restarts the schedule); the socket's own
  // reconnect backoff (1s doubling to 30s) is what bounds a flapping server.
  useEvent('_ws:reconnected', loadCustomTiers);
  const customTiers = useStableDefs(customTiersRaw);
  const customIdSet = useMemo(() => new Set(customTiers.map((t) => t.id)), [customTiers]);

  // ── Derivation ──
  // Completed pins are INCLUDED (2026-08-26, user request): completion no
  // longer unpins anywhere (server or client), so the done card keeps its tier
  // slot until the user unpins it. Mirrors server splitTiers().
  const orderedPinned = useMemo(() =>
    tasks
      .filter((t) => t.pinned)
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)),
  [tasks]);

  const pinnedIds = useStableIds(useMemo(() => orderedPinned.map((t) => t.id), [orderedPinned]));
  const focusIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id), [orderedPinned]));
  // Satellite is the default tier: anything not a non-default built-in
  // (focus/wait) and not in a REGISTERED custom tier falls here (incl. the
  // retired 'next' value and ids of deleted custom tiers on legacy tasks)
  // — mirrors server splitTiers().
  const isSatellite = useCallback((t: Task) =>
    !(t.focus_tier && (t.focus_tier === 'focus' || t.focus_tier === 'wait' || customIdSet.has(t.focus_tier))),
  [customIdSet]);
  const satelliteIds = useStableIds(useMemo(
    () => orderedPinned.filter(isSatellite).map((t) => t.id), [orderedPinned, isSatellite]));
  const waitIds = useStableIds(useMemo(
    () => orderedPinned.filter((t) => t.focus_tier === 'wait').map((t) => t.id), [orderedPinned]));
  const customTierIds = useStableTierMap(useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const def of customTiers) {
      map[def.id] = orderedPinned.filter((t) => t.focus_tier === def.id).map((t) => t.id);
    }
    return map;
  }, [orderedPinned, customTiers]));

  // Refs for async closures (event handlers): always-current values
  // without re-creating the callbacks each render.
  const tasksRef = useCommittedRef<Task[]>(tasks);

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    try { localStorage.setItem(VISIBLE_KEY, String(v)); } catch { /* ignore */ }
  }, [setVisibleState]);

  const lastWriteRef = useRef(0);
  // Each quick-add pin while its create is out: its tier/order so replaceLocalPinId
  // can re-apply them to the real task (create() swaps the temp task object out
  // wholesale), and when it began.
  const localPinsRef = useRef(new Map<string, { tier: FocusTier; order: number; at: number }>());

  // ── One answer at a time, and only once every write is in ──
  // Every write answers with a full tier snapshot, read when the server applied
  // THAT write. The server applies writes in the order they get its write lock,
  // not the order they were sent (the tier route reads the tier registry before it
  // locks, the reorder route locks at once), so while two writes overlap neither
  // answer is the last word: a collapsed folder dropped in another tier sends one
  // tier write per member plus a reorder in the same tick, the reorder often lands
  // first, and its snapshot still holds the old tiers. Applied, it wrote the old
  // tier over the members' held edits and the folder snapped back. So a write's own
  // answer is applied only when no other write (nor a quick-add create, nor the
  // pull below) was out at any point of it; otherwise, once the last one is in, one
  // pull of the whole snapshot, sent after all of them landed, is the answer.
  const inFlight = useRef(0);
  const overlapped = useRef(false);
  /** A quick-add counts as a write while its create is out (bounded, so a create
   *  that never reports back cannot hold every answer forever). */
  const quickAddsOut = () => {
    const since = Date.now() - QUICK_ADD_HOLD_MS;
    for (const entry of localPinsRef.current.values()) if (entry.at > since) return true;
    return false;
  };
  const busy = () => inFlight.current > 0 || quickAddsOut();
  const beginWrite = useCallback((opts?: { pull?: boolean }) => {
    if (!opts?.pull) lastWriteRef.current = Date.now();
    if (busy()) overlapped.current = true;
    inFlight.current++;
  }, []);

  // Apply a server tier snapshot as task patches: a write's own answer, the pull
  // after overlapping writes, or another client's change.
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
    const focusSet = new Set(data.focus_tasks ?? []);
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
    const pinnedSet = new Set(data.pinned_tasks);
    const patches: Record<string, Partial<Task>> = {};
    data.pinned_tasks.forEach((id, i) => {
      patches[id] = {
        pinned: true,
        pin_order: i,
        ...(hasTierSplit
          ? {
            focus_tier: focusSet.has(id) ? 'focus' : waitSet.has(id) ? 'wait'
              : (hasCustomSplit ? customOf.get(id) : currentCustomOf(id)),
          }
          : {}),
      };
    });
    for (const t of tasksRef.current) {
      // A quick-add pin whose create has not answered is in no server snapshot yet.
      if (localPinsRef.current.has(t.id)) continue;
      if (t.pinned && !pinnedSet.has(t.id)) {
        patches[t.id] = { pinned: false, focus_tier: undefined, pin_order: undefined };
      }
    }
    patchTasksLocal(patches);
  }, [patchTasksLocal, customIdSet]);

  // The pull counts as a write in flight, so a write that starts while it is out
  // marks the overlap and the pull's answer is not applied (it serves as the
  // generation check): the next quiet moment pulls again.
  const pullThen = useCallback((done: (answer: Partial<focusApi.FocusBarData> | 'quiet') => void) => {
    beginWrite({ pull: true });
    focusApi.fetchPinnedTasks().then(done, () => done('quiet'));
  }, [beginWrite]);
  // One write is over (its held patch already settled, its rollback made). `answer`
  // is its snapshot, `null` a failure (the page may now be wrong: pull), `'quiet'`
  // a write with nothing of its own to apply (a quick-add whose create came back,
  // a pull that failed). `counted` is false for a quick-add, which is counted by
  // localPinsRef rather than inFlight.
  const endWrite = useCallback(function end(answer: Partial<focusApi.FocusBarData> | null | 'quiet', counted = true) {
    if (counted) inFlight.current--;
    if (busy()) {
      // Not the last one in: this answer may already be overtaken.
      overlapped.current = true;
      return;
    }
    if (!overlapped.current && answer !== null) {
      if (answer !== 'quiet') applyFocusData(answer);
      return;
    }
    overlapped.current = false;
    pullThen(end);
  }, [applyFocusData, pullThen]);

  // Cross-client convergence: another client's pin/reorder emits
  // config:changed{focus_bar}. pin_order reorders carry no per-task WS events,
  // so pull the snapshot. Cooldown skips our own echoes (we already applied
  // the same change optimistically); while our own writes are out, the pull that
  // follows them carries the other client's change too. config:changed{focus_tiers}
  // = the custom tier registry changed (Settings CRUD, any client): always refetch
  // defs; tier membership self-corrects via task:updated echoes.
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key === 'focus_tiers') {
      loadCustomTiers();
      return;
    }
    if (key !== 'focus_bar') return;
    if (Date.now() - lastWriteRef.current < SELF_CHANGE_COOLDOWN) return;
    if (busy()) { overlapped.current = true; return; }
    pullThen(endWrite);
  });

  // Auto-unpin-on-completion REMOVED (2026-08-26, user request): a pin is a
  // manual placement, so completing a task keeps its card in the tier (with
  // done styling) until the user unpins it. The server-side auto-unpin in
  // completeTask/toggleComplete/setPhaseBulk was removed in the same change.

  // ── Mutations: optimistic patch (mirrors server semantics), held until the API
  // call answers, then endWrite above decides which answer the page takes. Every
  // beginWrite is paired with exactly one endWrite, in a finally: a throw after it
  // (a caller's error callback, a rollback) would otherwise leave the write counted
  // as out for good, and no answer, pull or other client's change would ever apply. ──

  const pin = useCallback(async (taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    // No NEW pins on done tasks (mirrors server togglePin) — existing pins
    // survive completion, but a fresh pin would be invisible outside search.
    if (task && (task.status === 'done' || task.phase === 'COMPLETE')) return;
    // Mirror backend togglePin: new pins land at the BOTTOM (pin_order = max
    // existing + 1), so an arriving pin never reshuffles a hand-arranged order.
    // If either side flips, the optimistic order and the echo order diverge and
    // the row visibly jumps.
    const orders = tasksRef.current.filter((t) => t.pinned).map((t) => t.pin_order ?? 0);
    const maxOrder = orders.length ? Math.max(...orders) : -1;
    beginWrite();
    // The answer carries pinned ids only, so it never touches a tier.
    let answer: Partial<focusApi.FocusBarData> | null = null;
    try {
      const settle = patchTasksLocal({ [taskId]: { pinned: true, pin_order: maxOrder + 1, focus_tier: undefined } }, { pending: true });
      const written = await heldWrite(settle, () => focusApi.pinTask(taskId));
      if (written.ok) answer = written.value;
      else patchTasksLocal({ [taskId]: { pinned: false, focus_tier: undefined, pin_order: undefined } });
    } finally {
      endWrite(answer);
    }
  }, [patchTasksLocal, beginWrite, endWrite]);

  const unpin = useCallback(async (taskId: string) => {
    beginWrite();
    let answer: Partial<focusApi.FocusBarData> | null = null;
    try {
      const settle = patchTasksLocal({ [taskId]: { pinned: false, focus_tier: undefined, pin_order: undefined } }, { pending: true });
      const written = await heldWrite(settle, () => focusApi.unpinTask(taskId));
      if (written.ok) answer = written.value;
    } finally {
      endWrite(answer);
    }
  }, [patchTasksLocal, beginWrite, endWrite]);

  const reorder = useCallback(async (newIds: string[]) => {
    const patches: Record<string, Partial<Task>> = {};
    newIds.forEach((id, i) => { patches[id] = { pin_order: i }; });
    // Held until the write answers: pin_order has no per-task event, so a list read
    // answered before the reorder landed would keep the old order until the next read.
    beginWrite();
    let answer: Partial<focusApi.FocusBarData> | null = null;
    try {
      const settle = patchTasksLocal(patches, { pending: true });
      const written = await heldWrite(settle, () => focusApi.reorderPinnedTasks(newIds));
      if (written.ok) answer = written.value;
      else showOperationError('Could not save task order. Please try again.');
    } finally {
      endWrite(answer);
    }
  }, [patchTasksLocal, showOperationError, beginWrite, endWrite]);

  const setTier = useCallback(async (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => {
    const patches: Record<string, Partial<Task>> = {
      [taskId]: { focus_tier: tierField(tier) },
    };
    if (newPinnedOrder) {
      newPinnedOrder.forEach((id, i) => {
        patches[id] = { ...(patches[id] ?? {}), pin_order: i };
      });
    }
    // Held over both requests: while held, the tier echo is laid under the local
    // value too, so the answer (or the pull) is what brings the server's own word in.
    beginWrite();
    let answer: Partial<focusApi.FocusBarData> | null = null;
    try {
      const settle = patchTasksLocal(patches, { pending: true });
      const written = await heldWrite(settle, async () => {
        // When reordering, persist order FIRST so the setTier response
        // (which includes pinned_tasks) reflects the correct position.
        if (newPinnedOrder) await focusApi.reorderPinnedTasks(newPinnedOrder);
        return focusApi.setTaskTier(taskId, tier);
      });
      if (written.ok) answer = written.value;
      else showOperationError('Could not move the task to that group. Please try again.');
    } finally {
      endWrite(answer);
    }
  }, [patchTasksLocal, showOperationError, beginWrite, endWrite]);

  const setTierBulk = useCallback(async (taskIds: string[], tier: FocusTier | null, onError?: (message: string, failedIds?: string[]) => void) => {
    if (taskIds.length === 0) return;
    const reportError = onError ?? showOperationError;
    const byId = new Map(tasksRef.current.map((t) => [t.id, t]));
    const orders = tasksRef.current.filter((t) => t.pinned).map((t) => t.pin_order ?? 0);
    let nextOrder = orders.length ? Math.max(...orders) + 1 : 0;
    const patches: Record<string, Partial<Task>> = {};
    for (const id of taskIds) {
      const task = byId.get(id);
      if (!task) continue;
      if (tier === null) {
        if (task.pinned) patches[id] = { pinned: false, focus_tier: undefined, pin_order: undefined };
        continue;
      }
      // Same rule as the server: an existing pin survives completion, a new one is refused.
      if (!task.pinned && (task.status === 'done' || task.phase === 'COMPLETE')) continue;
      patches[id] = task.pinned
        ? { focus_tier: tierField(tier) }
        : { pinned: true, pin_order: nextOrder++, focus_tier: tierField(tier) };
    }
    const ids = [...new Set(taskIds)];
    // The server echoes one task:updated per changed task; the answer (or the pull) is the truth.
    for (const id of ids) guardEcho(`update:${id}`);
    beginWrite();
    let answer: Partial<focusApi.FocusBarData> | null = null;
    try {
      const settle = patchTasksLocal(patches, { pending: true });
      const written = await heldWrite(settle, () => focusApi.setTierBulk(ids, tier));
      if (written.ok) {
        // The snapshot puts the failed rows back where the server kept them.
        const result = answer = written.value;
        if (result.failed.length > 0) {
          const failedIds = result.failed.map(f => f.id);
          const names = failedIds.map(id => byId.get(id)?.title ?? id).join(', ');
          reportError(`${result.failed.length} of ${ids.length} tasks could not be ${tier === null ? 'unpinned' : 'moved to that pin tier'}: ${names}.`, failedIds);
        }
        return;
      }
      // Put back at once each row nothing else changed since; the pull confirms it.
      const restore: Record<string, Partial<Task>> = {};
      for (const id of Object.keys(patches)) {
        const task = tasksRef.current.find((t) => t.id === id);
        const before = byId.get(id)!;
        if (task && Object.entries(patches[id]).every(([key, value]) => task[key as keyof Task] === value)) {
          restore[id] = Object.fromEntries(Object.keys(patches[id]).map(key => [key, before[key as keyof Task]]));
        }
      }
      patchTasksLocal(restore);
      reportError(tier === null ? 'Could not unpin those tasks. Please try again.' : 'Could not move those tasks to that pin tier. Please try again.');
    } finally {
      endWrite(answer);
    }
  }, [guardEcho, patchTasksLocal, showOperationError, beginWrite, endWrite]);

  // ── Optimistic local pin helpers (quick-add: show in tier before the create
  // round-trip returns a real id). Pure task patches; the create itself carries the
  // pin, so nothing here persists. ──

  const addLocalPin = useCallback((taskId: string, tier: FocusTier) => {
    // The quick-add counts as a write in flight until replaceLocalPinId or
    // removeLocalPin: no answer is applied while it is out, and a pull that follows
    // is sent after the create landed. That is what keeps the reconciled REAL id
    // from being unpinned by a snapshot read before the create (the temp id itself
    // is skipped by applyFocusData).
    lastWriteRef.current = Date.now();
    if (busy()) overlapped.current = true;
    // Append to the BOTTOM of its tier — the task stays exactly where the user
    // added it (the "+ Add to …" line is at the bottom), like Apple Reminders.
    const orders = tasksRef.current.filter((t) => t.pinned).map((t) => t.pin_order ?? 0);
    const maxOrder = orders.length ? Math.max(...orders) : 0;
    localPinsRef.current.set(taskId, { tier, order: maxOrder + 1, at: Date.now() });
    patchTasksLocal({ [taskId]: { pinned: true, pin_order: maxOrder + 1, focus_tier: tierField(tier) } });
  }, [patchTasksLocal]);

  const replaceLocalPinId = useCallback((tempId: string, realId: string) => {
    const entry = localPinsRef.current.get(tempId);
    localPinsRef.current.delete(tempId);
    if (!entry) return;
    // The temp task object is gone (create() swapped in the server task): re-apply
    // the pin state on the real id.
    try {
      patchTasksLocal({ [realId]: { pinned: true, pin_order: entry.order, focus_tier: tierField(entry.tier) } });
    } finally {
      endWrite('quiet', false);
    }
  }, [patchTasksLocal, endWrite]);

  const removeLocalPin = useCallback((taskId: string) => {
    const had = localPinsRef.current.delete(taskId);
    try {
      patchTasksLocal({ [taskId]: { pinned: false, focus_tier: undefined, pin_order: undefined } });
    } finally {
      if (had) endWrite('quiet', false);
    }
  }, [patchTasksLocal, endWrite]);

  const isPinned = useCallback((taskId: string) => pinnedIds.includes(taskId), [pinnedIds]);

  const tierOf = useCallback((taskId: string): FocusTier => {
    if (focusIds.includes(taskId)) return 'focus';
    if (waitIds.includes(taskId)) return 'wait';
    for (const [tierId, ids] of Object.entries(customTierIds)) {
      if (ids.includes(taskId)) return tierId;
    }
    return 'satellite';
  }, [focusIds, waitIds, customTierIds]);

  // Resolved Task arrays (identity follows `tasks` — consumers needing stability
  // should key on the ID arrays, as FocusBarContext's memo does).
  const focusTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'focus'), [orderedPinned]);
  const satelliteTasks = useMemo(() => orderedPinned.filter(isSatellite), [orderedPinned, isSatellite]);
  const waitTasks = useMemo(() => orderedPinned.filter((t) => t.focus_tier === 'wait'), [orderedPinned]);

  return {
    pinnedIds, pinnedTasks: orderedPinned,
    focusIds, satelliteIds, waitIds,
    focusTasks, satelliteTasks, waitTasks,
    customTiers, customTiersLoaded, customTierIds,
    pin, unpin, reorder, setTier, setTierBulk,
    addLocalPin, replaceLocalPinId, removeLocalPin,
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
