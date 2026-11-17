/**
 * A person is opening a conversation on this host: background work that shares the host's link
 * waits, so the first screen's few KB do not queue behind it.
 *
 * 2026-11-16: a reconnect pass of the ready-view refresher (history-ready-refresh.ts) fetched 58
 * views from clouddev, one MB-scale answer after another on the daemon's main socket, while the
 * user opened a session there; its 45 KB first screen came back after the route's deadlines, the
 * first paint was empty and the user waited 11 s for the full read. Background callers ask
 * `waitForHostOpens` before each request; the first-paint route holds the host while it asks.
 */

const holds = new Map<string, number>();
const releasedAt = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();

/** After the last open on a host ends, background work stays back this long (the full read starts then). */
export const OPEN_QUIET_MS = 1_500;
/** The longest a background request waits for opens; past it, it goes anyway (no starvation). */
export const OPEN_WAIT_MAX_MS = 20_000;

/** Hold `hostKey` for an open; call the returned function once the first paint answered. */
export function holdHostForOpen(hostKey: string): () => void {
  holds.set(hostKey, (holds.get(hostKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(hostKey) ?? 1) - 1;
    if (left > 0) { holds.set(hostKey, left); return; }
    holds.delete(hostKey);
    releasedAt.set(hostKey, Date.now());
    for (const wake of waiters.get(hostKey) ?? []) wake();
  };
}

/** Whether an open on `hostKey` is in progress or ended within OPEN_QUIET_MS. */
export function hostOpenBusy(hostKey: string, now = Date.now()): boolean {
  return (holds.get(hostKey) ?? 0) > 0 || now - (releasedAt.get(hostKey) ?? -Infinity) < OPEN_QUIET_MS;
}

/** Resolves once no open on `hostKey` is in progress or just ended, or after `maxWaitMs`. */
export async function waitForHostOpens(hostKey: string, maxWaitMs = OPEN_WAIT_MAX_MS): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (hostOpenBusy(hostKey) && Date.now() < deadline) {
    const held = (holds.get(hostKey) ?? 0) > 0;
    const quietLeft = OPEN_QUIET_MS - (Date.now() - (releasedAt.get(hostKey) ?? -Infinity));
    const waitMs = Math.max(1, Math.min(deadline - Date.now(), held ? deadline - Date.now() : quietLeft));
    await new Promise<void>((resolve) => {
      const set = waiters.get(hostKey) ?? new Set<() => void>();
      waiters.set(hostKey, set);
      const done = (): void => { clearTimeout(timer); set.delete(done); if (set.size === 0) waiters.delete(hostKey); resolve(); };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      set.add(done);
    });
  }
}

/** Tests. */
export function _resetHostOpenHoldsForTesting(): void {
  holds.clear();
  releasedAt.clear();
  for (const set of waiters.values()) for (const wake of [...set]) wake();
  waiters.clear();
}
