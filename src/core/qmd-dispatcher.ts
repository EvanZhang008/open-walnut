import {
  scheduleQmdIncrementalIndex,
  type QmdBackgroundCallbacks,
} from './qmd-background-indexer.js';
import type { QmdIncrementalIndexWork } from './qmd-worker-protocol.js';

const executionMode =
  process.env.NODE_ENV === 'test' ? 'inline' : 'worker';

export function usesQmdIndexWorker(): boolean {
  return executionMode === 'worker';
}

export async function dispatchQmdIncrementalIndex(
  work: Omit<QmdIncrementalIndexWork, 'kind'>,
  callbacks: QmdBackgroundCallbacks = {},
): Promise<void> {
  if (executionMode === 'worker') {
    await scheduleQmdIncrementalIndex(work, callbacks);
    return;
  }

  const { runQmdIncrementalWork } = await import('./qmd-maintenance.js');
  await runQmdIncrementalWork({ kind: 'incremental', ...work }, {
    onProgress: callbacks.onProgress,
  });
  if (callbacks.onStats) {
    const { collectQmdCorpusStats } = await import('./qmd-stats.js');
    callbacks.onStats(await collectQmdCorpusStats());
  }
}
