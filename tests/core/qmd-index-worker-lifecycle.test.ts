import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => ({ sessions: { removed: 0 } })),
  closeSessionDb: vi.fn(),
  closeStores: vi.fn(async () => undefined),
  closeTaskDb: vi.fn(),
  collectStats: vi.fn(async () => ({
    memory: null,
    notes: null,
    tasks: null,
    sessions: {
      collections: {},
      totalIndexed: 1,
      totalEmbedded: 1,
      totalChunks: 1,
    },
  })),
  disconnectDaemons: vi.fn(),
  incremental: vi.fn(async () => undefined),
  rebuild: vi.fn(async () => undefined),
}));

vi.mock('../../src/core/qmd-maintenance.js', () => ({
  cleanupQmdCorpus: mocks.cleanup,
  rebuildQmdCorpus: mocks.rebuild,
  runQmdIncrementalWork: mocks.incremental,
}));

vi.mock('../../src/core/qmd-store.js', () => ({
  closeQmdStores: mocks.closeStores,
}));

vi.mock('../../src/core/session-db.js', () => ({
  closeDb: mocks.closeSessionDb,
}));

vi.mock('../../src/core/task-db.js', () => ({
  closeDb: mocks.closeTaskDb,
}));

vi.mock('../../src/core/qmd-stats.js', () => ({
  collectQmdCorpusStats: mocks.collectStats,
}));

vi.mock('../../src/providers/daemon-connection.js', () => ({
  disconnectAllDaemons: mocks.disconnectDaemons,
}));

import { executeQmdIndexWork } from '../../src/workers/qmd-index-worker.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QMD index worker lifecycle', () => {
  it('releases daemon heartbeat connections after a successful session backfill', async () => {
    const emitted: Array<{ type: string }> = [];

    await executeQmdIndexWork(
      { initialize: true },
      (message) => emitted.push(message),
    );

    expect(mocks.rebuild).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledWith({ compact: false });
    expect(mocks.collectStats).toHaveBeenCalledOnce();
    expect(emitted.at(-1)?.type).toBe('complete');
    expect(mocks.closeTaskDb).toHaveBeenCalledOnce();
    expect(mocks.closeSessionDb).toHaveBeenCalledOnce();
    expect(mocks.closeStores).toHaveBeenCalledOnce();
    expect(mocks.disconnectDaemons).toHaveBeenCalledOnce();
    expect(mocks.closeTaskDb).toHaveBeenCalledBefore(mocks.closeStores);
    expect(mocks.closeSessionDb).toHaveBeenCalledBefore(mocks.closeStores);
    expect(mocks.closeStores).toHaveBeenCalledBefore(mocks.disconnectDaemons);
  });

  it('runs incremental work without physical corpus cleanup', async () => {
    const emitted: Array<{ type: string }> = [];
    const work = {
      kind: 'incremental' as const,
      taskIds: ['task-a'],
      notePaths: ['notes/a.md'],
    };

    await executeQmdIndexWork(work, (message) => emitted.push(message));

    expect(mocks.incremental).toHaveBeenCalledWith(work, {
      onProgress: expect.any(Function),
    });
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.collectStats).toHaveBeenCalledOnce();
    expect(emitted.at(-1)?.type).toBe('complete');
    expect(mocks.closeStores).toHaveBeenCalledOnce();
    expect(mocks.disconnectDaemons).toHaveBeenCalledOnce();
  });

  it('releases source databases when indexing fails', async () => {
    mocks.rebuild.mockRejectedValueOnce(new Error('index failed'));

    await expect(executeQmdIndexWork({ initialize: true })).rejects.toThrow(
      'index failed',
    );

    expect(mocks.closeTaskDb).toHaveBeenCalledOnce();
    expect(mocks.closeSessionDb).toHaveBeenCalledOnce();
    expect(mocks.closeStores).toHaveBeenCalledOnce();
    expect(mocks.disconnectDaemons).toHaveBeenCalledOnce();
  });

  it('requests compaction only for an explicitly guarded full rebuild', async () => {
    await executeQmdIndexWork(
      {
        kind: 'full',
        initialize: true,
        compact: true,
      },
      () => undefined,
    );

    expect(mocks.cleanup).toHaveBeenCalledWith({ compact: true });
  });
});
