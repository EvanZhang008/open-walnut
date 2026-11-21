/**
 * One copy of every session's cost in this browser (GET /api/sessions/:id/cost), kept across
 * reloads, so the model picker's Cost toggle shows a number in its first frame. The session
 * panel's pill warms it (useSessionCostPrefetch) and the open picker brings it current
 * (useSessionCost); every panel of the same session reads one entry.
 *
 * A finished read (priced, partial, unpriced, empty) is kept and saved to localStorage
 * (versioned key, at most COST_STORE_MAX sessions, least recently read dropped first). A
 * `pending` or `unavailable` answer never replaces a finished one: the known number stays on
 * screen and the next finished read swaps in silently (one rule with the server's cache:
 * src/core/usage/session-cost-settled.ts). Warm-ups (`prefetch`) run one at a time across the
 * page, so a reload with many panels never fills the low-priority request lane.
 */
import type { SessionCost } from '@/api/session-cost';
import { settledCost } from '@open-walnut/session-cost-settled';

export { settledCost };

export interface SessionCostSnapshot {
  cost: SessionCost | null;
  error: string | null;
}
interface CostClient {
  fetch: (sessionId: string, signal: AbortSignal) => Promise<SessionCost>;
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface Entry {
  snapshot: SessionCostSnapshot;
  listeners: Set<() => void>;
  /** This page's last read that answered (epoch ms), 0 for none. */
  readAt: number;
}
interface Inflight {
  promise: Promise<SessionCost | null>;
  controller: AbortController;
  /** Callers that may let go (an open picker); the read is aborted when the last one does. */
  holders: number;
  /** A caller that never lets go (the prefetch) holds the read to its end. */
  pinned: boolean;
}

export const COST_STORE_KEY = 'walnut.session-cost.v1';
export const COST_STORE_MAX = 100;
const EMPTY: SessionCostSnapshot = { cost: null, error: null };

function isCost(v: unknown): v is SessionCost {
  const c = v as SessionCost | null;
  return !!c && typeof c === 'object' && typeof c.sessionId === 'string' && typeof c.status === 'string' && Array.isArray(c.models);
}

export class SessionCostStore {
  private entries = new Map<string, Entry>();
  /** Finished reads in least-recently-read order: what is saved. */
  private kept = new Map<string, SessionCost>();
  private inflight = new Map<string, Inflight>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Warm-ups waiting for their turn; one runs at a time. */
  private prefetchQueue: { sessionId: string; signal: AbortSignal }[] = [];
  private prefetching = false;

  constructor(private client: CostClient, private storage: Storage | null = null, private now: () => number = Date.now) {
    this.restore();
  }

