/**
 * Page Visibility helpers — hidden tabs must not keep polling the server.
 *
 * Every open Walnut tab is a full client (own WS, own pollers, own reconnect
 * refresh burst), and all tabs share the browser's 6-connections-per-origin
 * pool. A tab left hidden for hours used to keep every poller running, so
 * N tabs multiplied every burst by N and starved the pool for the tab the
 * user is actually looking at.
 *
 * The contract (industry-standard "background tabs sleep" pattern):
 *  - `visibleInterval(tick, ms)` — drop-in for setInterval that skips ticks
 *    while the tab is hidden and, if any tick was missed, runs ONE catch-up
 *    tick the moment the tab becomes visible again.
 *  - `runWhenVisible(key, fn)` — run now if visible; if hidden, defer until
 *    the tab is next shown (latest fn wins per key, so bursts coalesce).
 *
 * In non-DOM environments (node tests) `document` is undefined → everything
 * degrades to the plain always-on behavior.
 */

export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

const visibleListeners = new Set<() => void>();
const deferredJobs = new Map<string, () => void>();

let wired = false;
function wire(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return;
    // hidden → visible edge: notify subscribers, then drain deferred jobs.
    for (const cb of [...visibleListeners]) {
      try { cb(); } catch { /* one listener must not break the rest */ }
    }
    const jobs = [...deferredJobs.values()];
    deferredJobs.clear();
    for (const job of jobs) {
      try { job(); } catch { /* same */ }
    }
  });
}

/** Subscribe to hidden→visible edges. Returns unsubscribe. */
export function onPageVisible(cb: () => void): () => void {
  wire();
  visibleListeners.add(cb);
  return () => { visibleListeners.delete(cb); };
}

/**
 * Run `fn` immediately if the page is visible; otherwise defer it until the
 * tab is next shown. Deferred jobs dedupe by `key` (latest wins) — ten missed
 * refresh triggers while hidden become one refresh on return.
 */
export function runWhenVisible(key: string, fn: () => void): void {
  if (!isPageHidden()) { fn(); return; }
  wire();
  deferredJobs.set(key, fn);
}

/**
 * setInterval that sleeps while the tab is hidden. Missed ticks collapse into
 * one catch-up tick on the hidden→visible edge (disable via catchUp: false).
 * Returns a cancel function (replaces clearInterval).
 */
export function visibleInterval(
  tick: () => void,
  ms: number,
  opts?: { catchUp?: boolean },
): () => void {
  const catchUp = opts?.catchUp ?? true;
  let missed = false;
  let cancelled = false;
  const id = setInterval(() => {
    if (isPageHidden()) { missed = true; return; }
    missed = false;
    tick();
  }, ms);
  const off = onPageVisible(() => {
    if (cancelled || !missed || !catchUp) return;
    missed = false;
    tick();
  });
  return () => { cancelled = true; clearInterval(id); off(); };
}
