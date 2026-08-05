import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord, Task } from '../../src/core/types.js';

const mocks = vi.hoisted(() => ({
  cleanupOrphanedContent: vi.fn(() => 1),
  cleanupOrphanedVectors: vi.fn(() => 2),
  deactivateDocument: vi.fn(),
  deleteInactiveDocuments: vi.fn(() => 0),
  embed: vi.fn(async () => undefined),
  findActiveDocument: vi.fn(),
  getHashesNeedingEmbedding: vi.fn(() => 0),
  getActiveDocumentPaths: vi.fn((): string[] => []),
  insertContent: vi.fn(),
  insertDocument: vi.fn(),
  updateDocument: vi.fn(),
}));

vi.mock('../../src/core/qmd-store.js', () => ({
  DEFAULT_QMD_MODEL: 'test-model',
  embedQmdStore: vi.fn(async (
    store: { embed: (options: unknown) => Promise<unknown> },
    _label: string,
    options: unknown,
  ) => store.embed(options)),
  getTaskStore: vi.fn(async () => ({
    internal: {
      cleanupOrphanedContent: mocks.cleanupOrphanedContent,
      cleanupOrphanedVectors: mocks.cleanupOrphanedVectors,
      deactivateDocument: mocks.deactivateDocument,
      deleteInactiveDocuments: mocks.deleteInactiveDocuments,
      findActiveDocument: mocks.findActiveDocument,
      getHashesNeedingEmbedding: mocks.getHashesNeedingEmbedding,
      getActiveDocumentPaths: mocks.getActiveDocumentPaths,
      insertContent: mocks.insertContent,
      insertDocument: mocks.insertDocument,
      updateDocument: mocks.updateDocument,
    },
    embed: mocks.embed,
  })),
  getSessionStore: vi.fn(async () => ({
    internal: {
      cleanupOrphanedContent: mocks.cleanupOrphanedContent,
      cleanupOrphanedVectors: mocks.cleanupOrphanedVectors,
      deactivateDocument: mocks.deactivateDocument,
      deleteInactiveDocuments: mocks.deleteInactiveDocuments,
      findActiveDocument: mocks.findActiveDocument,
      getHashesNeedingEmbedding: mocks.getHashesNeedingEmbedding,
      getActiveDocumentPaths: mocks.getActiveDocumentPaths,
      insertContent: mocks.insertContent,
      insertDocument: mocks.insertDocument,
      updateDocument: mocks.updateDocument,
    },
    embed: mocks.embed,
  })),
}));

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: vi.fn(async () => []),
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
}));

import {
  flushTaskEmbeddings,
  removeTask,
  serializeTaskForSearch,
  syncAllTasks,
  syncTask,
} from '../../src/core/qmd-task-sync.js';
import {
  flushSessionEmbeddings,
  removeSession,
  syncAllSessions,
  syncSession,
} from '../../src/core/qmd-session-sync.js';

const task = {
  id: 'task-current',
  title: 'Updated task content',
  project: 'Quick Start',
  status: 'todo',
  phase: 'TODO',
  priority: 'none',
  source: 'local',
  session_ids: [],
  description: '',
  summary: '',
  note: '',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as Task;

const session = {
  claudeSessionId: 'session-current',
  title: 'Updated session content',
  cwd: '/tmp/walnut-session',
  project: 'Quick Start',
} as SessionRecord;

function expectNoPhysicalCleanup(): void {
  expect(mocks.cleanupOrphanedVectors).not.toHaveBeenCalled();
  expect(mocks.deleteInactiveDocuments).not.toHaveBeenCalled();
  expect(mocks.cleanupOrphanedContent).not.toHaveBeenCalled();
}

const previousEmbedModel = process.env.QMD_EMBED_MODEL;

afterAll(() => {
  if (previousEmbedModel === undefined) delete process.env.QMD_EMBED_MODEL;
  else process.env.QMD_EMBED_MODEL = previousEmbedModel;
});

beforeEach(() => {
  // See qmd-maintenance.test.ts: setQmdRuntimeModel() writes QMD_EMBED_MODEL,
  // so a sibling file that pinned a model leaks it here and beats the mocked
  // DEFAULT_QMD_MODEL — these specs then fail only in a parallel run.
  delete process.env.QMD_EMBED_MODEL;
  vi.clearAllMocks();
  mocks.getActiveDocumentPaths.mockReturnValue([]);
  mocks.findActiveDocument.mockReturnValue({
    id: 7,
    hash: 'old-content-hash',
    title: 'Old task content',
  });
});

describe('QMD sync hot paths', () => {
  it('keeps semantic content stable when only opaque session references change', () => {
    const withDifferentReferences = {
      ...task,
      session_id: 'legacy-session-id',
      session_ids: ['historical-session-id'],
      plan_session_id: 'plan-session-id',
      exec_session_id: 'exec-session-id',
      external_url: 'https://example.invalid/task/reference',
    };

    expect(serializeTaskForSearch(withDifferentReferences))
      .toBe(serializeTaskForSearch(task));
  });

  it('deactivates stale tasks during full sync without physical cleanup', async () => {
    mocks.getActiveDocumentPaths.mockReturnValue(['task-stale']);

    await syncAllTasks();

    expect(mocks.deactivateDocument)
      .toHaveBeenCalledWith('tasks', 'task-stale');
    expectNoPhysicalCleanup();
    expect(mocks.embed).toHaveBeenCalledWith({ model: 'test-model' });
  });

  it('deactivates stale sessions during full sync without physical cleanup', async () => {
    mocks.getActiveDocumentPaths.mockReturnValue(['sess-stale']);

    await syncAllSessions();

    expect(mocks.deactivateDocument)
      .toHaveBeenCalledWith('sessions', 'sess-stale');
    expectNoPhysicalCleanup();
    expect(mocks.embed).toHaveBeenCalledWith({ model: 'test-model' });
  });

  it('embeds an updated task without physical orphan cleanup', async () => {
    await syncTask(task);

    expect(mocks.updateDocument).toHaveBeenCalledOnce();

    await flushTaskEmbeddings();

    expectNoPhysicalCleanup();
    expect(mocks.embed).toHaveBeenCalledWith({ model: 'test-model' });
  });

  it('embeds after a task document is deactivated without physical cleanup', async () => {
    await removeTask(task.id);
    await flushTaskEmbeddings();

    expect(mocks.deactivateDocument).toHaveBeenCalledWith('tasks', `task-${task.id}`);
    expectNoPhysicalCleanup();
    expect(mocks.embed).toHaveBeenCalledWith({ model: 'test-model' });
  });

  it('embeds an updated session without physical orphan cleanup', async () => {
    await syncSession(session, undefined, { includeContent: false });
    await flushSessionEmbeddings();

    expect(mocks.updateDocument).toHaveBeenCalledOnce();
    expectNoPhysicalCleanup();
    expect(mocks.embed).toHaveBeenCalledWith({ model: 'test-model' });
  });

  it('embeds after a session document is deactivated without physical cleanup', async () => {
    await removeSession('session-to-remove');
    await flushSessionEmbeddings();

    expect(mocks.deactivateDocument)
      .toHaveBeenCalledWith('sessions', 'sess-session-to-remove');
    expectNoPhysicalCleanup();
    expect(mocks.embed).toHaveBeenCalledWith({ model: 'test-model' });
  });
});
