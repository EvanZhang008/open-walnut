/**
 * Host connect status store — ONE browser-side truth for "where is host X in its
 * connect chain", shared by the folder picker's host tabs and step row, Settings ›
 * Remote hosts, and the notification System pane.
 *
 * Data flow: the server owns the phase machine and pushes `host:status` on every
 * transition. This module mirrors it — HTTP hydrate for the cold read, WS push for
 * every change, re-hydrate on reconnect. It deliberately does NOT poll: a phase
 * that lasts 40 seconds (installing the daemon runtime) would otherwise be paid
 * for by a request per second per surface.
 *
 * Two ordering rules the WS transport forces on us:
 *   - the server keeps no event buffer, so every event during a disconnect is lost
 *     for good → `_ws:reconnected` re-hydrates rather than assuming continuity;
 *   - frames can land out of order behind a re-hydrate, so an update older than
 *     the stored `at` for the same host is dropped instead of rewinding the UI.
 */
import { useSyncExternalStore } from 'react';
import { fetchHostStatus, type HostStatus } from '@/api/hosts';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';

/** Stale-while-revalidate window for the HTTP hydrate. */
const HYDRATE_TTL_MS = 15_000;

const statuses = new Map<string, HostStatus>();
const listeners = new Set<() => void>();
let lastHydrateAt = 0;
let hydrating: Promise<void> | null = null;
/** Set when the server answered 404: an older build (or a replica) has no such
 *  route, and re-asking every 15s for the life of the tab buys nothing. Cleared by
 *  a forced hydrate (post-reconnect, i.e. possibly post-deploy) or by any push. */
let unsupported = false;
/** Cached array for useAllHostStatus — useSyncExternalStore compares by identity,
 *  so a fresh array per read would loop forever. */
let allCache: HostStatus[] = [];

/**
 * Whether the store has EVER heard from the server. A host with no entry means two
 * very different things depending on this: "we have not asked yet" (show a
 * checking state, the answer is seconds away) versus "the server does not report
 * this host" (unknown for real). Settings mounts with dozens of other requests in
 * the browser's connection queue, so the first read can trail the first paint by
 * a couple of seconds — long enough for "Status unknown" to read as a verdict.
 */
export type HostStatusHydration = 'never' | 'pending' | 'done' | 'failed' | 'unsupported';
let hydration: HostStatusHydration = 'never';

function setHydration(next: HostStatusHydration): void {
  if (hydration === next) return;
  hydration = next;
  notify();
}

function rebuildAll(): void {
  allCache = Array.from(statuses.values());
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Apply one status, newest-wins per host. Returns true when the store changed.
 *
 * Equal `at` is treated as an update (a server that stamps two builds in the same
 * millisecond still gets its later fields applied); strictly older is dropped.
 */
function upsert(next: HostStatus | null | undefined): boolean {
  if (!next || typeof next.host !== 'string' || !next.host) return false;
  const prev = statuses.get(next.host);
  if (prev && typeof next.at === 'number' && typeof prev.at === 'number' && next.at < prev.at) {
    return false;
  }
  statuses.set(next.host, next);
  rebuildAll();
  return true;
}

/**
 * Pull every host's status over HTTP.
 *
 * TTL-guarded and in-flight-deduped: four surfaces can mount at once (picker
 * open + Settings + System pane + a host tab per host) and still cost one request.
 * `force` is for the reconnect path, where the cache is known to be a lie.
 */
export function hydrateHostStatus(opts?: { force?: boolean }): Promise<void> {
  if (opts?.force) unsupported = false;
  else if (unsupported) return Promise.resolve();
  if (!opts?.force && Date.now() - lastHydrateAt < HYDRATE_TTL_MS) return Promise.resolve();
  if (hydrating) return hydrating;
  // Only the first read is a "checking" state for the UI; a re-read after a
  // successful one keeps showing the last answer (stale-while-revalidate).
  if (hydration !== 'done') setHydration('pending');
  hydrating = fetchHostStatus()
    .then((hosts) => {
      lastHydrateAt = Date.now();
      let changed = false;
      for (const h of hosts) changed = upsert(h) || changed;
      if (changed) notify();
      setHydration('done');
    })
    .catch((err) => {
      lastHydrateAt = Date.now();
      if ((err as { status?: unknown } | null)?.status === 404) {
        unsupported = true;
        setHydration('unsupported');
        log.info('host-status', 'server has no /api/hosts/status route: falling back to list-dirs polling');
        return;
      }
      setHydration('failed');
      log.warn('host-status', 'hydrate failed', { error: String(err) });
    })
    .finally(() => { hydrating = null; });
  return hydrating;
}

/** Has the store heard from the server yet (and how did that go)? */
export function getHostStatusHydration(): HostStatusHydration {
  return hydration;
}

export function useHostStatusHydration(): HostStatusHydration {
  return useSyncExternalStore(subscribeHostStatus, getHostStatusHydration);
}

// Module scope, subscribed once — survives every component unmount, so a status
// that changes while the picker is closed is already correct when it reopens.
// Whether this connection has EVER delivered a host:status push. A hydrated
// status alone is not evidence that pushes will follow: a cloud replica answers
// the GET but has no phase machine to push from.
let pushSeen = false;

wsClient.onEvent('host:status', (data: unknown) => {
  if (!upsert(data as HostStatus)) return;
  pushSeen = true;
  // A push is proof the server speaks this protocol, so a 404 we saw earlier was
  // a different build (or a race with a deploy): allow hydrating again.
  unsupported = false;
  hydration = 'done';
  notify();
});

/** True once at least one host:status push has arrived on this socket. */
export function hasSeenHostStatusPush(): boolean {
  return pushSeen;
}

// Events during a disconnect are gone for good (no server-side replay), so the
// only honest recovery is a fresh read.
wsClient.onEvent('_ws:reconnected', () => { void hydrateHostStatus({ force: true }); });

/**
 * Subscribe to any change. Also kicks a TTL-guarded hydrate so a surface that
 * only reads (a host tab dot) doesn't have to remember to fetch.
 */
export function subscribeHostStatus(cb: () => void): () => void {
  listeners.add(cb);
  void hydrateHostStatus();
  return () => { listeners.delete(cb); };
}

/** Imperative read for non-hook call sites (useLiveDirs' effect body). */
export function getHostStatus(host: string): HostStatus | undefined {
  return statuses.get(host);
}

/** Imperative read of every known host. */
export function getAllHostStatus(): HostStatus[] {
  return allCache;
}

/** Live status for one host. undefined = the server never reported this host. */
export function useHostStatus(host: string | null | undefined): HostStatus | undefined {
  return useSyncExternalStore(
    subscribeHostStatus,
    () => (host ? statuses.get(host) : undefined),
  );
}

/** Live status for every host, in first-seen order (never reshuffles on update). */
export function useAllHostStatus(): HostStatus[] {
  return useSyncExternalStore(subscribeHostStatus, getAllHostStatus);
}

/**
 * Imperative write — the "Connect now" button's HTTP response. The WS push from
 * the same server-side transition also arrives; `at` ordering makes whichever
 * lands second a no-op.
 */
export function seedHostStatus(status: HostStatus | null | undefined): void {
  if (upsert(status)) notify();
}

/** Test hook. */
export function __resetHostStatusForTests(): void {
  statuses.clear();
  allCache = [];
  lastHydrateAt = 0;
  hydrating = null;
  unsupported = false;
  hydration = 'never';
  pushSeen = false;
  notify();
  listeners.clear();
}
