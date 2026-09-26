/**
 * Which hosts the USER asked to connect in this page's life, and which of those
 * attempts are still settling. Two readers, both in the home banner model:
 *
 *   engaged   a host found in ~/.ssh/config (`discovered`) takes a banner row
 *             or lights the rail dot only after the user pressed Retry or
 *             Connect now on it. Nobody asked Walnut to use such a host, so its
 *             failure is not news (the old banner skipped them entirely).
 *   retrying  the row of a host the user is retrying reads 'Connecting to X...'
 *             with a disabled 'Retrying...', whichever surface the click came from.
 *
 * Ref-counted: two surfaces retrying the same host hold it until both settle.
 */
import { useSyncExternalStore } from 'react';

const engaged = new Set<string>();
const retrying = new Map<string, number>();
let engagedSnap: ReadonlySet<string> = new Set();
let retryingSnap: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  engagedSnap = new Set(engaged);
  retryingSnap = new Set(retrying.keys());
  for (const l of listeners) l();
}

/** The user pressed Retry / Connect now on these hosts. Returns the release for the attempt. */
export function markUserRetry(hosts: readonly string[]): () => void {
  for (const h of hosts) {
    engaged.add(h);
    retrying.set(h, (retrying.get(h) ?? 0) + 1);
  }
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const h of hosts) {
      const n = (retrying.get(h) ?? 1) - 1;
      if (n <= 0) retrying.delete(h);
      else retrying.set(h, n);
    }
    publish();
  };
}

export function subscribeUserRetry(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export const getUserEngagedHosts = (): ReadonlySet<string> => engagedSnap;
export const getUserRetryingHosts = (): ReadonlySet<string> => retryingSnap;

export function useUserEngagedHosts(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeUserRetry, getUserEngagedHosts, getUserEngagedHosts);
}

export function useUserRetryingHosts(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeUserRetry, getUserRetryingHosts, getUserRetryingHosts);
}

/** Test hook. */
export function __resetUserRetryForTests(): void {
  engaged.clear();
  retrying.clear();
  engagedSnap = new Set();
  retryingSnap = new Set();
  listeners.clear();
}
