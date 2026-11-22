/**
 * A calendar range whose load failed is tried again by itself while someone still watches it.
 *
 * A server restart answers 503 for a few seconds (the calendar plugin is still starting); on
 * 2026-11-20/21 three loads lost that way left the grid empty with nothing to say so and nothing
 * that asked again. Backoff: 2 s, 5 s, 10 s, 30 s, then every minute.
 */
const RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export function createLoadRetry(opts: { watched: (key: string) => boolean; retry: (key: string) => void }) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const counts = new Map<string, number>();
  const clear = (key: string) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    counts.delete(key);
  };
  return {
    /** The load of `key` failed: try it again later (once per failure, while it is watched). */
    failed(key: string): number {
      const n = counts.get(key) ?? 0;
      if (!timers.has(key) && opts.watched(key)) {
        counts.set(key, n + 1);
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          if (opts.watched(key)) opts.retry(key);
        }, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]));
      }
      return n + 1;
    },
    /** It loaded, or no one watches it any more: no timer left, and the next failure starts
     *  from the shortest wait again. */
    clear,
    reset(): void { for (const key of [...timers.keys()]) clear(key); counts.clear(); },
  };
}
