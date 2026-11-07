/**
 * The tasks the person opened lately: what the Home panel's Recent tab lists, newest first.
 *
 * 2026-11-06, the user: "add all the recent opened not recently updated ... so user can find,
 * like this open this this this, and then they can find it". Recent used to rank every task by
 * its last update, so tasks other agents touched buried the one just looked at. An open is the
 * person's own act: a click on a task row (its detail, its session), a session column opened, an
 * ask picked in the chat slot, an Org node selected. A load restoring what was on screen is not
 * one, nor is an agent's update.
 *
 * One synced key (`walnut-todo-` is a ui-prefs family), so the list survives a reload and follows
 * the person to another device. A browser under automation still records into its own
 * localStorage, but its mirror writes carry the test-run header, so the server keeps them in the
 * run's own copy and never in the user's file (src/core/test-run-prefs.ts). Two windows or
 * devices both writing would lose each other's opens under the mirror's last-writer-wins, so a
 * window coming back to the front first merges the server's copy into its own (newest open of
 * each task wins).
 */
import { useSyncExternalStore } from 'react';
import { apiGet } from '@/api/client';

export const RECENT_OPENED_KEY = 'walnut-todo-recent-opened';
/** How many opens the list keeps (about 3 KB, well under a ui-prefs value's 8 KB). */
export const RECENT_OPENED_MAX = 50;
const CHANGE_EVENT = 'walnut:recent-opened';

export interface RecentOpen {
  /** The task id. */
  id: string;
  /** When the person last opened it (ISO). */
  at: string;
}

/** Entries from any stored value: bad rows dropped, one per task, newest first, capped. */
export function parseRecentOpened(raw: string | null): RecentOpen[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return normalize(value.filter((e): e is RecentOpen =>
      !!e && typeof e === 'object' && typeof (e as RecentOpen).id === 'string' && !!(e as RecentOpen).id
      && typeof (e as RecentOpen).at === 'string' && !isNaN(Date.parse((e as RecentOpen).at))));
  } catch { return []; }
}

function normalize(entries: readonly RecentOpen[]): RecentOpen[] {
  const newest = new Map<string, RecentOpen>();
  for (const e of entries) {
    const seen = newest.get(e.id);
    if (!seen || Date.parse(e.at) > Date.parse(seen.at)) newest.set(e.id, { id: e.id, at: e.at });
  }
  return [...newest.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RECENT_OPENED_MAX);
}

/** Two lists as one: each task at its newest open, newest first, capped. */
export function mergeRecentOpened(a: readonly RecentOpen[], b: readonly RecentOpen[]): RecentOpen[] {
  return normalize([...a, ...b]);
}

/** The list with `id` opened at `at` (moved to the top when already there). */
export function withOpened(list: readonly RecentOpen[], id: string, at: string): RecentOpen[] {
  return normalize([{ id, at }, ...list.filter((e) => e.id !== id)]);
}

/**
 * The order a Recent tab on screen draws: rows it already shows keep their places, and a task
 * new to the list comes in on top. Opening a row from the list must not move it under the
 * pointer or the thumb (a phone's Back lands where the thumb left, N2-01); the list takes the
 * newest-first order again the next time it is opened. `shown` null: the tab just opened.
 */
export function settledOrder(shown: readonly string[] | null, fresh: readonly string[]): string[] {
  if (!shown) return [...fresh];
  const now = new Set(fresh);
  const kept = shown.filter((id) => now.has(id));
  const had = new Set(kept);
  return [...fresh.filter((id) => !had.has(id)), ...kept];
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

let cachedRaw: string | null | undefined;
let cachedList: RecentOpen[] = [];

/** The stored list (the same array until the key changes, for useSyncExternalStore). */
export function readRecentOpened(): RecentOpen[] {
  let raw: string | null = null;
  try { raw = storage()?.getItem(RECENT_OPENED_KEY) ?? null; } catch { /* storage off */ }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = parseRecentOpened(raw);
  }
  return cachedList;
}

function writeRecentOpened(list: readonly RecentOpen[]): void {
  const next = JSON.stringify(list);
  try {
    const ls = storage();
    if (!ls || ls.getItem(RECENT_OPENED_KEY) === next) return;
    ls.setItem(RECENT_OPENED_KEY, next);
  } catch { return; /* quota, storage off */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The person opened this task. Never throws. */
export function recordTaskOpened(taskId: string | null | undefined, now: Date = new Date()): void {
  if (!taskId) return;
  writeRecentOpened(withOpened(readRecentOpened(), taskId, now.toISOString()));
}

/** Take in the opens another window or device saved to the server. Never throws. */
export async function pullRecentOpened(): Promise<void> {
  try {
    // `key` narrows the answer to this one entry (an older server ignores it and sends all).
    const res = await apiGet<{ prefs?: Record<string, { v?: string | null }> }>(
      '/api/ui-prefs', { key: RECENT_OPENED_KEY }, { timeoutMs: 5000, priority: 'low' },
    );
    const theirs = parseRecentOpened(res?.prefs?.[RECENT_OPENED_KEY]?.v ?? null);
    if (theirs.length === 0) return;
    writeRecentOpened(mergeRecentOpened(readRecentOpened(), theirs));
  } catch { /* offline: this window's own list stands */ }
}

let pulling = false;
let lastPull = 0;
const PULL_MIN_GAP_MS = 15_000;

function pullOnReturn(): void {
  if (document.visibilityState !== 'visible' || pulling || Date.now() - lastPull < PULL_MIN_GAP_MS) return;
  pulling = true;
  lastPull = Date.now();
  void pullRecentOpened().finally(() => { pulling = false; });
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === RECENT_OPENED_KEY || e.key === null) onChange(); };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', pullOnReturn);
  document.addEventListener('visibilitychange', pullOnReturn);
  pullOnReturn();
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', pullOnReturn);
    document.removeEventListener('visibilitychange', pullOnReturn);
  };
}

/** The opens, newest first, live: this window's own, another tab's, another device's on return. */
export function useRecentOpened(): RecentOpen[] {
  return useSyncExternalStore(subscribe, readRecentOpened, readRecentOpened);
}
