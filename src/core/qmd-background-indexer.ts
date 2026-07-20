import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_EPHEMERAL, WALNUT_HOME } from '../constants.js';
import {
  reserveQmdIndexWork,
  type QmdIndexReservation,
} from './qmd-work-queue.js';
import type { QmdCorpusStats } from './qmd-stats.js';
import type {
  QmdEmbedProgress,
  QmdIndexWork,
  QmdIncrementalIndexWork,
  QmdWorkerMessage,
} from './qmd-worker-protocol.js';
import {
  initializeQmdRuntimeModel,
  setQmdRuntimeModel,
} from './qmd-model.js';

export interface QmdBackgroundIndexOptions {
  initialize?: boolean;
  force?: boolean;
  /** Apply this model before the worker starts. Defaults to the active model. */
  model?: string;
  /** Drop Web-process stores after readers drain so they reopen on `model`. */
  resetStores?: boolean;
  onStats?: (stats: QmdCorpusStats) => void;
  onProgress?: (store: string, progress: QmdEmbedProgress) => void;
}

export interface QmdBackgroundCallbacks {
  onStats?: (stats: QmdCorpusStats) => void;
  onProgress?: (store: string, progress: QmdEmbedProgress) => void;
}

interface QueueWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  callbacks: QmdBackgroundCallbacks;
}

interface QueueEntry {
  work: QmdIndexWork;
  waiters: QueueWaiter[];
  model?: string;
  resetStores?: boolean;
}

interface ActiveWorker {
  child: ChildProcess | null;
  reservation: QmdIndexReservation;
  stopRequested: boolean;
  finished: Promise<void>;
  finish: () => void;
  settle: (error?: Error) => void;
}

let activeWorker: ActiveWorker | null = null;
const queue: QueueEntry[] = [];
let stopping = false;

