/**
 * Plugin apps for the sidebar + the `/apps/:appId` page.
 *
 * Module-level cache with a subscriber set (same shape as useIntegrations, but
 * refreshable): the sidebar mounts once per page and the app page mounts on
 * every navigation, so a per-hook fetch would re-hit `/api/apps` constantly.
 * One fetch fills the cache and every live subscriber gets the same array.
 *
 * A failed fetch resolves to an EMPTY list on purpose. The sidebar is chrome
 * around the whole product: a plugin catalogue that 500s must show no apps, not
 * an error banner in the primary navigation. It is retried first (a boot-time
 * answer lost to a stalled server used to leave the sidebar empty until a
 * reload), and a list that is empty BECAUSE of a failure is asked for again
 * when the socket comes back.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchApps, type PluginApp } from '@/api/apps';
import { wsClient } from '@/api/ws';
import { PLUGINS_CHANGED_EVENT } from '@/utils/plugin-events';
import { fetchWithRetry } from '@/utils/fetch-retry';

let cache: PluginApp[] | null = null;
let inFlight: Promise<void> | null = null;
let requestedLoad = 0;
let completedLoad = 0;
let lastError: string | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Fetch once; a forced change during a fetch queues one fresh response behind it. */
function load(force: boolean): Promise<void> {
  if (!force && cache !== null) return Promise.resolve();
  if (inFlight) {
    if (force) requestedLoad++;
    return inFlight;
  }

  requestedLoad++;
  inFlight = (async () => {
    try {
      while (completedLoad < requestedLoad) {
        const targetLoad = requestedLoad;
        try {
          cache = await fetchWithRetry(() => fetchApps(), {
            subsystem: 'apps',
            label: 'plugin app catalogue',
            // Degrade on the FIRST failure: the empty catalogue is the designed
            // answer for a broken fetch, and the app host page shows a spinner
            // until the first notify. Holding it for the whole schedule (up to
            // ~30s, ~105s against a hung server) would turn a 15s wait into a
            // minute-long blank page. The retries go on behind it and a success
            // replaces the list.
            onFailure: (err, { willRetry }) => {
              if (!willRetry || cache !== null) return;
              cache = [];
              lastError = err instanceof Error ? err.message : String(err);
              notify();
            },
          });
          lastError = null;
        } catch (err: unknown) {
          // Empty catalogue, not a broken sidebar. (fetchWithRetry logged it.)
          cache = [];
          lastError = err instanceof Error ? err.message : String(err);
        }
        completedLoad = targetLoad;
        notify();
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function refreshAppsCatalogue(): Promise<void> {
  return load(true);
}

// An empty list that stands in for a FAILED answer is not a verdict: the
// socket coming back is the one signal the server is reachable again.
wsClient.onEvent('_ws:reconnected', () => {
  if (lastError !== null) void load(true);
});

export interface UseAppsReturn {
  apps: PluginApp[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useApps(): UseAppsReturn {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    const onChange = () => {
      setLoading(false);
      bump((n) => n + 1);
    };
    subscribers.add(onChange);
    // A plugin was added/removed/reconfigured in Settings — the app list moved.
    const onPluginsChanged = () => {
      setLoading(cache === null);
      void load(true);
    };
    window.addEventListener(PLUGINS_CHANGED_EVENT, onPluginsChanged);
    if (cache === null) void load(false);
    else setLoading(false);
    return () => {
      subscribers.delete(onChange);
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onPluginsChanged);
    };
  }, []);

  const refresh = useCallback(() => {
    setLoading(cache === null);
    void load(true);
  }, []);

  return { apps: cache ?? [], loading, error: lastError, refresh };
}

/** Test hook: observe the cache the way the hook's effect does. */
export function __subscribeAppsForTests(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/** Test hook — drops the module cache so a fresh fetch happens. */
export function __resetAppsCache(): void {
  cache = null;
  inFlight = null;
  requestedLoad = 0;
  completedLoad = 0;
  lastError = null;
}
