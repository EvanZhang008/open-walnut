/**
 * One request per key for GETs that several modules fire during the same page
 * load. A cold load used to send GET /api/config five times and the system
 * health and git-sync status three times each, because every consumer owned its
 * own fetch. Callers that arrive while a request is in flight join it, and its
 * answer stays reusable for MEMO_MS after it lands. Every caller gets its own
 * copy, as it did with a request of its own, so no caller can mutate another's.
 *
 * A failed request is never reused. A key may name the WS events that announce
 * a change (`invalidateOn`): they drop the entry before any component hears the
 * event, because wildcard listeners run before named ones, so a component that
 * refetches on the event gets a new request. A request in flight when its entry
 * is dropped still answers its own callers.
 */
import { wsClient } from './ws';

const MEMO_MS = 3_000;

interface Entry {
  promise: Promise<unknown>;
  settledAt: number | null;
}

const entries = new Map<string, Entry>();
const keysByEvent = new Map<string, Set<string>>();
let socketBound = false;

function invalidateOnEvents(key: string, events: readonly string[]): void {
  for (const name of events) {
    let keys = keysByEvent.get(name);
    if (!keys) {
      keys = new Set();
      keysByEvent.set(name, keys);
    }
    keys.add(key);
  }
  if (socketBound) return;
  socketBound = true;
  try {
    wsClient.subscribeAll((name) => {
      const keys = keysByEvent.get(name);
      if (keys) for (const k of keys) entries.delete(k);
    });
  } catch {
    // No socket client (a test double without subscribeAll): entries still expire.
  }
}

function copyOf<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

export function sharedGet<T>(
  key: string,
  load: () => Promise<T>,
  opts?: { invalidateOn?: readonly string[] },
): Promise<T> {
  if (opts?.invalidateOn?.length) invalidateOnEvents(key, opts.invalidateOn);
  let entry = entries.get(key);
  if (!entry || (entry.settledAt !== null && Date.now() - entry.settledAt >= MEMO_MS)) {
    const created: Entry = { promise: Promise.resolve(), settledAt: null };
    created.promise = load().then(
      (value) => {
        created.settledAt = Date.now();
        return value;
      },
      (error: unknown) => {
        if (entries.get(key) === created) entries.delete(key);
        throw error;
      },
    );
    entries.set(key, created);
    entry = created;
  }
  return entry.promise.then((value) => copyOf(value as T));
}

/** The next caller starts a new request (writers call this before and after a write). */
export function invalidateSharedGet(key: string): void {
  entries.delete(key);
}

/** Test hook: forget every shared answer. */
export function resetSharedGetsForTest(): void {
  entries.clear();
}
