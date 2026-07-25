export type QmdIncrementalOperation = 'sync' | 'delete';

interface PendingChange {
  generation: number;
  operation: QmdIncrementalOperation;
}

export interface QmdIncrementalQueueOptions {
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Per-ID cooldown: after a successful sync of an ID, further syncs of that
   *  SAME ID are held until the cooldown elapses (they are never dropped — the
   *  latest change flushes once the window opens). Deletes bypass the cooldown.
   *  0 (default) = flush at debounce cadence, the pre-cooldown behavior.
   *
   *  Why: an active session emits session:result every turn; each flush makes
   *  the index worker re-read + re-embed the whole conversation (observed: one
   *  46MB session re-embedded 62×/day with 5GB worker RSS peaks). Search
   *  freshness doesn't need turn-level granularity. */
  minIntervalMs?: number;
  dispatch: (ids: string[]) => Promise<void>;
  onSuccess?: (counts: { synced: number; deleted: number }) => void;
  onError?: (error: unknown, retryInMs: number) => void;
}

export interface QmdIncrementalQueue {
  enqueue: (id: string, operation: QmdIncrementalOperation) => void;
  flushNow: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Debounce QMD entity changes and retain them until a worker acknowledges the
 * batch. Per-ID generations prevent an older successful batch from deleting a
 * newer event that arrived while the worker was running.
 */
export function createQmdIncrementalQueue(
  options: QmdIncrementalQueueOptions,
): QmdIncrementalQueue {
  const debounceMs = Math.max(0, options.debounceMs ?? 2_000);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 1_000);
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? 30_000);
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
  const pending = new Map<string, PendingChange>();
  const lastSyncedAt = new Map<string, number>();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let retryAttempt = 0;
  let stopped = false;

  function schedule(delayMs: number): void {
    if (stopped || timer || inFlight || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  /** Cooldown remaining for an ID; 0 = dispatchable now. Deletes always pass —
   *  removing a deleted entity from the index must not wait. */
  function holdMsFor(id: string, change: PendingChange, now: number): number {
    if (minIntervalMs === 0 || change.operation === 'delete') return 0;
    const last = lastSyncedAt.get(id);
    if (last === undefined) return 0;
    return Math.max(0, last + minIntervalMs - now);
  }

  async function flush(): Promise<void> {
    if (stopped || inFlight || pending.size === 0) {
      await inFlight;
      return;
    }

    // Partition by cooldown: dispatch ready IDs now, leave held IDs pending
    // (their latest generation is preserved) and wake when the earliest
    // cooldown expires.
    const now = Date.now();
    const snapshot = new Map<string, PendingChange>();
    let earliestHold = Infinity;
    for (const [id, change] of pending) {
      const hold = holdMsFor(id, change, now);
      if (hold <= 0) snapshot.set(id, change);
      else earliestHold = Math.min(earliestHold, hold);
    }
    if (snapshot.size === 0) {
      if (earliestHold !== Infinity) schedule(earliestHold);
      return;
    }
    let retryDelay = debounceMs;
    const run = (async () => {
      // Yield once so inFlight is assigned before a synchronously throwing
      // dispatcher can reach finally and clear it.
      await Promise.resolve();
      try {
        await options.dispatch([...snapshot.keys()]);
        const syncedAt = Date.now();
        for (const [id, sent] of snapshot) {
          if (sent.operation === 'sync') lastSyncedAt.set(id, syncedAt);
          else lastSyncedAt.delete(id);
          if (pending.get(id)?.generation === sent.generation) {
            pending.delete(id);
          }
        }
        retryAttempt = 0;
        try {
          options.onSuccess?.({
            synced: [...snapshot.values()]
              .filter((change) => change.operation === 'sync').length,
            deleted: [...snapshot.values()]
              .filter((change) => change.operation === 'delete').length,
          });
        } catch {
          // Observability callbacks must not alter delivery semantics.
        }
      } catch (error) {
        retryAttempt++;
        retryDelay = Math.min(
          retryMaxMs,
          retryBaseMs * (2 ** Math.max(0, retryAttempt - 1)),
        );
        try {
          options.onError?.(error, retryDelay);
        } catch {
          // Observability callbacks must not poison the retry loop.
        }
      } finally {
        inFlight = null;
        if (!stopped && pending.size > 0) schedule(retryDelay);
      }
    })();

    inFlight = run;
    await run;
  }

  return {
    enqueue(id, operation) {
      if (stopped || !id) return;
      pending.set(id, {
        generation: ++generation,
        operation,
      });
      if (timer) clearTimeout(timer);
      timer = null;
      schedule(debounceMs);
    },
    async flushNow() {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
      pending.clear();
    },
  };
}
