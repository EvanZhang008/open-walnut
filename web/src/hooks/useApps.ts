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
 * an error banner in the primary navigation.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchApps, type PluginApp } from '@/api/apps';
import { PLUGINS_CHANGED_EVENT } from '@/utils/plugin-events';
import { log } from '@/utils/log';

let cache: PluginApp[] | null = null;
let inFlight: Promise<void> | null = null;
let lastError: string | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Fetch once; concurrent callers share the in-flight promise. */
function load(force: boolean): Promise<void> {
  if (!force && cache !== null) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = fetchApps()
    .then((apps) => {
      cache = apps;
      lastError = null;
    })
    .catch((err: unknown) => {
      // Empty catalogue, not a broken sidebar.
      cache = [];
      lastError = err instanceof Error ? err.message : String(err);
      log.warn('apps', 'failed to load plugin apps', { error: lastError });
    })
    .finally(() => {
      inFlight = null;
      notify();
    });
  return inFlight;
}

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

/** Test hook — drops the module cache so a fresh fetch happens. */
export function __resetAppsCache(): void {
  cache = null;
  inFlight = null;
  lastError = null;
}
