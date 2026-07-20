import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectStats: vi.fn(async () => ({
    memory: null,
    notes: null,
    tasks: null,
    sessions: null,
  })),
  runIncremental: vi.fn(async () => undefined),
  scheduleIncremental: vi.fn(async () => undefined),
}));

vi.mock('../../src/core/qmd-background-indexer.js', () => ({
  scheduleQmdIncrementalIndex: mocks.scheduleIncremental,
}));
vi.mock('../../src/core/qmd-maintenance.js', () => ({
  runQmdIncrementalWork: mocks.runIncremental,
}));
vi.mock('../../src/core/qmd-stats.js', () => ({
  collectQmdCorpusStats: mocks.collectStats,
}));

import { dispatchQmdIncrementalIndex } from '../../src/core/qmd-dispatcher.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QMD inline dispatcher', () => {
  it('publishes the same post-index statistics callback as the worker path', async () => {
    const onStats = vi.fn();

    await dispatchQmdIncrementalIndex({ taskIds: ['task-a'] }, { onStats });

    expect(mocks.runIncremental).toHaveBeenCalledWith(
      { kind: 'incremental', taskIds: ['task-a'] },
      { onProgress: undefined },
    );
    expect(mocks.collectStats).toHaveBeenCalledOnce();
    expect(onStats).toHaveBeenCalledWith({
      memory: null,
      notes: null,
      tasks: null,
      sessions: null,
    });
    expect(mocks.scheduleIncremental).not.toHaveBeenCalled();
  });
});
