/**
 * Routines store — ONE in-browser truth for the routine list.
 *
 * The homepage routines panel and /routines are mounted at the same time
 * (MainPage never unmounts), so a private `useState` copy per mount meant every
 * cron tick fetched the whole list twice and the enable/disable switch didn't
 * move until the round-trip plus the `cron:job-*` broadcast came back. Writes now
 * patch the shared list first and roll back on failure; the events only confirm.
 *
 * The store always fetches the FULL list (disabled included) — one request serves
 * both a caller that wants everything and one that wants only enabled routines.
 */
import * as api from '@/api/routines';
import type { CreateRoutineInput, Routine, UpdateRoutineInput } from '@/api/routines';
import { log } from '@/utils/log';

/** Coalesce a burst of cron events (each mount hears every one of them). */
const REFRESH_DEBOUNCE_MS = 150;

export interface RoutinesSnapshot {
  routines: Routine[];
  loading: boolean;
  error: string | null;
}

let snapshot: RoutinesSnapshot = { routines: [], loading: true, error: null };
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;
let wantsRefetch = false;
let loaded = false;
let writesInFlight = 0;
let pendingRefetch = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let provisionalSeq = 0;

function emit(): void {
  for (const fn of [...subscribers]) fn();
}

function setSnapshot(patch: Partial<RoutinesSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

export function subscribeRoutines(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function getRoutinesSnapshot(): RoutinesSnapshot {
  return snapshot;
}

/**
 * Fetch the list. Concurrent callers share the request; a force that lands
 * mid-flight queues exactly one fresh response behind it.
 */
export function loadRoutines(force = false): Promise<void> {
  if (inflight) {
    if (force) wantsRefetch = true;
    return inflight;
  }
  if (!force && loaded) return Promise.resolve();
  inflight = (async () => {
    try {
      do {
        wantsRefetch = false;
        const routines = await api.fetchRoutines(true);
        loaded = true;
        setSnapshot({ routines, loading: false, error: null });
      } while (wantsRefetch);
    } catch (err) {
      wantsRefetch = false;
      loaded = true;
      setSnapshot({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function settleWrite(): void {
  writesInFlight -= 1;
  if (writesInFlight <= 0) {
    writesInFlight = 0;
    if (pendingRefetch) {
      pendingRefetch = false;
      void loadRoutines(true);
    }
  }
}

/** A `cron:job-*` push (a tick finished, another client edited a routine). */
export function onRoutinesChanged(): void {
  if (writesInFlight > 0) { pendingRefetch = true; return; }
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadRoutines(true);
  }, REFRESH_DEBOUNCE_MS);
}

function patchRoutine(id: string, patch: Partial<Routine>): void {
  if (!snapshot.routines.some((r) => r.id === id)) return;
  setSnapshot({ routines: snapshot.routines.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
}

function replaceRoutine(next: Routine): void {
  setSnapshot({
    routines: snapshot.routines.some((r) => r.id === next.id)
      ? snapshot.routines.map((r) => (r.id === next.id ? next : r))
      : [...snapshot.routines, next],
  });
}

function replaceRoutineId(id: string, next: Routine): void {
  setSnapshot({ routines: snapshot.routines.map((r) => (r.id === id ? next : r)) });
}

function dropRoutine(id: string): void {
  setSnapshot({ routines: snapshot.routines.filter((r) => r.id !== id) });
}

/** Put a removed/changed row back exactly where it was. */
function restoreRoutine(before: Routine, index: number): void {
  if (snapshot.routines.some((r) => r.id === before.id)) {
    setSnapshot({ routines: snapshot.routines.map((r) => (r.id === before.id ? before : r)) });
    return;
  }
  const routines = [...snapshot.routines];
  routines.splice(Math.min(index, routines.length), 0, before);
  setSnapshot({ routines });
}

export async function toggleRoutine(id: string): Promise<Routine> {
  const index = snapshot.routines.findIndex((r) => r.id === id);
  const before = index === -1 ? null : snapshot.routines[index];
  if (before) patchRoutine(id, { enabled: !before.enabled });
  writesInFlight += 1;
  try {
    const job = await api.toggleRoutine(id);
    replaceRoutine(job);
    return job;
  } catch (err) {
    log.warn('routines', 'toggle failed, rolling back', { id, error: String(err).slice(0, 200) });
    if (before) restoreRoutine(before, index);
    throw err;
  } finally {
    settleWrite();
  }
}

export async function createRoutine(input: CreateRoutineInput): Promise<Routine> {
  provisionalSeq += 1;
  const pending = provisionalRoutine(`pending-${provisionalSeq}`, input);
  setSnapshot({ routines: [...snapshot.routines, pending] });
  writesInFlight += 1;
  try {
    const job = await api.createRoutine(input);
    replaceRoutineId(pending.id, job);
    return job;
  } catch (err) {
    dropRoutine(pending.id);
    throw err;
  } finally {
    settleWrite();
  }
}

export async function updateRoutine(id: string, input: UpdateRoutineInput): Promise<Routine> {
  const index = snapshot.routines.findIndex((r) => r.id === id);
  const before = index === -1 ? null : snapshot.routines[index];
  if (before) patchRoutine(id, input as Partial<Routine>);
  writesInFlight += 1;
  try {
    const job = await api.updateRoutine(id, input);
    replaceRoutine(job);
    return job;
  } catch (err) {
    log.warn('routines', 'update failed, rolling back', { id, error: String(err).slice(0, 200) });
    if (before) restoreRoutine(before, index);
    throw err;
  } finally {
    settleWrite();
  }
}

export async function removeRoutine(id: string): Promise<void> {
  const index = snapshot.routines.findIndex((r) => r.id === id);
  const before = index === -1 ? null : snapshot.routines[index];
  dropRoutine(id);
  writesInFlight += 1;
  try {
    await api.deleteRoutine(id);
  } catch (err) {
    log.warn('routines', 'delete failed, rolling back', { id, error: String(err).slice(0, 200) });
    if (before) restoreRoutine(before, index);
    throw err;
  } finally {
    settleWrite();
  }
}

/** Run one now. The `cron:job-started` / `-finished` pushes carry the result. */
export async function runRoutineNow(id: string): Promise<unknown> {
  writesInFlight += 1;
  try {
    return await api.runRoutine(id);
  } finally {
    settleWrite();
  }
}

/** A row the user can see while the POST is still in flight. */
function provisionalRoutine(id: string, input: CreateRoutineInput): Routine {
  const now = Date.now();
  return {
    id,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    enabled: input.enabled ?? true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: input.schedule,
    wakeMode: input.wakeMode ?? 'now',
    executor: input.executor,
    state: {},
  };
}

/** Tests only: forget everything the store learned. */
export function __resetRoutinesStore(): void {
  snapshot = { routines: [], loading: true, error: null };
  subscribers.clear();
  inflight = null;
  wantsRefetch = false;
  loaded = false;
  writesInFlight = 0;
  pendingRefetch = false;
  provisionalSeq = 0;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}
