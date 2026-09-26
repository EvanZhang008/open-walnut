/**
 * Whether this page is served by a cloud replica: it cannot dial ssh or run a
 * fix, so Retry / Connect now / Update / Install are hidden there and Check
 * again relays to the Mac. One answer for every host surface (banner, picker,
 * Settings, the error bars), kept for the page's lifetime once the server gave it.
 *
 * Only a real answer is kept. A failed /api/config used to resolve `false`
 * through the facts fallback and was cached forever, so a replica page that
 * booted during a stall showed Retry buttons that could never work. The ask
 * retries on the registry schedule, and asks again when the socket comes back;
 * until an answer lands the hook reads false (the primary console keeps its buttons).
 */
import { useSyncExternalStore } from 'react';
import { fetchIsCloudReplica } from '@/api/config';
import { wsClient } from '@/api/ws';
import { fetchWithRetry } from '@/utils/fetch-retry';

let answer: boolean | null = null;
let loading = false;
let reconnectHooked = false;
const listeners = new Set<() => void>();

function load(): void {
  if (answer !== null || loading) return;
  loading = true;
  fetchWithRetry(() => fetchIsCloudReplica({ strict: true }), { subsystem: 'config', label: 'cloud replica flag' })
    .then((r) => {
      answer = r;
      for (const l of listeners) l();
    })
    .catch(() => { /* logged by fetchWithRetry; unknown until the socket comes back */ })
    .finally(() => { loading = false; });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!reconnectHooked) {
    reconnectHooked = true;
    // A socket that came back may be a new server (a deploy): ask again if we never got an answer.
    wsClient.onEvent('_ws:reconnected', () => { if (answer === null) load(); });
  }
  load();
  return () => { listeners.delete(cb); };
}

const snapshot = (): boolean => answer ?? false;

export function useIsCloudReplica(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test hook. */
export function __resetCloudReplicaForTests(): void {
  answer = null;
  loading = false;
  reconnectHooked = false;
  listeners.clear();
}
