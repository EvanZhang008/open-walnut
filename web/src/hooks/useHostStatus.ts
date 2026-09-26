/**
 * Host connect status store: ONE browser-side truth for "where is host X in its
 * connect chain", shared by the folder picker's host tabs and step row, Settings ›
 * Remote hosts, and the notification System pane.
 *
 * Data flow: the server owns the phase machine and pushes `host:status` on every
 * transition. This module mirrors it: HTTP hydrate for the cold read, WS push for
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
import { checkHostReadiness, fetchHostStatus, type HostStatus } from '@/api/hosts';
import { blockingReadinessProblem } from '@open-walnut/host-problem';
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
/** Cached array for useAllHostStatus: useSyncExternalStore compares by identity,
 *  so a fresh array per read would loop forever. */
let allCache: HostStatus[] = [];
/** Hosts written by a push/seed while a hydrate was in flight: the hydrate must not drop them. */
const touchedDuringHydrate = new Set<string>();
/** Tombstones seen while a hydrate was in flight (host -> frame at): an older answer must not revive them. */
const removedDuringHydrate = new Map<string, number>();
/**
 * Recent tombstones (host -> frame at, and when the memory ends). A Retry or
 * Check again answered after the host was removed carries a frame built before
 * the removal: it must not bring the host back. A frame newer than the
 * tombstone (the host was added again) clears it.
 */
export const TOMBSTONE_MEMORY_MS = 30_000;
const tombstones = new Map<string, { at: number; until: number }>();

/** A remembered tombstone that outranks this (older) frame. */
function buriedBy(next: HostStatus): boolean {
  const t = tombstones.get(next.host);
  if (!t) return false;
  if (Date.now() > t.until) { tombstones.delete(next.host); return false; }
  if (typeof next.at === 'number' && next.at > t.at) { tombstones.delete(next.host); return false; }
  return true;
}
/** Server clock minus this browser's clock, from the latest frame (serverNow ?? at). */
let skewMs = 0;

/**
 * The server's clock as best this tab knows it. Every server time on a frame
 * (connectedAt, retryAt, attemptStartedAt) is compared against this, never
 * against Date.now(), so a laptop whose clock drifts does not show 'SSH · 8h'.
 */
export function serverNow(): number {
  return Date.now() + skewMs;
}

function noteClock(next: HostStatus): void {
  const t = typeof next.serverNow === 'number' ? next.serverNow : next.at;
  if (typeof t === 'number' && Number.isFinite(t)) skewMs = t - Date.now();
}

/**
 * Whether the store has EVER heard from the server. A host with no entry means two
 * very different things depending on this: "we have not asked yet" (show a
 * checking state, the answer is seconds away) versus "the server does not report
 * this host" (unknown for real). Settings mounts with dozens of other requests in
 * the browser's connection queue, so the first read can trail the first paint by
 * a couple of seconds: long enough for "Status unknown" to read as a verdict.
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
  if (!next.removed && buriedBy(next)) return false;
  if (hydrating) touchedDuringHydrate.add(next.host);
  if (next.removed) {
    // Tombstone: the host left the config (or was disabled). Every surface drops it.
    const at = typeof next.at === 'number' ? next.at : Number.MAX_SAFE_INTEGER;
    if (hydrating) removedDuringHydrate.set(next.host, at);
    tombstones.set(next.host, { at, until: Date.now() + TOMBSTONE_MEMORY_MS });
    if (!prev) return false;
    statuses.delete(next.host);
    rebuildAll();
    return true;
  }
  noteClock(next);
  statuses.set(next.host, next);
  rebuildAll();
  return true;
}

/**
 * A full answer REPLACES the map: a host the server no longer reports is gone
 * (its banner row, picker tab and Settings row with it). A frame pushed while
 * the request was in flight is kept when it is newer than the answer's.
 */
