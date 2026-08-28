import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initLogging, log } from '../logging/index.js';
import {
  cleanupQmdCorpus,
  rebuildQmdCorpus,
  runQmdIncrementalWork,
} from '../core/qmd-maintenance.js';
import { closeQmdStores } from '../core/qmd-store.js';
import { collectQmdCorpusStats } from '../core/qmd-stats.js';
import { closeDb as closeSessionDb } from '../core/session-db.js';
import { closeDb as closeTaskDb } from '../core/task-db.js';
import type {
  QmdFullIndexWork,
  QmdIndexWork,
  QmdWorkerMessage,
} from '../core/qmd-worker-protocol.js';
import { disconnectAllDaemons } from '../providers/daemon-connection.js';

export type WorkerOptions =
  | QmdIndexWork
  | Omit<QmdFullIndexWork, 'kind'>;

function send(message: QmdWorkerMessage): void {
  if (process.connected) process.send?.(message);
}

function parseOptions(): QmdIndexWork {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith('{'));
  if (!raw) return { kind: 'full' };
  return normalizeWork(JSON.parse(raw) as WorkerOptions);
}

function normalizeWork(options: WorkerOptions): QmdIndexWork {
  if ('kind' in options) return options;
  return { kind: 'full', ...options };
}

function closeSourceDatabases(): void {
  closeTaskDb();
  closeSessionDb();
}

/**
 * Execute one worker pass and release every resource that can keep the child
 * event loop alive. Session indexing may open pooled daemon connections whose
 * heartbeat timers otherwise prevent a clean process exit.
 */
export async function executeQmdIndexWork(
  options: WorkerOptions,
  emit: (message: QmdWorkerMessage) => void = send,
): Promise<void> {
  const work = normalizeWork(options);
  try {
    let cleanup: unknown;
    if (work.kind === 'full') {
      await rebuildQmdCorpus({
        initialize: work.initialize,
        force: work.force,
        onProgress: (store, progress) => emit({ type: 'progress', store, progress }),
      });
      cleanup = await cleanupQmdCorpus({ compact: work.compact === true });
    } else {
      await runQmdIncrementalWork(work, {
        onProgress: (store, progress) => emit({ type: 'progress', store, progress }),
      });
    }
    const stats = await collectQmdCorpusStats();
    log.memory.info('QMD background worker complete', {
      pid: process.pid,
      kind: work.kind,
      ...(cleanup ? { cleanup } : {}),
    });
    emit({ type: 'complete', stats });
  } finally {
    // Release source-of-truth handles first. Native model cleanup may take
    // longer, but a finished worker must never block the next server startup.
    closeSourceDatabases();
    await closeQmdStores().catch(() => undefined);
    disconnectAllDaemons();
  }
}

async function main(): Promise<void> {
  initLogging();
  try {
    os.setPriority(0, 10);
  } catch {
    // Priority adjustment is best-effort on platforms that permit it.
  }

  const work = parseOptions();
  let priority: number | null = null;
  try {
    priority = os.getPriority();
  } catch {
    // Reading priority is also best-effort on unsupported platforms.
  }
  log.memory.info('QMD background worker started', {
    pid: process.pid,
    kind: work.kind,
    initialize: work.kind === 'full' && work.initialize === true,
    force: work.kind === 'full' && work.force === true,
    priority,
  });

  try {
    await executeQmdIndexWork(work);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.memory.error('QMD background worker failed', { error: message });
    send({ type: 'error', error: message });
    process.exitCode = 1;
  }
}

const isDirectEntry = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectEntry) {
  const onParentDisconnect = () => {
    closeSourceDatabases();
    disconnectAllDaemons();
    process.exit(1);
  };
  process.once('disconnect', onParentDisconnect);

  void main().finally(() => {
    process.off('disconnect', onParentDisconnect);
    // Do not call process.exit() here. Metal residency sets can outlive the
    // awaited store close briefly, and forced normal exit triggers GGML_ASSERT.
    if (process.connected) process.disconnect();
  });
}
