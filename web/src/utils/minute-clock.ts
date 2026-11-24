/**
 * One clock for every label that moves with the minute ("5m ago", "in 12m", a deferred task's
 * start, a relative time window), read with useSyncExternalStore.
 *
 * Why one, and why at the leaves (2026-11-23, task 9bceb9f2): the Org page, Home's task list,
 * the Tasks table, the Dashboard and the task views each kept a minute tick in their own state at
 * the page or list root, so every minute the whole page drew again to move a few labels: on the
 * Mac app with about 1,169 tasks those passes held the main thread 100 to 470 ms. Here the small
 * component that shows the time subscribes, and `useMinuteValue` redraws it only when what it
 * shows changed (the label's text, the set of tasks a time filter passes).
 * `tests/web/minute-tick-ratchet.test.ts` refuses a new minute interval that sets state in a page
 * or list component.
 *
 * The clock fires on the wall minute (all labels move together), sleeps while the tab is hidden
 * and catches up once when it is shown again (page-visibility.ts), and runs only while something
 * subscribes.
 */
import { useRef, useSyncExternalStore } from 'react';
import { isPageHidden, onPageVisible } from './page-visibility';

export const MINUTE_MS = 60_000;

let now = Date.now();
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function tick(): void {
  now = Date.now();
  for (const cb of [...listeners]) {
    try { cb(); } catch { /* one label must not stop the others */ }
  }
}

function start(): () => void {
  let missed = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      if (isPageHidden()) missed = true;
      else { missed = false; tick(); }
      arm();
    }, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
  };
  arm();
  const off = onPageVisible(() => { if (missed) { missed = false; tick(); } });
  return () => { clearTimeout(timer); off(); };
}

/** Subscribe to the minute. Returns unsubscribe. */
export function subscribeMinute(cb: () => void): () => void {
  if (listeners.size === 0) { minuteNow(); stop = start(); }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) { stop?.(); stop = null; }
  };
}

/** The clock's reading: the time of its last tick (it moves once a minute). With no subscriber
 *  it is read again whenever the wall minute differs (either way: a clock set back counts too),
 *  so a first subscriber never gets the previous minute's reading. */
export function minuteNow(): number {
  if (listeners.size === 0) {
    const t = Date.now();
    if (Math.floor(t / MINUTE_MS) !== Math.floor(now / MINUTE_MS)) now = t;
  }
  return now;
}

const noSubscribe = () => () => {};

/** The minute clock, for a component that shows a time label. Off: a frozen reading. */
export function useMinuteNow(on = true): number {
  return useSyncExternalStore(on ? subscribeMinute : noSubscribe, minuteNow, minuteNow);
}

/**
 * What `read` makes of the clock, redrawing the caller only when that changes (Object.is): a
 * label's text, or a key of what a time filter passes. `read` must return a primitive (or the same
 * object for the same input); keep it stable (useCallback) when it is costly, since it runs again
 * only for a new `read` or a new minute.
 */
export function useMinuteValue<T>(read: (now: number) => T, on = true): T {
  const cache = useRef<{ read: (now: number) => T; at: number; value: T } | null>(null);
  const snapshot = (): T => {
    const at = minuteNow();
    const c = cache.current;
    if (c && c.read === read && c.at === at) return c.value;
    const value = read(at);
    cache.current = { read, at, value };
    return value;
  };
  return useSyncExternalStore(on ? subscribeMinute : noSubscribe, snapshot, snapshot);
}
