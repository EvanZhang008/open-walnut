/**
 * One browser, one copy of what every session costs its machine.
 *
 * The server pushes one `session:resources` frame per host whenever its sampler
 * ticks (every 30s on its own, every 5s while a Machine readout is open); the
 * frames land here, keyed by host, with an index from session id to its row so
 * a column header can read its own session in O(1). Hydration is a GET on the
 * first subscriber and on every WS reconnect (a push missed during a disconnect
 * is gone for good). Same shape as the host status store.
 */
import { useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';
import { fetchResources, rowSessionId, type HostResourceFrame, type SessionResourceRow } from '@/api/resources';

/** Why there is no readout at all (vs a host with no reading). */
export type ResourcesAvailability = 'unknown' | 'available' | 'unsupported' | 'off';

let frames = new Map<string, HostResourceFrame>();
let bySid = new Map<string, { host: string; row: SessionResourceRow }>();
let availability: ResourcesAvailability = 'unknown';
let hydrated = false;
let hydrating: Promise<void> | null = null;
/** What the read in flight asked for: a stronger ask waits for it and then asks again. */
let hydratingOpts: HydrateOpts = {};
let hydratedAt = 0;
const listeners = new Set<() => void>();
/** Snapshot identity for useSyncExternalStore: a new array per change, stable between. */
let frameList: HostResourceFrame[] = [];

const HYDRATE_TTL_MS = 20_000;

function notify(): void {
  frameList = Array.from(frames.values()).sort((a, b) => (a.host === '__local__' ? -1 : b.host === '__local__' ? 1 : a.host.localeCompare(b.host)));
  for (const fn of listeners) fn();
}

function reindex(): void {
  const next = new Map<string, { host: string; row: SessionResourceRow }>();
  for (const f of frames.values()) for (const row of f.sessions) next.set(rowSessionId(row), { host: f.host, row });
  bySid = next;
}

/** Same cap as the server's history. */
const HISTORY_POINTS = 60;

/**
 * A pushed frame carries no history: keep the one an earlier read brought and
 * extend it with this sample, so a sparkline keeps moving between reads.
 */
function carryHistory(prev: HostResourceFrame | undefined, frame: HostResourceFrame): HostResourceFrame {
  if (!prev) return frame;
  const before = new Map(prev.sessions.map((s) => [s.sid, s.history]));
  let carried = false;
  const sessions = frame.sessions.map((s) => {
    const h = before.get(s.sid);
    if (s.history || !h || h.length === 0) return s;
    carried = true;
    const last = h[h.length - 1];
    // A stale frame repeats old rows: no new point.
    const history = last.at >= frame.at || frame.stale ? h : [...h, { at: frame.at, rssBytes: s.rssBytes, cpuPct: s.cpuPct }].slice(-HISTORY_POINTS);
    return { ...s, history };
  });
  return carried ? { ...frame, sessions } : frame;
}

function isFrame(x: unknown): x is HostResourceFrame {
  const f = x as HostResourceFrame | null;
  return !!f && typeof f.host === 'string' && typeof f.at === 'number' && Array.isArray(f.sessions);
}

/**
 * Upsert one host's frame (a push or a read). Older frames never overwrite
 * newer ones, but an older READ still lends its history to the newer push that
 * has none (several windows can be asking, so a push can overtake a read).
 */
export function upsertResourceFrame(frame: HostResourceFrame): boolean {
  if (!isFrame(frame)) return false;
  const prev = frames.get(frame.host);
  if (prev && prev.at > frame.at) {
    const lent = carryHistory(frame, prev);
    if (lent === prev) return false;
    frames.set(frame.host, lent);
    reindex();
    return true;
  }
  frames.set(frame.host, carryHistory(prev, frame));
  reindex();
  return true;
}

function applyRead(read: Awaited<ReturnType<typeof fetchResources>>): void {
  if (read === null) {
    availability = 'off';
    frames = new Map();
    reindex();
    return;
  }
  availability = 'available';
  const seen = new Set<string>();
  for (const f of read.hosts) { upsertResourceFrame(f); seen.add(f.host); }
  // A host that left the pool is gone from the read: drop its stale frame.
  for (const key of Array.from(frames.keys())) if (!seen.has(key)) frames.delete(key);
  reindex();
}

export interface HydrateOpts {
  /** Sample now (a reading younger than 1.5s is reused). */
  fresh?: boolean;
  /** Attach each session's recent points (the sparklines). */
  history?: boolean;
  /** The Machine readout is open: the hosts sample fast for a minute. */
  watch?: boolean;
  /** Skip the TTL (a reconnect). */
  force?: boolean;
}

/** Does a read asked with `have` answer an ask with `want`? */
function covers(have: HydrateOpts, want: HydrateOpts): boolean {
  return (!want.fresh || !!have.fresh) && (!want.history || !!have.history) && (!want.watch || !!have.watch);
}

/**
 * Read the frames. A caller whose ask the read in flight already covers shares
 * it; a stronger one (fresh, history, or watch the read in flight lacks) waits
 * for it and then asks for itself, so the readout opening during the page's
 * first plain read still gets its sparklines and its fast cadence. A plain
 * hydrate within the TTL is skipped.
 */
export async function hydrateResources(opts: HydrateOpts = {}): Promise<void> {
  if (hydrating) {
    if (covers(hydratingOpts, opts)) return hydrating;
    return hydrating.then(() => hydrateResources({ ...opts, force: true }));
  }
  const plain = !opts.fresh && !opts.history && !opts.watch && !opts.force;
  if (plain && hydrated && Date.now() - hydratedAt < HYDRATE_TTL_MS) return;
  hydratingOpts = opts;
  hydrating = (async () => {
    try {
      const read = await fetchResources({ fresh: opts.fresh, history: opts.history, watch: opts.watch });
      applyRead(read);
      hydrated = true;
      hydratedAt = Date.now();
    } catch (err) {
      // An older server has no route: say so once, and stop asking.
      if ((err as { status?: number })?.status === 404) availability = 'unsupported';
    } finally {
      hydrating = null;
      notify();
    }
  })();
  return hydrating;
}

wsClient.onEvent('session:resources', (data: unknown) => {
  if (!upsertResourceFrame(data as HostResourceFrame)) return;
  availability = 'available';
  notify();
});
wsClient.onEvent('_ws:reconnected', () => { void hydrateResources({ force: true }); });

export function subscribeResources(cb: () => void): () => void {
  listeners.add(cb);
  void hydrateResources();
  return () => { listeners.delete(cb); };
}

export function getResourceFrames(): HostResourceFrame[] {
  return frameList;
}

export function getResourcesAvailability(): ResourcesAvailability {
  return availability;
}

export function getSessionResourceRow(sid: string | undefined): { host: string; row: SessionResourceRow } | null {
  if (!sid) return null;
  return bySid.get(sid) ?? null;
}

/** Every host's last frame, local first. */
export function useResourceFrames(): HostResourceFrame[] {
  return useSyncExternalStore(subscribeResources, getResourceFrames, getResourceFrames);
}

export function useResourcesAvailability(): ResourcesAvailability {
  return useSyncExternalStore(subscribeResources, getResourcesAvailability, getResourcesAvailability);
}

/** One session's latest row (by Walnut session id), or null when no host reports it. */
export function useSessionResources(sid: string | undefined): SessionResourceRow | null {
  const hit = useSyncExternalStore(subscribeResources, () => getSessionResourceRow(sid), () => getSessionResourceRow(sid));
  return hit?.row ?? null;
}

/** Test seam: reset the module state. */
export function _resetResourcesStoreForTest(): void {
  frames = new Map();
  bySid = new Map();
  availability = 'unknown';
  hydrated = false;
  hydrating = null;
  hydratingOpts = {};
  hydratedAt = 0;
  frameList = [];
}