function replaceAll(hosts: HostStatus[]): boolean {
  const next = new Map<string, HostStatus>();
  for (const h of hosts) {
    if (!h || typeof h.host !== 'string' || !h.host || h.removed) continue;
    const removedAt = removedDuringHydrate.get(h.host);
    if (removedAt !== undefined && removedAt >= h.at) continue;
    if (buriedBy(h)) continue;
    const prev = statuses.get(h.host);
    const keepPrev = !!prev && touchedDuringHydrate.has(h.host) && typeof prev.at === 'number' && prev.at > h.at;
    next.set(h.host, keepPrev ? prev! : h);
    if (!keepPrev) noteClock(h);
  }
  for (const host of touchedDuringHydrate) {
    const prev = statuses.get(host);
    if (prev && !next.has(host)) next.set(host, prev);
  }
  touchedDuringHydrate.clear();
  removedDuringHydrate.clear();
  const changed = next.size !== statuses.size || Array.from(next).some(([k, v]) => statuses.get(k) !== v);
  if (!changed) return false;
  statuses.clear();
  for (const [k, v] of next) statuses.set(k, v);
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
      if (replaceAll(hosts)) notify();
      setHydration('done');
    })
    .catch((err) => {
      lastHydrateAt = Date.now();
      touchedDuringHydrate.clear();
      removedDuringHydrate.clear();
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

// Module scope, subscribed once: survives every component unmount, so a status
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
  installReadinessFocusRecheck();
  void hydrateHostStatus();
  return () => { listeners.delete(cb); };
}

/** A blocked host is re-checked at most this often by window focus. */
export const FOCUS_RECHECK_MIN_MS = 60_000;
const lastFocusRecheck = new Map<string, number>();
let focusRecheckInstalled = false;
const recheckQueue: string[] = [];
let recheckRunning = false;

/**
 * One focus re-check at a time, in the background lane. Each can take the
 * server's 15s deadline, and five blocked hosts asked at once as urgent POSTs
 * held five of the browser's six connections while the page repainted after
 * the focus. The answers also arrive as pushes, so nothing waits on this chain.
 */
function drainRechecks(): void {
  if (recheckRunning) return;
  const host = recheckQueue.shift();
  if (!host) return;
  recheckRunning = true;
  checkHostReadiness(host, { background: true })
    .then(seedHostStatus)
    .catch((err) => { log.warn('host-status', 'focus readiness recheck failed', { host, error: String(err) }); })
    .finally(() => { recheckRunning = false; drainRechecks(); });
}

/**
 * The user upgraded Claude Code in a terminal and came back: re-ask every host
 * that has a blocking readiness problem, so the banner and the Start gate move
 * without a trip to Settings. At most one ask per host per minute.
 */
export function recheckBlockedHosts(now: number = Date.now()): string[] {
  const asked: string[] = [];
  for (const s of statuses.values()) {
    if (!s.connected || !blockingReadinessProblem(s)) continue;
    const last = lastFocusRecheck.get(s.host);
    if (last !== undefined && now - last < FOCUS_RECHECK_MIN_MS) continue;
    lastFocusRecheck.set(s.host, now);
    asked.push(s.host);
    if (!recheckQueue.includes(s.host)) recheckQueue.push(s.host);
  }
  drainRechecks();
  return asked;
}

/** Installed once, on the first subscriber (never at import: tests and SSR have no window). */
export function installReadinessFocusRecheck(): void {
  if (focusRecheckInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  focusRecheckInstalled = true;
  window.addEventListener('focus', () => { recheckBlockedHosts(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheckBlockedHosts();
  });
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
 * Imperative write: the "Connect now" button's HTTP response. The WS push from
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
  skewMs = 0;
  touchedDuringHydrate.clear();
  removedDuringHydrate.clear();
  tombstones.clear();
  lastFocusRecheck.clear();
  recheckQueue.length = 0;
  recheckRunning = false;
  focusRecheckInstalled = false;
  notify();
  listeners.clear();
}
