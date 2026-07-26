import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embedMemory: vi.fn(async () => undefined),
  flushSessions: vi.fn(async () => undefined),
  flushTasks: vi.fn(async () => undefined),
  cleanup: vi.fn(() => ({
    deletedDocuments: 0,
    deletedContent: 0,
    deletedVectors: 0,
  })),
  dbPragma: vi.fn(),
  getSession: vi.fn(),
  getNotesStore: vi.fn(),
  getSessionStore: vi.fn(),
  getTaskStore: vi.fn(),
  initStores: vi.fn(async () => undefined),
  listTasksByIds: vi.fn(async () => []),
  removeSession: vi.fn(async () => true),
  removeTask: vi.fn(async () => true),
  syncSession: vi.fn(async () => false),
  syncTask: vi.fn(async () => false),
  syncNotes: vi.fn(async () => undefined),
  syncTasks: vi.fn(async () => undefined),
  syncSessions: vi.fn(async () => undefined),
  updateMemory: vi.fn(async () => undefined),
  vacuum: vi.fn(),
}));

vi.mock('@tobilu/qmd', () => ({
  Maintenance: class {
    vacuum(): void {
      mocks.vacuum();
    }
  },
}));

function mockStore(name: string) {
  return {
    name,
    internal: {
      db: {
        pragma: mocks.dbPragma,
      },
    },
  };
}

vi.mock('../../src/core/qmd-store.js', () => ({
  DEFAULT_QMD_MODEL: 'test-model',
  embedQmdStore: vi.fn(async (
    store: { embed: (options: unknown) => Promise<unknown> },
    _label: string,
    options: unknown,
  ) => store.embed(options)),
  getMemoryStore: vi.fn(async () => ({
    ...mockStore('memory-store'),
    update: mocks.updateMemory,
    embed: mocks.embedMemory,
  })),
  getNotesStore: mocks.getNotesStore,
  getSessionStore: mocks.getSessionStore,
  getTaskStore: mocks.getTaskStore,
  initQmdStores: mocks.initStores,
}));

vi.mock('../../src/core/qmd-note-sync.js', () => ({
  syncAllQmdNotes: mocks.syncNotes,
}));

vi.mock('../../src/core/qmd-task-sync.js', () => ({
  flushTaskEmbeddings: mocks.flushTasks,
  removeTask: mocks.removeTask,
  syncAllTasks: mocks.syncTasks,
  syncTask: mocks.syncTask,
}));

vi.mock('../../src/core/qmd-session-sync.js', () => ({
  flushSessionEmbeddings: mocks.flushSessions,
  removeSession: mocks.removeSession,
  syncAllSessions: mocks.syncSessions,
  syncSession: mocks.syncSession,
}));

vi.mock('../../src/core/task-manager.js', () => ({
  listTasksByIds: mocks.listTasksByIds,
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: mocks.getSession,
}));

vi.mock('../../src/core/qmd-sync-utils.js', () => ({
  cleanupOrphanedQmdData: mocks.cleanup,
}));

import {
  cleanupQmdCorpus,
  rebuildQmdCorpus,
  runQmdIncrementalWork,
} from '../../src/core/qmd-maintenance.js';

const previousWorkerFlag = process.env.WALNUT_QMD_WORKER;
const previousEmbedModel = process.env.QMD_EMBED_MODEL;

beforeEach(() => {
  process.env.WALNUT_QMD_WORKER = '1';
  // qmd-maintenance prefers process.env.QMD_EMBED_MODEL over DEFAULT_QMD_MODEL,
  // and setQmdRuntimeModel() writes that variable — so a sibling test file that
  // pinned a runtime model leaks its value in here and beats the mock, making
  // this file fail only when run alongside them.
  delete process.env.QMD_EMBED_MODEL;
  vi.clearAllMocks();
  let pageCountRead = 0;
  mocks.dbPragma.mockImplementation((pragma: string) => {
    if (pragma === 'page_count') {
      pageCountRead++;
      return pageCountRead % 2 === 1 ? 100_000 : 10_000;
    }
    if (pragma === 'freelist_count') return 80_000;
    if (pragma === 'page_size') return 4_096;
    throw new Error(`Unexpected pragma: ${pragma}`);
  });
  mocks.getNotesStore.mockResolvedValue(mockStore('notes-store'));
  mocks.getSessionStore.mockResolvedValue(mockStore('session-store'));
  mocks.getTaskStore.mockResolvedValue(mockStore('task-store'));
});

afterAll(() => {
  if (previousWorkerFlag === undefined) {
    delete process.env.WALNUT_QMD_WORKER;
  } else {
    process.env.WALNUT_QMD_WORKER = previousWorkerFlag;
  }
  if (previousEmbedModel === undefined) {
    delete process.env.QMD_EMBED_MODEL;
  } else {
    process.env.QMD_EMBED_MODEL = previousEmbedModel;
  }
});

