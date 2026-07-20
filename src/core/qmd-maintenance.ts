import { Maintenance, type QMDStore } from '@tobilu/qmd';
import type { Database as DatabaseType } from 'better-sqlite3';
import { log } from '../logging/index.js';
import {
  DEFAULT_QMD_MODEL,
  embedQmdStore,
  getMemoryStore,
  getNotesStore,
  getSessionStore,
  getTaskStore,
  initQmdStores,
} from './qmd-store.js';
import { syncAllQmdNotes, syncQmdNotePaths } from './qmd-note-sync.js';
import {
  flushTaskEmbeddings,
  removeTask,
  syncAllTasks,
  syncTask,
} from './qmd-task-sync.js';
import {
  flushSessionEmbeddings,
  removeSession,
  syncAllSessions,
  syncSession,
} from './qmd-session-sync.js';
import {
  cleanupOrphanedQmdData,
  type QmdOrphanCleanupStats,
} from './qmd-sync-utils.js';
import { runQmdIndexWork } from './qmd-work-queue.js';
import { listTasksByIds } from './task-manager.js';
import { getSessionByClaudeId } from './session-tracker.js';
import type {
  QmdEmbedProgress,
  QmdIncrementalIndexWork,
} from './qmd-worker-protocol.js';

export interface RebuildQmdCorpusOptions {
  /** Initialize stores and download the model before reconciling the corpus. */
  initialize?: boolean;
  /** Recompute vectors even when the content hash already has an embedding. */
  force?: boolean;
  onProgress?: (store: string, progress: QmdEmbedProgress) => void;
}

/**
 * Reconcile every QMD-backed source and return only when all stores are ready.
 * Admin download/reindex routes share this path so "ready" always includes
 * memory, notes, tasks, and sessions.
 */
export async function rebuildQmdCorpus(
  options: RebuildQmdCorpusOptions = {},
): Promise<void> {
  const onProgress = options.onProgress;

  if (options.initialize) {
    await runQmdIndexWork('qmd:initialize', () =>
      initQmdStores({ force: options.force, onProgress }));
  } else {
    await runQmdIndexWork('memory:full-reindex', async () => {
      const store = await getMemoryStore();
      await store.update();
      await embedQmdStore(store, 'memory', {
        ...(options.force ? { force: true } : {}),
        model: process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL,
        onProgress: onProgress
          ? (progress) => onProgress('memory', progress)
          : undefined,
      });
    });
  }

  await runQmdIndexWork('notes:full-sync', () =>
    syncAllQmdNotes({
      force: options.initialize ? false : options.force,
      onProgress: onProgress
        ? (progress) => onProgress('notes', progress)
        : undefined,
    }));

  await runQmdIndexWork('tasks:full-sync', () =>
    syncAllTasks({
      force: options.initialize ? false : options.force,
      onProgress: onProgress
        ? (progress) => onProgress('task', progress)
        : undefined,
    }));

  await runQmdIndexWork('sessions:full-sync', () =>
    syncAllSessions({
      force: options.initialize ? false : options.force,
      onProgress: onProgress
        ? (progress) => onProgress('session', progress)
        : undefined,
    }));
}

export interface RunQmdIncrementalWorkOptions {
  onProgress?: (store: string, progress: QmdEmbedProgress) => void;
}

const MIN_COMPACTION_FREE_BYTES = 64 * 1024 * 1024;
const MIN_COMPACTION_FREE_RATIO = 0.25;

export interface QmdCompactionStats {
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
}

export interface QmdCleanupStats extends QmdOrphanCleanupStats {
  compaction?: QmdCompactionStats;
}

export interface CleanupQmdCorpusOptions {
  /**
   * Run VACUUM when fragmentation is material. Callers must already have
   * drained readers and blocked new searches for the worker's lifetime.
   */
  compact?: boolean;
}

function cleanupIncrementalStore(
  store: Awaited<ReturnType<typeof getTaskStore>>,
): void {
  // Tests deliberately execute incremental work inline. Native sqlite-vec
  // deletion remains confined to the low-priority child process.
  if (process.env.WALNUT_QMD_WORKER !== '1') return;
  cleanupOrphanedQmdData(store);
}

/**
 * Apply one coalesced incremental pass inside the standalone QMD worker.
 * Missing task/session IDs are treated as deletions so callers only need to
 * enqueue the stable ID; the worker reads the current source of truth.
 */
