/**
 * One browser, one copy of each host's Claude subscription limit readings.
 *
 * The server pushes one `host:subscription-limits` frame per host whenever a
 * session on it reports a reading; the frames land here keyed by host. A frame
 * never goes backwards (an older `updatedAt` is ignored). Hydration is a GET on
 * the first subscriber and on every WS reconnect (a push missed while away is
 * gone for good). Same shape as session-resources-store.ts.
 *
 * Each frame carries the server's clock; the store keeps the offset so a
 * browser on another device ages a reading by the server's clock, not its own.
 */
import { useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';
import { fetchSubscriptionLimits, type HostLimitFrame } from '@/api/subscription-limits';
import { log } from '@/utils/log';

export const LOCAL_LIMIT_HOST = '__local__';

let frames = new Map<string, HostLimitFrame>();
/** serverNow - Date.now() at the newest frame's arrival. */
let skewMs = 0;
let hydrated = false;
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function isFrame(x: unknown): x is HostLimitFrame {
  const f = x as HostLimitFrame | null;
  return !!f && typeof f.host === 'string' && !!f.host && typeof f.updatedAt === 'number'
    && !!f.windows && typeof f.windows === 'object';
}

/** The key a session record's `host` maps to (no host = this machine). */
export function limitHostKey(host: string | null | undefined): string {
  return host && host.trim() ? host.trim() : LOCAL_LIMIT_HOST;
}

/** Upsert one host's frame (a push or a read). Returns whether it changed anything. */
export function upsertLimitFrame(frame: unknown): boolean {
  if (!isFrame(frame)) return false;
  const prev = frames.get(frame.host);
  if (prev && prev.updatedAt > frame.updatedAt) return false;
  if (typeof frame.serverNow === 'number' && Number.isFinite(frame.serverNow)) skewMs = frame.serverNow - Date.now();
  // A new Map per change: the snapshot identity useSyncExternalStore compares.
  frames = new Map(frames).set(frame.host, frame);
  return true;
}

export async function hydrateSubscriptionLimits(force = false): Promise<void> {
  if (hydrating) return hydrating;
  if (hydrated && !force) return;
  hydrating = (async () => {
    try {
      const read = await fetchSubscriptionLimits();
      if (read) {
        let changed = false;
        for (const f of read) changed = upsertLimitFrame(f) || changed;
        if (changed) notify();
      }
      hydrated = true;
    } catch (err) {
      // An older server has no route (404): nothing to show, and nothing to retry.
      if ((err as { status?: number })?.status === 404) hydrated = true;
      else log.warn('subscription-limits', 'hydrate failed', { error: String(err) });
    } finally {
      hydrating = null;
    }
  })();
  return hydrating;
}

wsClient.onEvent('host:subscription-limits', (data: unknown) => {
  if (upsertLimitFrame(data)) notify();
});
wsClient.onEvent('_ws:reconnected', () => { void hydrateSubscriptionLimits(true); });

export function subscribeSubscriptionLimits(cb: () => void): () => void {
  listeners.add(cb);
  void hydrateSubscriptionLimits();
  return () => { listeners.delete(cb); };
}

export function getLimitFrame(host: string | null | undefined): HostLimitFrame | null {
  return frames.get(limitHostKey(host)) ?? null;
}

/** Date.now() on the server's clock. */
export function serverNow(): number {
  return Date.now() + skewMs;
}

/** One host's frame, or null when it never reported a reading. */
export function useHostLimitFrame(host: string | null | undefined): HostLimitFrame | null {
  return useSyncExternalStore(subscribeSubscriptionLimits, () => getLimitFrame(host), () => getLimitFrame(host));
}

/** Test seam: reset the module state. */
export function _resetSubscriptionLimitsStoreForTest(): void {
  frames = new Map();
  skewMs = 0;
  hydrated = false;
  hydrating = null;
}
