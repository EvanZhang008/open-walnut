import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const mocks = vi.hoisted(() => ({
  embedQmdStore: vi.fn(),
  getNotesStore: vi.fn(),
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('qmd-note-sync-test'));
vi.mock('../../src/core/qmd-store.js', () => ({
  DEFAULT_QMD_MODEL: 'test-model',
  embedQmdStore: mocks.embedQmdStore,
  getNotesStore: mocks.getNotesStore,
}));

import { NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import { syncQmdNotePaths } from '../../src/core/qmd-note-sync.js';

interface FakeDocument {
  id: number;
  hash: string;
  title: string;
}

const insertContent = vi.fn();
const insertDocument = vi.fn();
const updateDocument = vi.fn();
const updateDocumentTitle = vi.fn();
const deactivateDocument = vi.fn();
const embed = vi.fn(async () => ({
  docsProcessed: 1,
  chunksEmbedded: 1,
  errors: 0,
  durationMs: 1,
}));
let documents: Map<string, FakeDocument>;
let nextId = 1;

function makeStore() {
  return {
    internal: {
      findActiveDocument: (_collection: string, relPath: string) =>
        documents.get(relPath) ?? null,
      insertContent,
      insertDocument,
      updateDocument,
      updateDocumentTitle,
      deactivateDocument,
    },
    embed,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  documents = new Map();
  nextId = 1;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });

  insertContent.mockImplementation(() => undefined);
  insertDocument.mockImplementation(
    (_collection: string, relPath: string, title: string, hash: string) => {
      documents.set(relPath, { id: nextId++, hash, title });
    },
  );
  updateDocument.mockImplementation(
    (id: number, title: string, hash: string) => {
      const document = [...documents.values()].find((entry) => entry.id === id);
      if (document) Object.assign(document, { title, hash });
    },
  );
  updateDocumentTitle.mockImplementation(
    (id: number, title: string) => {
      const document = [...documents.values()].find((entry) => entry.id === id);
      if (document) document.title = title;
    },
  );

  mocks.getNotesStore.mockResolvedValue(makeStore());
  mocks.embedQmdStore.mockImplementation(
    async (
      target: { embed: (options: unknown) => Promise<unknown> },
      _label: string,
      options: unknown,
    ) => target.embed(options),
  );
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('QMD note title reconciliation', () => {
  it('updates a frontmatter-only title change without re-embedding the body', async () => {
    const relPath = 'projects/search.md';
    const fullPath = path.join(NOTES_DIR, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(
      fullPath,
      '---\ntitle: Old title\n---\nUnchanged semantic body.\n',
      'utf-8',
    );
    await syncQmdNotePaths([relPath]);

    vi.clearAllMocks();
    mocks.getNotesStore.mockResolvedValue(makeStore());
    await fs.writeFile(
      fullPath,
      '---\ntitle: New title\n---\nUnchanged semantic body.\n',
      'utf-8',
    );

    await syncQmdNotePaths([relPath]);

    expect(updateDocumentTitle).toHaveBeenCalledWith(
      expect.any(Number),
      'New title',
      expect.any(String),
    );
    expect(insertContent).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalled();
    expect(mocks.embedQmdStore).not.toHaveBeenCalled();
    expect(documents.get(relPath)?.title).toBe('New title');
  });

  it('does not prune the index when a vault scan fails', async () => {
    const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    try {
      const { syncAllQmdNotes } = await import('../../src/core/qmd-note-sync.js');

      await expect(syncAllQmdNotes()).rejects.toThrow('permission denied');

      expect(deactivateDocument).not.toHaveBeenCalled();
      expect(mocks.embedQmdStore).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
    }
  });
});
