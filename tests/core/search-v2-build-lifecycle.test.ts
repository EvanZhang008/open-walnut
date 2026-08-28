import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeIndex: vi.fn(),
  closeSessionDb: vi.fn(),
  closeTaskDb: vi.fn(),
  disconnectDaemons: vi.fn(),
  listSessions: vi.fn(async () => []),
  listTasks: vi.fn(async () => []),
  rebuildAll: vi.fn(),
  stats: vi.fn(() => ({ docs: 0 })),
}));

vi.mock('../../src/constants.js', () => ({
  GLOBAL_SKILLS_DIR: '/tmp/walnut-search-build-test/skills',
  MEMORY_DIR: '/tmp/walnut-search-build-test/memory',
  NOTES_DIR: '/tmp/walnut-search-build-test/notes',
}));

vi.mock('../../src/lib/hybrid-search/index.js', () => ({
  createSearchIndex: () => ({
    close: mocks.closeIndex,
    rebuildAll: mocks.rebuildAll,
    stats: mocks.stats,
  }),
}));

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: mocks.listTasks,
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: mocks.listSessions,
}));

vi.mock('../../src/core/task-db.js', () => ({
  closeDb: mocks.closeTaskDb,
}));

vi.mock('../../src/core/session-db.js', () => ({
  closeDb: mocks.closeSessionDb,
}));

vi.mock('../../src/providers/daemon-connection.js', () => ({
  disconnectAllDaemons: mocks.disconnectDaemons,
}));

vi.mock('../../src/core/session-history.js', () => ({
  readSessionHistoryTail: vi.fn(),
}));

vi.mock('../../src/core/session-content-indexer.js', () => ({
  buildIndexedContent: vi.fn(),
}));

vi.mock('../../src/core/search/serializers.js', () => ({
  markdownToDoc: vi.fn(),
  sessionToDoc: vi.fn(),
  taskToDoc: vi.fn(),
}));

import { buildFullSearchIndex } from '../../src/core/search/build.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rebuildAll.mockImplementation(async (docs: AsyncIterable<unknown>) => {
    for await (const _doc of docs) {
      // Consume the source iterator so task and session databases are opened.
    }
    return { inserted: 0 };
  });
});

describe('full search build lifecycle', () => {
  it('releases source databases and daemon connections after success', async () => {
    await expect(buildFullSearchIndex({ dbPath: '/tmp/search.sqlite' })).resolves.toMatchObject({
      inserted: 0,
    });

    expect(mocks.listTasks).toHaveBeenCalledOnce();
    expect(mocks.listSessions).toHaveBeenCalledOnce();
    expect(mocks.closeTaskDb).toHaveBeenCalledOnce();
    expect(mocks.closeSessionDb).toHaveBeenCalledOnce();
    expect(mocks.closeIndex).toHaveBeenCalledOnce();
    expect(mocks.disconnectDaemons).toHaveBeenCalledOnce();
    expect(mocks.closeTaskDb).toHaveBeenCalledBefore(mocks.disconnectDaemons);
    expect(mocks.closeSessionDb).toHaveBeenCalledBefore(mocks.disconnectDaemons);
  });

  it('releases every handle when rebuilding fails', async () => {
    mocks.rebuildAll.mockRejectedValueOnce(new Error('rebuild failed'));

    await expect(
      buildFullSearchIndex({ dbPath: '/tmp/search.sqlite' }),
    ).rejects.toThrow('rebuild failed');

    expect(mocks.closeTaskDb).toHaveBeenCalledOnce();
    expect(mocks.closeSessionDb).toHaveBeenCalledOnce();
    expect(mocks.closeIndex).toHaveBeenCalledOnce();
    expect(mocks.disconnectDaemons).toHaveBeenCalledOnce();
  });
});
