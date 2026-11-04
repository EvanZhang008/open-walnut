/**
 * The last good answer of a slow or remote read, kept in this browser, so a reopened page (a
 * reload, the Mac app started again) paints it at once and keeps it until a newer one comes
 * (2026-11-04, the user: "cache should cache for long tie until the real data come"). A failed
 * or degraded read never replaces it; the page says the failure beside it.
 *
 * Callers keep only answers they would show: never an error reply, never an empty answer that
 * stands for "could not read". `accept` checks the shape on read, so a value an older build
 * wrote that no longer fits is dropped instead of crashing the page.
 */
interface Kept { v: 1; at: number; value: unknown }

export function readLastGood<T>(key: string, accept: (v: unknown) => v is T): { value: T; at: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Kept | null;
    if (!raw || raw.v !== 1 || typeof raw.at !== 'number' || !accept(raw.value)) return null;
    return { value: raw.value, at: raw.at };
  } catch {
    return null;
  }
}

export function keepLastGood<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: 1, at: Date.now(), value } satisfies Kept));
  } catch {
    // A full or blocked storage only costs the next open its instant paint.
  }
}
