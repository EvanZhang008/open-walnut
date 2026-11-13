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
/** Jobs named by pushes during a list read: read one by one once it lands. */
let flushAfterLoad = false;
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
        // This read covers every change named before it started.
        changed = new Map();
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
      if (flushAfterLoad) {
        flushAfterLoad = false;
        // A list that failed stays for the next push, which reads it whole anyway.
        if (!snapshot.error) flushChanges();
      }
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
      flushChanges();
    }
  }
}

/** The fields of a `cron:job-*` push the store reads. */
export interface RoutineChange { action?: string; jobId?: string }

/** Past this many changed jobs (distinct ids) in one burst, one list fetch is cheaper than one fetch each. */
const PER_JOB_LIMIT = 20;
/** Jobs a burst changed, with the last action each had; `null` = refetch the whole list. */
let changed: Map<string, string> | null = new Map();

/**
 * A `cron:job-*` push (a tick finished, another client edited a routine). One that names its job
 * reads that job alone: every quiet trigger check sends one, and refetching the whole list (1.2 MB
 * for 182 routines) on each was about 95% of the JSON the page parsed, 15 to 40 MB a minute, the
 * floor and most of the swing of the Mac app's 2 GB page (2026-11-09). A push with no job id,
 * or a burst over PER_JOB_LIMIT, still refetches the list.
 */
export function onRoutinesChanged(change?: RoutineChange): void {
  const jobId = typeof change?.jobId === 'string' && change.jobId ? change.jobId : null;
  if (changed && jobId) changed.set(jobId, change?.action ?? 'updated');
  else changed = null;
  if (writesInFlight > 0) { pendingRefetch = true; return; }
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    flushChanges();
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * The socket came back: the server replays no push it sent meanwhile, so a routine added or removed
 * then is named by no later push. One list fetch heals it.
 */
export function onRoutinesStale(): void {
  changed = null;
  onRoutinesChanged();
}

function takeChanges(): Map<string, string> | null {
  const taken = changed;
  changed = new Map();
  return taken;
}

function flushChanges(): void {
  // During a list read, a push that names its job waits for the list and is then read on its own:
  // queueing another whole list behind it (1.5 MB) for every push of a busy minute was the
  // page's largest read left after the per-job reads (2026-11-10, the page memory soak).
  if (inflight && changed && changed.size <= PER_JOB_LIMIT) { flushAfterLoad = true; return; }
  const taken = takeChanges();
  // A list that never loaded (or failed to) is fetched whole: one row at a time would build a partial list.
  if (!taken || !loaded || snapshot.error || inflight || taken.size > PER_JOB_LIMIT) { void loadRoutines(true); return; }
  for (const [id, action] of taken) void refreshOne(id, action);
}

/** The newest read of each job: an older answer that lands after it is dropped. */
const readSeq = new Map<string, number>();

/** Read one job and put it in place; an unchanged job keeps its object, so nothing re-renders. */
async function refreshOne(id: string, action: string): Promise<void> {
  const seq = (readSeq.get(id) ?? 0) + 1;
  readSeq.set(id, seq);
  if (action === 'removed') { dropRoutine(id); return; }
  try {
    const job = await api.fetchRoutine(id);
    if (readSeq.get(id) !== seq) return;
    if (writesInFlight > 0) { onRoutinesChanged({ action, jobId: id }); return; }
    const current = snapshot.routines.find((r) => r.id === id);
    if (current && JSON.stringify(current) === JSON.stringify(job)) return;
    replaceRoutine(job);
  } catch (err) {
    if (readSeq.get(id) !== seq) return;
    // A 404 for a job just added may be a copy (the companion's) that has not caught up yet.
    if ((err as { status?: number })?.status === 404 && action !== 'added') { dropRoutine(id); return; }
    void loadRoutines(true);
  }
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
  if (!snapshot.routines.some((r) => r.id === id)) return;
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

/** The optimistic half of switching a routine on or off: off is a pause, stamped now. */
function switchedPatch(before: Routine, enabled: boolean): Partial<Routine> {
  return { enabled, state: { ...before.state, pausedAtMs: enabled ? undefined : Date.now() } };
}

export async function toggleRoutine(id: string): Promise<Routine> {
  const index = snapshot.routines.findIndex((r) => r.id === id);
  const before = index === -1 ? null : snapshot.routines[index];
  if (before) patchRoutine(id, switchedPatch(before, !before.enabled));
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

/**
 * Pause or Resume: sets the state asked for rather than flipping it, so a card
 * that is a moment stale (an agent paused it meanwhile) cannot turn a Pause
 * into a Resume. Setting the state it already has is a no-op on the server.
 */
/**
 * The switch writes of one routine, one at a time in click order (2026-11-04, a review:
 * pause then resume fast, the pause's request held up, and the server applied it last,
 * so the routine ended paused against the last click). Only the newest write's answer
 * is shown; an older one's would undo the switch the person already moved.
 */
const switchChains = new Map<string, { tail: Promise<unknown>; seq: number }>();

export async function setRoutineEnabled(id: string, enabled: boolean): Promise<Routine> {
  const index = snapshot.routines.findIndex((r) => r.id === id);
  const before = index === -1 ? null : snapshot.routines[index];
  if (before && before.enabled !== enabled) patchRoutine(id, switchedPatch(before, enabled));
  const chain = switchChains.get(id) ?? { tail: Promise.resolve(), seq: 0 };
  const seq = ++chain.seq;
  const write = chain.tail.catch(() => undefined).then(() => api.updateRoutine(id, { enabled }));
  chain.tail = write;
  switchChains.set(id, chain);
  const newest = () => switchChains.get(id)?.seq === seq;
  writesInFlight += 1;
  try {
    const job = await write;
    if (newest()) replaceRoutine(job);
    // A resumed trigger's next check is its daemon's to report, a moment later: read it
    // again then, so the row says when without a reload (2026-11-05, a review).
    if (enabled && job.enabled && job.state.nextRunAtMs === undefined) {
      for (const ms of [3_000, 10_000]) setTimeout(() => onRoutinesChanged({ jobId: id, action: 'updated' }), ms);
    }
    return job;
  } catch (err) {
    log.warn('routines', 'pause/resume failed, rolling back', { id, enabled, error: String(err).slice(0, 200) });
    // A newer click is queued behind this one: its answer decides the row.
    if (before && newest()) restoreRoutine(before, index);
    throw err;
  } finally {
    if (newest()) switchChains.delete(id);
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
export async function runRoutineNow(id: string, catchUpMs?: number): Promise<unknown> {
  writesInFlight += 1;
  try {
    return await api.runRoutine(id, catchUpMs);
  } finally {
    settleWrite();
  }
}

/** Set a missed run aside; the card drops it at once. */
export async function dismissRoutineMissedRun(id: string, slotMs: number): Promise<Routine> {
  writesInFlight += 1;
  try {
    const job = await api.dismissMissedRun(id, slotMs);
    replaceRoutine(job);
    return job;
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
  flushAfterLoad = false;
  loaded = false;
  writesInFlight = 0;
  pendingRefetch = false;
  changed = new Map();
  readSeq.clear();
  provisionalSeq = 0;
  switchChains.clear();
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}
