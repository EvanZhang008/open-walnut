import { log } from '../logging/index.js';

let tail: Promise<void> = Promise.resolve();
let pending = 0;
let activeLabel: string | null = null;
let exclusiveGate: Promise<void> | null = null;
let readGate: Promise<void> | null = null;
let activeReaders = 0;
const readerIdleWaiters = new Set<() => void>();

export class QmdIndexBusyError extends Error {
  constructor() {
    super('QMD indexing is busy');
    this.name = 'QmdIndexBusyError';
  }
}

export interface QmdIndexReservation {
  /** Work submitted before the reservation has finished. */
  drained: Promise<void>;
  /** Allow work submitted after the reservation to continue. Idempotent. */
  release: () => void;
}

export interface QmdIndexReservationOptions {
  /**
   * Stop new searches and wait for active readers. Only required when stores
   * will be closed or reopened with a different embedding model.
   */
  blockReads?: boolean;
}

/**
 * Reserve the queue for an out-of-process indexer.
 *
 * Jobs already in the queue drain normally. Jobs submitted after this call
 * wait without touching SQLite until release(), preventing better-sqlite3's
 * synchronous writes in the web process from overlapping the worker.
 *
 * Normal workers do not block interactive reads: QMD enables SQLite WAL, so
 * readers can continue against the latest committed snapshot while the child
 * writes. Model changes are different because the web stores must be closed;
 * those callers opt into blockReads.
 */
export function reserveQmdIndexWork(
  options: QmdIndexReservationOptions = {},
): QmdIndexReservation {
  if (exclusiveGate) {
    throw new Error('QMD index work is already reserved');
  }

  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  exclusiveGate = gate;
  if (options.blockReads) readGate = gate;
  const readersDrained = !options.blockReads || activeReaders === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => readerIdleWaiters.add(resolve));
  const drained = Promise.all([tail, readersDrained]).then(() => undefined);
  let released = false;

  return {
    drained,
    release: () => {
      if (released) return;
      released = true;
      if (exclusiveGate === gate) exclusiveGate = null;
      if (readGate === gate) readGate = null;
      releaseGate();
    },
  };
}

/**
 * Hold a short-lived read lease around interactive QMD search. Ordinary
 * indexing runs concurrently through SQLite WAL. A model-reset reservation
 * waits for existing readers and rejects new ones until old stores are closed.
 */
export function runQmdReadWork<T>(work: () => Promise<T>): Promise<T> {
  if (readGate) return Promise.reject(new QmdIndexBusyError());
  activeReaders++;

  return Promise.resolve()
    .then(work)
    .finally(() => {
      activeReaders--;
      if (activeReaders !== 0) return;
      for (const resolve of readerIdleWaiters) resolve();
      readerIdleWaiters.clear();
    });
}

/**
 * Serialize QMD index mutations and embedding passes across every store.
 *
 * Each QMD store owns a local model instance. Running embeds concurrently can
 * load several copies of the model and starve both interactive search and the
 * HTTP event loop, so every indexing entry point shares this module-level tail.
 */
export function runQmdIndexWork<T>(
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const queuedAt = Date.now();
  const gate = exclusiveGate;
  pending++;

  const run = tail.then(async () => {
    if (gate) await gate;
    const waitMs = Date.now() - queuedAt;
    activeLabel = label;
    if (waitMs >= 1_000) {
      log.memory.info('QMD index work waited for queue', { label, waitMs, pending });
    }

    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      const durationMs = Date.now() - startedAt;
      pending--;
      activeLabel = null;
      if (durationMs >= 1_000) {
        log.memory.info('QMD index work complete', { label, durationMs, pending });
      }
    }
  });

  // A failed job must not poison the queue. The caller still receives the
  // original rejection through `run`.
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/** Wait until all QMD work already submitted to the queue has settled. */
export async function waitForQmdIndexWork(): Promise<void> {
  await tail;
}

export function getQmdIndexWorkState(): {
  pending: number;
  activeLabel: string | null;
} {
  return { pending, activeLabel };
}
