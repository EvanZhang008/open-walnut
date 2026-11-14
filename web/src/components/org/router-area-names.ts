/**
 * The names of the router areas ("Personal", "Work"), read once from GET /api/v1/router/areas and
 * shared by the Org list's router rows and a router's settings, so both show an area by its name and
 * never by its id. Until the list answers (or when it leaves an area out) a caller shows the id.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiGet } from '@/api/client';

export type RouterAreaNames = Readonly<Record<string, string>>;
/** The accounts an area lists as its sources (`kind`: mail or slack), in the order the file keeps them. */
export type RouterAreaSources = Readonly<Record<string, ReadonlyArray<{ kind: string; account: string }>>>;
/** The folders or labels each area's router watches; an area with none watches the plugin's default (the Inbox). */
export type RouterAreaFolders = Readonly<Record<string, readonly string[]>>;

export function areaFoldersOf(body: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const list = (body as { areas?: unknown } | null)?.areas;
  if (!Array.isArray(list)) return out;
  for (const a of list as Array<{ id?: unknown; folders?: unknown }>) {
    if (typeof a?.id !== 'string' || !a.id) continue;
    out[a.id] = Array.isArray(a.folders) ? a.folders.filter((one): one is string => typeof one === 'string' && !!one.trim()) : [];
  }
  return out;
}

// Read once for each area id first seen without a name (a router made for a new area included), so a
// name is never more than one read away and an id the list lacks is not asked about again. Every
// mounted caller hears each read, whichever caller asked for it.
let names: RouterAreaNames = {};
let sources: RouterAreaSources = {};
let folders: RouterAreaFolders = {};
let accountAreas: RouterAccountAreas = {};
/** How the areas read went: not answered yet, answered, or the last one failed. */
export type RouterAreasReadState = 'pending' | 'ok' | 'failed';
let readState: RouterAreasReadState = 'pending';
const stateListeners = new Set<() => void>();
const setReadState = (next: RouterAreasReadState) => { readState = next; for (const l of stateListeners) l(); };
let areaRouters: RouterAreaRouters = {};
let queue: Promise<void> = Promise.resolve();
const askedFor = new Set<string>();
const listeners = new Set<(next: RouterAreaNames) => void>();

/** Which area reads each account, keyed `<kind>\u0000<account>`: its binding first, else the area listing it as a source. */
export type RouterAccountAreas = Readonly<Record<string, string>>;
/** Each area's router task id. */
export type RouterAreaRouters = Readonly<Record<string, string>>;

export const accountAreaKey = (kind: string, account: string): string => `${kind}\u0000${account}`;

export function accountAreasOf(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [area, list] of Object.entries(areaSourcesOf(body))) {
    for (const src of list) out[accountAreaKey(src.kind, src.account)] ??= area;
  }
  const bindings = (body as { accountBindings?: unknown } | null)?.accountBindings;
  for (const one of Array.isArray(bindings) ? bindings as Array<{ kind?: unknown; account?: unknown; areaId?: unknown }> : []) {
    if (typeof one?.kind === 'string' && typeof one.account === 'string' && one.account && typeof one.areaId === 'string' && one.areaId) {
      out[accountAreaKey(one.kind, one.account)] = one.areaId;
    }
  }
  return out;
}

export function areaRoutersOf(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = (body as { routers?: unknown } | null)?.routers;
  for (const one of Array.isArray(list) ? list as Array<{ areaId?: unknown; taskId?: unknown }> : []) {
    if (typeof one?.areaId === 'string' && one.areaId && typeof one.taskId === 'string' && one.taskId) out[one.areaId] ??= one.taskId;
  }
  return out;
}

export function areaSourcesOf(body: unknown): Record<string, Array<{ kind: string; account: string }>> {
  const out: Record<string, Array<{ kind: string; account: string }>> = {};
  const list = (body as { areas?: unknown } | null)?.areas;
  if (!Array.isArray(list)) return out;
  for (const a of list as Array<{ id?: unknown; sources?: unknown }>) {
    if (typeof a?.id !== 'string' || !a.id) continue;
    out[a.id] = (Array.isArray(a.sources) ? a.sources : []).flatMap((one) => {
      const src = one as { kind?: unknown; account?: unknown };
      return typeof src?.kind === 'string' && typeof src.account === 'string' && src.account ? [{ kind: src.kind, account: src.account }] : [];
    });
  }
  return out;
}

export function areaNamesOf(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = (body as { areas?: unknown } | null)?.areas;
  if (!Array.isArray(list)) return out;
  for (const a of list as Array<{ id?: unknown; name?: unknown }>) {
    if (typeof a?.id === 'string' && a.id && typeof a.name === 'string' && a.name.trim()) out[a.id] = a.name.trim();
  }
  return out;
}

// Reads run one after another, so a read asked for after an area appeared is never answered by an
// older one that predates it.
function queueRead(): void {
  queue = queue.then(() => apiGet<unknown>('/api/v1/router/areas')
    .then((body) => { names = areaNamesOf(body); sources = areaSourcesOf(body); folders = areaFoldersOf(body);
      accountAreas = accountAreasOf(body); areaRouters = areaRoutersOf(body); for (const l of listeners) l(names); setReadState('ok'); })
    // Callers keep showing the id; one that must know the read failed asks useRouterAreasReadState.
    .catch(() => { setReadState('failed'); }));
}

/** The area names, read again when an id in `ids` has none and was not asked about yet. */
export function useRouterAreaNames(ids: readonly string[]): RouterAreaNames {
  const [shown, setShown] = useState<RouterAreaNames>(names);
  useEffect(() => {
    listeners.add(setShown);
    setShown(names);
    return () => { listeners.delete(setShown); };
  }, []);
  const missing = ids.filter((id) => id && !(id in names)).sort().join('\n');
  useEffect(() => {
    const fresh = missing ? missing.split('\n').filter((id) => !askedFor.has(id)) : [];
    if (!fresh.length) return;
    for (const id of fresh) askedFor.add(id);
    queueRead();
  }, [missing]);
  return shown;
}

/** Reads the areas again (a Mail or Slack choice since the last read may have added an account); settles once that read did. */
export function refreshRouterAreas(): Promise<void> {
  queueRead();
  return queue;
}

/** Whether the areas were read yet (re-renders when that changes). */
export function useRouterAreasReadState(): RouterAreasReadState {
  return useSyncExternalStore((l) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; }, () => readState, () => readState);
}

/** The sources of the areas read so far (with the names: one read serves both). */
export function routerAreaSources(): RouterAreaSources {
  return sources;
}

/** The watched folders of the areas read so far (the same read). */
export function routerAreaFolders(): RouterAreaFolders {
  return folders;
}

/** Which area reads each account (the same read). */
export function routerAccountAreas(): RouterAccountAreas {
  return accountAreas;
}

/** Each area's router task id (the same read). */
export function routerAreaRouters(): RouterAreaRouters {
  return areaRouters;
}

/** Test seam: forget what was read. */
export function _resetRouterAreaNames(): void {
  names = {}; sources = {}; folders = {}; accountAreas = {}; areaRouters = {}; readState = 'pending'; stateListeners.clear(); queue = Promise.resolve(); askedFor.clear(); listeners.clear();
}
