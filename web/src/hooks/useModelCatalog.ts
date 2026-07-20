/**
 * Model-catalog data layer — the ONE browser-side source for "which models can
 * a session on host X select".
 *
 * Data flow (server side): every CLI list_models fetch (eager on session init,
 * refetch on invalidation) → `session:model-catalog` WS broadcast + host-level
 * persisted store. This module mirrors that: a module-level per-host cache,
 * seeded from localStorage (instant first paint), hydrated from
 * GET /api/sessions/host-model-catalogs, and kept fresh by the WS event.
 *
 * The catalog is a HOST property (pure function of host + settings.json), so
 * per-session pickers and the pre-session quick-start dropdown share this
 * cache — same rows, same shape, no static-registry flash.
 */
import { useSyncExternalStore } from 'react';
import type { SessionModelCatalogEntry } from '@open-walnut/core';
import { apiGet } from '@/api/client';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';

export const LOCAL_HOST_KEY = '__local__';
const STORAGE_KEY = 'walnut.hostModelCatalogs.v1';

export interface HostCatalogEntry {
  models: SessionModelCatalogEntry[];
  fetchedAt: string;
}

type CatalogMap = Record<string, HostCatalogEntry>;

// ── module-level store (shared across every component instance) ──
let catalogs: CatalogMap = loadFromStorage();
const listeners = new Set<() => void>();
// Stale-while-revalidate: cached rows render instantly, but every subscriber
// mount re-pulls the server store when the last pull is older than this. A
// long-lived SPA tab otherwise never re-hydrates and can miss WS pushes that
// fired while it was disconnected/asleep — the exact "I updated my settings
// ages ago, why is this dropdown still old" failure.
const HYDRATE_TTL_MS = 30_000;
let lastHydrateAt = 0;
let hydrating: Promise<void> | null = null;

function loadFromStorage(): CatalogMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CatalogMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(catalogs));
  } catch { /* quota/private mode — cache stays in-memory */ }
}

function notify(): void {
  for (const l of listeners) l();
}

function upsert(host: string, entry: HostCatalogEntry): void {
  const prev = catalogs[host];
  // Shallow-diff: identical rows → skip the update entirely so subscribed
  // components don't re-render (the common case — catalogs rarely change).
  if (prev && prev.models.length === entry.models.length
    && JSON.stringify(prev.models) === JSON.stringify(entry.models)) {
    return;
  }
  catalogs = { ...catalogs, [host]: entry };
  persist();
  notify();
}

/** Normalize a UI host value ('' / undefined / alias) to a catalog key. */
export function hostKey(host?: string | null): string {
  return host && host.trim() ? host : LOCAL_HOST_KEY;
}

async function hydrate(): Promise<void> {
  if (Date.now() - lastHydrateAt < HYDRATE_TTL_MS) return;
  if (!hydrating) {
    hydrating = apiGet<{ catalogs: CatalogMap }>('/api/sessions/host-model-catalogs')
      .then((res) => {
        lastHydrateAt = Date.now();
        for (const [host, entry] of Object.entries(res.catalogs ?? {})) {
          if (entry?.models?.length) upsert(host, { models: entry.models, fetchedAt: entry.fetchedAt });
        }
      })
      .catch((err) => {
        log.warn('model-catalog', 'host catalog hydrate failed', { error: String(err) });
      })
      .finally(() => { hydrating = null; });
  }
  return hydrating;
}

// WS keeps the cache fresh: the server broadcasts on every real list_models
// fetch. Subscribed once at module scope — survives component unmounts.
wsClient.onEvent('session:model-catalog', (data: unknown) => {
  const d = data as { host?: string; models?: SessionModelCatalogEntry[]; fetchedAt?: string };
  if (!Array.isArray(d.models) || d.models.length === 0) return;
  upsert(hostKey(d.host), { models: d.models, fetchedAt: d.fetchedAt ?? new Date().toISOString() });
});

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  void hydrate();
  return () => { listeners.delete(cb); };
}

/**
 * The last-known CLI model catalog for a host (null = host never produced one;
 * callers fall back to the static registry). Updates live via WS.
 */
export function useHostModelCatalog(host?: string | null): HostCatalogEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => catalogs[hostKey(host)] ?? null,
  );
}

/** Imperative read for non-hook call sites. */
export function getHostCatalog(host?: string | null): HostCatalogEntry | null {
  return catalogs[hostKey(host)] ?? null;
}

/** Imperative write — e.g. the picker's manual-refresh HTTP response. The WS
 *  push from the same server-side fetch also arrives; upsert's diff makes the
 *  second application a no-op. */
export function seedHostCatalog(
  host: string | null | undefined,
  models: SessionModelCatalogEntry[],
  fetchedAt?: string,
): void {
  if (!models.length) return;
  upsert(hostKey(host), { models, fetchedAt: fetchedAt ?? new Date().toISOString() });
}

/** Test hook. */
export function _resetModelCatalogStore(): void {
  catalogs = {};
  lastHydrateAt = 0;
  notify();
}