function resolveWorkerPath(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(baseDir, 'workers', 'qmd-index-worker.js'),
    path.join(baseDir, '..', 'workers', 'qmd-index-worker.js'),
    path.join(process.cwd(), 'dist', 'workers', 'qmd-index-worker.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`QMD worker build is missing (checked ${candidates.join(', ')})`);
  }
  return found;
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeIncrementalWork(
  work: Omit<QmdIncrementalIndexWork, 'kind'>,
): QmdIncrementalIndexWork {
  return {
    kind: 'incremental',
    ...(work.memory ? { memory: true } : {}),
    ...(work.notesFull ? { notesFull: true } : {}),
    ...(work.forceNotes ? { forceNotes: true } : {}),
    taskIds: normalizeList(work.taskIds),
    sessionIds: normalizeList(work.sessionIds),
    notePaths: normalizeList(work.notePaths),
  };
}

function hasIncrementalWork(work: QmdIncrementalIndexWork): boolean {
  return Boolean(
    work.memory
    || work.notesFull
    || work.taskIds?.length
    || work.sessionIds?.length
    || work.notePaths?.length
  );
}

function mergeIncrementalWork(
  target: QmdIncrementalIndexWork,
  incoming: QmdIncrementalIndexWork,
): void {
  target.memory ||= incoming.memory;
  target.notesFull ||= incoming.notesFull;
  target.forceNotes ||= incoming.forceNotes;
  target.taskIds = normalizeList([...(target.taskIds ?? []), ...(incoming.taskIds ?? [])]);
  target.sessionIds = normalizeList([...(target.sessionIds ?? []), ...(incoming.sessionIds ?? [])]);
  target.notePaths = normalizeList([...(target.notePaths ?? []), ...(incoming.notePaths ?? [])]);
}

function enqueue(
  work: QmdIndexWork,
  callbacks: QmdBackgroundCallbacks,
  mergeIncremental: boolean,
  execution: Pick<QmdBackgroundIndexOptions, 'model' | 'resetStores'> = {},
): Promise<void> {
  if (stopping) {
    return Promise.reject(new Error('QMD background indexer is stopping'));
  }

  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const waiter: QueueWaiter = {
    resolve: resolvePromise,
    reject: rejectPromise,
    callbacks,
  };

  const tail = queue.at(-1);
  if (
    mergeIncremental
    && work.kind === 'incremental'
    && tail?.work.kind === 'incremental'
  ) {
    mergeIncrementalWork(tail.work, work);
    tail.waiters.push(waiter);
  } else {
    queue.push({
      work,
      waiters: [waiter],
      model: execution.model,
      resetStores: execution.resetStores,
    });
  }

  void drainQueue();
  return promise;
}

async function drainQueue(): Promise<void> {
  if (activeWorker || stopping) return;
  const entry = queue.shift();
  if (!entry) return;

  let reservation: QmdIndexReservation;
  try {
    reservation = reserveQmdIndexWork({
      blockReads: entry.resetStores === true,
    });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const waiter of entry.waiters) waiter.reject(normalized);
    queueMicrotask(() => { void drainQueue(); });
    return;
  }

  let finishedResolve!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishedResolve = resolve;
  });
  let settled = false;
  let workerError: string | null = null;
  let workerStats: QmdCorpusStats | null = null;

  const record: ActiveWorker = {
    child: null,
    reservation,
    stopRequested: false,
    finished,
    finish: finishedResolve,
    settle: () => {},
  };

  const settle = (error?: Error): void => {
    if (settled) return;
    settled = true;
    reservation.release();
    if (activeWorker === record) activeWorker = null;

    if (error) {
      for (const waiter of entry.waiters) waiter.reject(error);
    } else {
      if (workerStats) {
        for (const waiter of entry.waiters) waiter.callbacks.onStats?.(workerStats);
      }
      for (const waiter of entry.waiters) waiter.resolve();
    }
    record.finish();
    queueMicrotask(() => {
      if (!stopping) void drainQueue();
    });
  };
  record.settle = settle;
  activeWorker = record;

  try {
    await reservation.drained;
    if (record.stopRequested || stopping || activeWorker !== record) {
      settle(new Error('QMD background index stopped'));
      return;
    }

    const workerModel = entry.model ?? await initializeQmdRuntimeModel();
    if (entry.resetStores) {
      // The reservation has drained active readers and rejects new ones until
      // worker exit, so no request can retain or recreate an old-model store.
      setQmdRuntimeModel(workerModel);
      const { closeQmdStores } = await import('./qmd-store.js');
      await closeQmdStores();
    }

    const args = [JSON.stringify(entry.work)];
    if (IS_EPHEMERAL) args.push('--_ephemeral-child');
    const child = fork(resolveWorkerPath(), args, {
      env: {
        ...process.env,
        OPEN_WALNUT_HOME: WALNUT_HOME,
        WALNUT_QMD_WORKER: '1',
        QMD_EMBED_MODEL: workerModel,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    record.child = child;

    child.on('message', (raw: QmdWorkerMessage) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.type === 'progress' && raw.store && raw.progress) {
        for (const waiter of entry.waiters) {
          waiter.callbacks.onProgress?.(raw.store, raw.progress);
        }
      } else if (raw.type === 'complete' && raw.stats) {
        workerStats = raw.stats as QmdCorpusStats;
      } else if (raw.type === 'error') {
        workerError = raw.error ?? 'QMD worker failed';
      }
    });
    child.once('error', (error) => settle(error));
    child.once('exit', (code, signal) => {
      if (record.stopRequested || stopping) {
        settle(new Error('QMD background index stopped'));
      } else if (code === 0) {
        settle();
      } else {
        settle(new Error(
          workerError
          ?? `QMD worker exited with code ${code ?? 'null'} (${signal ?? 'no signal'})`,
        ));
      }
    });
  } catch (error) {
    settle(error instanceof Error ? error : new Error(String(error)));
  }
}

export function isQmdBackgroundIndexRunning(): boolean {
  return activeWorker !== null || queue.length > 0;
}

export function runQmdBackgroundIndex(
  options: QmdBackgroundIndexOptions = {},
): Promise<void> {
  return enqueue(
    {
      kind: 'full',
      initialize: options.initialize === true,
      force: options.force === true,
      // VACUUM needs exclusive database access. resetStores means the parent
      // has drained readers and will reject new searches until worker exit.
      compact: options.resetStores === true,
    },
    options,
    false,
    { model: options.model, resetStores: options.resetStores },
  );
}

export function scheduleQmdIncrementalIndex(
  work: Omit<QmdIncrementalIndexWork, 'kind'>,
  callbacks: QmdBackgroundCallbacks = {},
): Promise<void> {
  const normalized = normalizeIncrementalWork(work);
  if (!hasIncrementalWork(normalized)) return Promise.resolve();
  return enqueue(normalized, callbacks, true);
}

export async function stopQmdBackgroundIndex(): Promise<void> {
  stopping = true;
  const stoppedError = new Error('QMD background index stopped');
  for (const entry of queue.splice(0)) {
    for (const waiter of entry.waiters) waiter.reject(stoppedError);
  }

  const record = activeWorker;
  if (record) {
    record.stopRequested = true;
    if (record.child) {
      record.child.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        const child = record.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 5_000);
      forceTimer.unref();
      await record.finished;
      clearTimeout(forceTimer);
    } else {
      record.settle(stoppedError);
      await record.finished;
    }
  }

  stopping = false;
}
