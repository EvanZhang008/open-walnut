/**
 * Hosts whose refused-Start error bar (HostGateErrorBar) is on screen. The
 * compact banner in a draft column leaves those hosts out: the bar right below
 * it already says the same sentence with the same buttons, and saying it twice
 * one above the other reads as two problems.
 *
 * Ref-counted per host: two drafts refused on the same host hold it until both
 * bars go.
 */
import { useSyncExternalStore } from 'react';

const counts = new Map<string, number>();
let snap: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  snap = new Set(counts.keys());
  for (const l of listeners) l();
}

/** The bar for `host` is showing; call the returned function when it goes. */
export function markGateBarShown(host: string): () => void {
  counts.set(host, (counts.get(host) ?? 0) + 1);
  publish();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (counts.get(host) ?? 1) - 1;
    if (n <= 0) counts.delete(host);
    else counts.set(host, n);
    publish();
  };
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export const getGateBarHosts = (): ReadonlySet<string> => snap;

export function useGateBarHosts(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getGateBarHosts, getGateBarHosts);
}

/** Test hook. */
export function __resetGateBarShownForTests(): void {
  counts.clear();
  snap = new Set();
  listeners.clear();
}