  getSnapshot = (sessionId: string): SessionCostSnapshot => this.entry(sessionId).snapshot;
  subscribe = (sessionId: string, listener: () => void): (() => void) => {
    const entry = this.entry(sessionId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  };
  /** When this page last got an answer for the session (0: never). */
  readAt(sessionId: string): number { return this.entries.get(sessionId)?.readAt ?? 0; }

  /**
   * Read the session's cost now (one read per session at a time, shared by every caller). With a
   * `signal` the caller may let go; the read is aborted only when every such caller did and no
   * caller without one is waiting. Resolves with what the server said, or null on failure.
   */
  refresh = (sessionId: string, signal?: AbortSignal): Promise<SessionCost | null> => {
    let run = this.inflight.get(sessionId);
    // A read every caller let go of is over even before its rejection lands.
    if (!run || run.controller.signal.aborted) run = this.start(sessionId);
    if (!signal) run.pinned = true;
    else {
      run.holders++;
      const held = run;
      signal.addEventListener('abort', () => {
        held.holders--;
        if (held.holders <= 0 && !held.pinned) held.controller.abort();
      }, { once: true });
    }
    return run.promise;
  };

  /**
   * Warm the session's cost in the background: queued behind any other warm-up on the page and
   * dropped when `signal` aborts (its pill left) before or while it runs. A session already queued
   * is not queued twice.
   */
  prefetch = (sessionId: string, signal: AbortSignal): void => {
    if (signal.aborted || this.prefetchQueue.some((q) => q.sessionId === sessionId && !q.signal.aborted)) return;
    this.prefetchQueue.push({ sessionId, signal });
    this.pumpPrefetch();
  };

  private pumpPrefetch(): void {
    if (this.prefetching) return;
    let next = this.prefetchQueue.shift();
    while (next && next.signal.aborted) next = this.prefetchQueue.shift();
    if (!next) return;
    this.prefetching = true;
    void this.refresh(next.sessionId, next.signal).finally(() => {
      this.prefetching = false;
      this.pumpPrefetch();
    });
  }

  private start(sessionId: string): Inflight {
    const controller = new AbortController();
    const run: Inflight = { controller, holders: 0, pinned: false, promise: Promise.resolve(null) };
    run.promise = this.client.fetch(sessionId, controller.signal).then((cost) => {
      this.accept(sessionId, cost);
      return cost;
    }, (err: unknown) => {
      if (!controller.signal.aborted) this.publish(this.entry(sessionId), { error: 'could not be read' });
      throw err;
    }).finally(() => {
      if (this.inflight.get(sessionId) === run) this.inflight.delete(sessionId);
    }).catch(() => null);
    this.inflight.set(sessionId, run);
    return run;
  }

  private accept(sessionId: string, cost: SessionCost): void {
    const entry = this.entry(sessionId);
    entry.readAt = this.now();
    const shown = entry.snapshot.cost;
    if (settledCost(cost)) {
      this.kept.delete(sessionId);
      this.kept.set(sessionId, cost);
      while (this.kept.size > COST_STORE_MAX) this.kept.delete(this.kept.keys().next().value as string);
      this.scheduleSave();
      this.publish(entry, { cost, error: null });
    } else if (shown && settledCost(shown)) {
      // The known number stays; only a stale error goes.
      if (entry.snapshot.error) this.publish(entry, { error: null });
    } else {
      this.publish(entry, { cost, error: null });
    }
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const cost = this.kept.get(sessionId);
      entry = { snapshot: cost ? { cost, error: null } : EMPTY, listeners: new Set(), readAt: 0 };
      this.entries.set(sessionId, entry);
      this.trimEntries();
    }
    return entry;
  }
  /** Past twice the kept count, forget the oldest views nobody watches or reads. */
  private trimEntries(): void {
    if (this.entries.size <= COST_STORE_MAX * 2) return;
    for (const [id, e] of this.entries) {
      if (this.entries.size <= COST_STORE_MAX) break;
      if (e.listeners.size === 0 && !this.inflight.has(id)) this.entries.delete(id);
    }
  }
  private publish(entry: Entry, patch: Partial<SessionCostSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    for (const listener of entry.listeners) listener();
  }

  private restore(): void {
    if (!this.storage) return;
    let raw: string | null = null;
    try { raw = this.storage.getItem(COST_STORE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      for (const [id, cost] of readSaved(parsed)) this.kept.set(id, cost);
    } catch {
      // A copy this version cannot read is no copy: the next finished read writes a good one.
    }
  }
  private scheduleSave(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, 250);
  }
  /** Write the kept reads over what another tab saved meanwhile (this tab's win, newest last); past
   *  the browser's quota, keep the newer half. */
  save(): void {
    if (!this.storage) return;
    const merged = new Map<string, SessionCost>();
    try {
      const raw = this.storage.getItem(COST_STORE_KEY);
      if (raw) for (const [id, cost] of readSaved(JSON.parse(raw))) if (!this.kept.has(id)) merged.set(id, cost);
    } catch { /* Nothing readable to keep from another tab. */ }
    for (const [id, cost] of this.kept) merged.set(id, cost);
    let entries = [...merged.entries()].slice(-COST_STORE_MAX);
    for (let attempt = 0; attempt < 3 && entries.length > 0; attempt++) {
      try {
        this.storage.setItem(COST_STORE_KEY, JSON.stringify({ entries }));
        return;
      } catch {
        entries = entries.slice(Math.floor(entries.length / 2));
      }
    }
  }
}

/** The finished reads of a saved copy, oldest first; anything of another shape is skipped. */
function readSaved(parsed: unknown): [string, SessionCost][] {
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  const out: [string, SessionCost][] = [];
  for (const item of entries.slice(-COST_STORE_MAX)) {
    if (Array.isArray(item) && typeof item[0] === 'string' && isCost(item[1]) && settledCost(item[1])) out.push([item[0], item[1]]);
  }
  return out;
}
