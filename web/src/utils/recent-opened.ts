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

export {
  RECENT_OPENED_KEY, RECENT_OPENED_MAX, parseRecentOpened, mergeRecentOpened, mergeRecentOpenedRaw, withOpened,
  type RecentOpen,
} from '../../../src/core/recent-opened-list';
import { RECENT_OPENED_KEY, mergeRecentOpened, parseRecentOpened, withOpened, type RecentOpen } from '../../../src/core/recent-opened-list';
const CHANGE_EVENT = 'walnut:recent-opened';

/** A Recent row opened from the list itself: its open time before that click, and when the click was. */
export interface HeldRow {
  before: string;
  /** The click (ms since epoch): the opens it records land within SAME_CLICK_MS after it. */
  clickedAt: number;
}

/** Opens within this long of the click are that click's own (a row with a session records twice). */
const SAME_CLICK_MS = 2000;

/**
 * The order the Recent tab draws: newest open first, except that a row opened FROM the list
 * keeps the place it had while the tab stays on screen. Clicking a row must not move it under the
 * pointer or the thumb (a phone's Back lands where the thumb left, N2-01). An open from anywhere
 * else still goes to the top: a later open of a held row lets it go (`held` is updated in place,
 * so the hook's map follows), and a held row takes its new place the next time the tab opens.
 */
export function recentRowOrder(opens: readonly RecentOpen[], held: Map<string, HeldRow>): string[] {
  const key = (e: RecentOpen): number => {
    const h = held.get(e.id)
    const at = Date.parse(e.at)
    if (!h) return at
    if (at - h.clickedAt > SAME_CLICK_MS) { held.delete(e.id); return at }
    return Math.min(at, Date.parse(h.before))
  }
  return opens.map((e, i) => ({ id: e.id, t: key(e), i }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.id)
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
  // `tmp-` is an optimistic create's id until the server's arrives (useTasks): never a real task.
  if (!taskId || taskId.startsWith('tmp-')) return;
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
