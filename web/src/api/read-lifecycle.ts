let leaving = false;
let hiddenAway = false;
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function resume(): void {
  generation++;
  leaving = false;
  hiddenAway = false;
  notify();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    leaving = true;
    const current = ++generation;
    notify();
    // Navigation pauses rendering; a cancelled navigation resumes it in this document.
    window.requestAnimationFrame?.(() => {
      if (generation === current && !hiddenAway) resume();
    });
  });
  window.addEventListener('pagehide', () => {
    generation++;
    leaving = true;
    hiddenAway = true;
    notify();
  });
  window.addEventListener('pageshow', resume);
}

/** When the page last went into the background (a window behind others, a hidden tab), Date.now() based. */
let lastHiddenAt = -Infinity;
const docOf = (): { visibilityState?: string; addEventListener?: (t: string, f: () => void) => void } | undefined =>
  (globalThis as { document?: { visibilityState?: string; addEventListener?: (t: string, f: () => void) => void } }).document;
docOf()?.addEventListener?.('visibilitychange', () => {
  if (docOf()?.visibilityState === 'hidden') lastHiddenAt = Date.now();
});

/**
 * Was the page in the background at any time since `since` (Date.now() based)? A background
 * window's engine runs its timers late and in bursts (2026-11-23, live: the Mac app's tab reloaded
 * itself while hidden, its first reads held the connections 63 to 245 s, and 90 requests behind
 * them were rejected in 7 minutes nobody was looking), so time spent there says nothing about the
 * page's own connections.
 */
export function pageHiddenSince(since: number): boolean {
  return docOf()?.visibilityState === 'hidden' || lastHiddenAt >= since;
}

export function readsSuspended(): boolean {
  return leaving;
}

export function onReadLifecycle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function waitForReadablePage(signal?: AbortSignal, deadline = Date.now() + 20_000): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!leaving) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      listeners.delete(check);
      signal?.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve();
    };
    const expired = () => new DOMException('Request waited 20000ms while the page was suspended', 'TimeoutError');
    const check = () => { if (!leaving) finish(Date.now() >= deadline ? expired() : undefined); };
    const aborted = () => finish(signal!.reason);
    const timer = setTimeout(() => finish(expired()), Math.max(0, deadline - Date.now()));
    listeners.add(check);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
