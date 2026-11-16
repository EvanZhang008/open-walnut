/**
 * Which not_routed items the router sent the person as an inbox letter, so the item's line says
 * "Letter to you" instead of "Not routed" (2026-11-16: a DoorDash interview invitation the router
 * had sent the person read as a grey "Not routed", as if nobody had it).
 *
 * A letter's id is written on its row once it is sent (service.ts). A row an older build wrote has
 * no answer yet: the inbox is asked once, by the letter's own op key (`router-letter:<area>:<key>`,
 * the key the router has always sent it under), and the answer is written back, so each such row is
 * looked up one time only.
 */
import type { RouterRoute } from './types.js';
import type { RouterStore } from './store.js';

/** The op key a router's letter for an item is sent under (one letter per item, ever). */
export function routerLetterOpKey(areaId: string, key: string): string {
  return `router-letter:${areaId}:${key}`;
}

export interface LetterReceiptDeps {
  store: (areaId: string) => RouterStore;
  findLetters?: (opKeys: readonly string[]) => Promise<Map<string, string>>;
}

async function defaultFindLetters(opKeys: readonly string[]): Promise<Map<string, string>> {
  const { findLetterIdsByOps } = await import('../human-inbox/store.js');
  return findLetterIdsByOps(opKeys);
}

/**
 * The routes with each unchecked not_routed row answered: its letter's id when one was sent. A
 * failed lookup leaves the rows unchecked (asked again next time) and the routes as they were.
 */
export async function withLetterReceipts<T extends RouterRoute>(routes: T[], deps: LetterReceiptDeps): Promise<T[]> {
  const unchecked = routes.filter((route) => route.letterUnchecked);
  if (unchecked.length === 0) return routes;
  let found: Map<string, string>;
  try {
    found = await (deps.findLetters ?? defaultFindLetters)(unchecked.map((route) => routerLetterOpKey(route.areaId, route.key)));
  } catch {
    return routes;
  }
  const byArea = new Map<string, T[]>();
  for (const route of unchecked) byArea.set(route.areaId, [...(byArea.get(route.areaId) ?? []), route]);
  await Promise.all([...byArea].map(async ([areaId, rows]) => {
    const store = deps.store(areaId);
    const none = rows.filter((route) => !found.has(routerLetterOpKey(areaId, route.key))).map((route) => route.key);
    await Promise.all([
      store.noteLetter(none, '').catch(() => 0),
      ...rows.flatMap((route) => {
        const id = found.get(routerLetterOpKey(areaId, route.key));
        return id ? [store.noteLetter([route.key], id).catch(() => 0)] : [];
      }),
    ]);
  }));
  return routes.map((route) => {
    if (!route.letterUnchecked) return route;
    const { letterUnchecked: _unchecked, ...rest } = route;
    const id = found.get(routerLetterOpKey(route.areaId, route.key));
    return (id ? { ...rest, letterId: id } : rest) as T;
  });
}

const answered = new Map<string, Promise<void>>();
/** One pass reads the inbox once for this many rows; a ledger with more answers the rest as they are read. */
const UNCHECKED_BATCH = 2000;

/**
 * Answers every unchecked row of one ledger, once per process (and again after a failure), before a
 * reader that lists rows (router_context's histories, the router page's counts) reads them.
 */
export function ensureLetterReceipts(store: RouterStore, findLetters?: LetterReceiptDeps['findLetters']): Promise<void> {
  const known = answered.get(store.file);
  if (known) return known.catch(() => undefined);
  const run = (async () => {
    const rows = await store.uncheckedLetters(UNCHECKED_BATCH);
    if (rows.length === 0) return;
    const after = await withLetterReceipts(rows, { store: () => store, ...(findLetters ? { findLetters } : {}) });
    // A lookup that failed left them unchecked: a later read tries again.
    if (after.some((route) => route.letterUnchecked)) throw new Error('letter lookup failed');
  })();
  answered.set(store.file, run);
  run.catch(() => { if (answered.get(store.file) === run) answered.delete(store.file); });
  return run.catch(() => undefined);
}