describe('full QMD corpus recovery', () => {
  it('rebuilds every canonical source sequentially with forced vectors', async () => {
    await rebuildQmdCorpus({ force: true });

    expect(mocks.updateMemory).toHaveBeenCalledOnce();
    expect(mocks.embedMemory).toHaveBeenCalledWith({
      force: true,
      model: 'test-model',
      onProgress: undefined,
    });
    expect(mocks.syncNotes).toHaveBeenCalledWith({
      force: true,
      onProgress: undefined,
    });
    expect(mocks.syncTasks).toHaveBeenCalledWith({
      force: true,
      onProgress: undefined,
    });
    expect(mocks.syncSessions).toHaveBeenCalledWith({
      force: true,
      onProgress: undefined,
    });
    expect(mocks.embedMemory).toHaveBeenCalledBefore(mocks.syncNotes);
    expect(mocks.syncNotes).toHaveBeenCalledBefore(mocks.syncTasks);
    expect(mocks.syncTasks).toHaveBeenCalledBefore(mocks.syncSessions);
  });

  it('vacuums fragmented stores only when the caller holds the compacting reservation', async () => {
    await cleanupQmdCorpus();
    expect(mocks.vacuum).not.toHaveBeenCalled();

    const result = await cleanupQmdCorpus({ compact: true });

    expect(mocks.vacuum).toHaveBeenCalledTimes(4);
    expect(result.tasks.compaction).toEqual({
      beforeBytes: 409_600_000,
      afterBytes: 40_960_000,
      reclaimedBytes: 368_640_000,
    });
  });

  it.each([
    {
      name: 'free space is below the byte threshold',
      pageCount: 20_000,
      freePages: 10_000,
    },
    {
      name: 'free pages are below the ratio threshold',
      pageCount: 100_000,
      freePages: 20_000,
    },
  ])('skips compaction when $name', async ({ pageCount, freePages }) => {
    mocks.dbPragma.mockImplementation((pragma: string) => {
      if (pragma === 'page_count') return pageCount;
      if (pragma === 'freelist_count') return freePages;
      if (pragma === 'page_size') return 4_096;
      throw new Error(`Unexpected pragma: ${pragma}`);
    });

    const result = await cleanupQmdCorpus({ compact: true });

    expect(mocks.vacuum).not.toHaveBeenCalled();
    expect(result.tasks.compaction).toBeUndefined();
  });

  it('does not resolve initialization until task and session backfill finish', async () => {
    let releaseSessions!: () => void;
    mocks.syncSessions.mockImplementationOnce(() =>
      new Promise<void>((resolve) => { releaseSessions = resolve; }));

    let resolved = false;
    const recovery = rebuildQmdCorpus({ initialize: true })
      .then(() => { resolved = true; });

    await vi.waitFor(() => {
      expect(mocks.syncSessions).toHaveBeenCalledOnce();
    });
    expect(resolved).toBe(false);
    expect(mocks.initStores).toHaveBeenCalledOnce();
    expect(mocks.syncNotes).toHaveBeenCalledOnce();
    expect(mocks.syncTasks).toHaveBeenCalledOnce();

    releaseSessions();
    await recovery;
    expect(resolved).toBe(true);
  });
});

describe('incremental QMD embedding', () => {
  it('does not initialize the embedding model when task content is unchanged', async () => {
    mocks.listTasksByIds.mockResolvedValueOnce([{ id: 'task-a' }]);
    mocks.syncTask.mockResolvedValueOnce(false);

    await runQmdIncrementalWork({
      kind: 'incremental',
      taskIds: ['task-a'],
    });

    expect(mocks.syncTask).toHaveBeenCalledOnce();
    expect(mocks.flushTasks).not.toHaveBeenCalled();
    expect(mocks.getTaskStore).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'task-store' }),
    );
  });

  it('does not initialize the embedding model when session content is unchanged', async () => {
    mocks.getSession.mockResolvedValueOnce({ claudeSessionId: 'session-a' });
    mocks.syncSession.mockResolvedValueOnce(false);

    await runQmdIncrementalWork({
      kind: 'incremental',
      sessionIds: ['session-a'],
    });

    expect(mocks.syncSession).toHaveBeenCalledOnce();
    expect(mocks.flushSessions).not.toHaveBeenCalled();
    expect(mocks.getSessionStore).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'session-store' }),
    );
  });

  it('embeds once when at least one document changed', async () => {
    mocks.listTasksByIds.mockResolvedValueOnce([
      { id: 'task-a' },
      { id: 'task-b' },
    ]);
    mocks.syncTask
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runQmdIncrementalWork({
      kind: 'incremental',
      taskIds: ['task-a', 'task-b'],
    });

    expect(mocks.flushTasks).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'task-store' }),
    );
  });
});