export async function runQmdIncrementalWork(
  work: QmdIncrementalIndexWork,
  options: RunQmdIncrementalWorkOptions = {},
): Promise<void> {
  const onProgress = options.onProgress;

  if (work.memory) {
    await runQmdIndexWork('memory:incremental-sync', async () => {
      const store = await getMemoryStore();
      await store.update();
      await embedQmdStore(store, 'memory', {
        model: process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL,
        onProgress: onProgress
          ? (progress) => onProgress('memory', progress)
          : undefined,
      });
      cleanupIncrementalStore(store);
    });
  }

  if (work.notesFull) {
    await runQmdIndexWork('notes:full-sync', async () => {
      await syncAllQmdNotes({
        force: work.forceNotes,
        onProgress: onProgress
          ? (progress) => onProgress('notes', progress)
          : undefined,
      });
      cleanupIncrementalStore(await getNotesStore());
    });
  } else if (work.notePaths?.length) {
    await runQmdIndexWork('notes:incremental-sync', async () => {
      await syncQmdNotePaths(work.notePaths!, {
        onProgress: onProgress
          ? (progress) => onProgress('notes', progress)
          : undefined,
      });
      cleanupIncrementalStore(await getNotesStore());
    });
  }

  if (work.taskIds?.length) {
    await runQmdIndexWork('tasks:incremental-sync', async () => {
      const ids = [...new Set(work.taskIds)];
      const tasks = await listTasksByIds(ids);
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      let needsEmbedding = false;
      for (const id of ids) {
        const task = taskById.get(id);
        if (task) needsEmbedding = await syncTask(task) || needsEmbedding;
        else await removeTask(id);
      }
      if (needsEmbedding) await flushTaskEmbeddings();
      cleanupIncrementalStore(await getTaskStore());
    });
  }

  if (work.sessionIds?.length) {
    await runQmdIndexWork('sessions:incremental-sync', async () => {
      let needsEmbedding = false;
      for (const id of new Set(work.sessionIds)) {
        const session = await getSessionByClaudeId(id);
        if (session) needsEmbedding = await syncSession(session) || needsEmbedding;
        else await removeSession(id);
      }
      if (needsEmbedding) await flushSessionEmbeddings();
      cleanupIncrementalStore(await getSessionStore());
    });
  }
}

function compactQmdStoreIfNeeded(
  store: QMDStore,
  label: string,
): QmdCompactionStats | null {
  // QMD's public InternalStore type exposes only the cross-runtime database
  // subset, while Walnut's installed QMD backend is better-sqlite3.
  const db = store.internal.db as DatabaseType;
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const freePages = db.pragma('freelist_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const beforeBytes = pageCount * pageSize;
  const freeBytes = freePages * pageSize;
  const freeRatio = pageCount > 0 ? freePages / pageCount : 0;

  if (
    freeBytes < MIN_COMPACTION_FREE_BYTES
    || freeRatio < MIN_COMPACTION_FREE_RATIO
  ) {
    return null;
  }

  const startedAt = Date.now();
  new Maintenance(store.internal).vacuum();
  const afterBytes = (
    db.pragma('page_count', { simple: true }) as number
  ) * pageSize;
  const stats = {
    beforeBytes,
    afterBytes,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
  };
  log.memory.info('QMD store compacted', {
    store: label,
    durationMs: Date.now() - startedAt,
    ...stats,
  });
  return stats;
}

/**
 * Physically compact every QMD store after a full reconciliation.
 *
 * sqlite-vec deletion is synchronous and can take minutes on a large index, so
 * this function is guarded for the standalone QMD worker process.
 */
export async function cleanupQmdCorpus(
  options: CleanupQmdCorpusOptions = {},
): Promise<Record<string, QmdCleanupStats>> {
  if (process.env.WALNUT_QMD_WORKER !== '1') {
    throw new Error('QMD corpus cleanup must run in the QMD worker process');
  }

  const stores = [
    ['memory', getMemoryStore],
    ['notes', getNotesStore],
    ['tasks', getTaskStore],
    ['sessions', getSessionStore],
  ] as const;
  const result: Record<string, QmdCleanupStats> = {};

  for (const [name, getStore] of stores) {
    result[name] = await runQmdIndexWork(`${name}:orphan-cleanup`, async () => {
      const store = await getStore();
      const cleanup = cleanupOrphanedQmdData(store);
      if (!options.compact) return cleanup;
      try {
        const compaction = compactQmdStoreIfNeeded(store, name);
        return compaction ? { ...cleanup, compaction } : cleanup;
      } catch (error) {
        // Reclaiming disk is optional; a failed VACUUM must not invalidate the
        // successfully rebuilt search index.
        log.memory.warn('QMD store compaction failed', {
          store: name,
          error: error instanceof Error ? error.message : String(error),
        });
        return cleanup;
      }
    });
  }
  return result;
}
