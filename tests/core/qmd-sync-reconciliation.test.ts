import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, type QMDStore } from '@tobilu/qmd';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupOrphanedQmdData,
  pruneStaleQmdDocuments,
} from '../../src/core/qmd-sync-utils.js';

function insertDocument(
  store: QMDStore,
  documentPath: string,
  title: string,
  body: string,
): string {
  const now = new Date().toISOString();
  const hash = createHash('sha256').update(body).digest('hex');
  store.internal.insertContent(hash, body, now);
  store.internal.insertDocument('tasks', documentPath, title, hash, now, now);
  return hash;
}

describe('pruneStaleQmdDocuments', () => {
  it('logically deactivates a stale document in a real QMD lexical index', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-qmd-prune-'));
    const store = await createStore({
      dbPath: path.join(tempDir, 'search.sqlite'),
      config: {
        collections: {
          tasks: {
            path: tempDir,
            pattern: '__qmd_programmatic_only__',
          },
        },
      },
    });

    try {
      const currentHash = insertDocument(
        store,
        'task-current',
        'Current task',
        'currentamberneedle',
      );
      const staleHash = insertDocument(
        store,
        'task-stale',
        'Stale task',
        'stalequartzneedle',
      );
      const cleanupOrphanedVectors = vi.spyOn(
        store.internal,
        'cleanupOrphanedVectors',
      );
      const deleteInactiveDocuments = vi.spyOn(
        store.internal,
        'deleteInactiveDocuments',
      );
      const cleanupOrphanedContent = vi.spyOn(
        store.internal,
        'cleanupOrphanedContent',
      );

      const before = await store.searchLex('stalequartzneedle', {
        collection: 'tasks',
      });
      expect(before.map((result) => result.filepath)).toContain('qmd://tasks/task-stale');

      const stats = pruneStaleQmdDocuments(
        store,
        'tasks',
        new Set(['task-current']),
      );

      expect(stats.deactivated).toBe(1);
      expect(cleanupOrphanedVectors).not.toHaveBeenCalled();
      expect(deleteInactiveDocuments).not.toHaveBeenCalled();
      expect(cleanupOrphanedContent).not.toHaveBeenCalled();
      await expect(store.searchLex('stalequartzneedle', {
        collection: 'tasks',
      })).resolves.toEqual([]);
      await expect(store.searchLex('currentamberneedle', {
        collection: 'tasks',
      })).resolves.toEqual([
        expect.objectContaining({ filepath: 'qmd://tasks/task-current' }),
      ]);

      expect(store.internal.db.prepare(`
        SELECT path, hash, active
        FROM documents
        WHERE collection = 'tasks'
        ORDER BY path
      `).all()).toEqual([
        { path: 'task-current', hash: currentHash, active: 1 },
        { path: 'task-stale', hash: staleHash, active: 0 },
      ]);
      expect(store.internal.db.prepare(
        'SELECT hash, doc FROM content WHERE hash = ?',
      ).get(staleHash)).toEqual({
        hash: staleHash,
        doc: 'stalequartzneedle',
      });

      const [collection] = await store.listCollections();
      expect(collection).toMatchObject({
        name: 'tasks',
        doc_count: 2,
        active_count: 1,
      });
    } finally {
      await store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('retains physical content and vector rows for a deactivated document', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-qmd-vector-prune-'));
    const store = await createStore({
      dbPath: path.join(tempDir, 'search.sqlite'),
      config: {
        collections: {
          tasks: {
            path: tempDir,
            pattern: '__qmd_programmatic_only__',
          },
        },
      },
    });

    try {
      const currentHash = insertDocument(
        store,
        'task-current',
        'Current task',
        'current vector body',
      );
      const staleHash = insertDocument(
        store,
        'task-stale',
        'Stale task',
        'stale vector body',
      );
      const now = new Date().toISOString();
      store.internal.ensureVecTable(2);
      store.internal.insertEmbedding(
        currentHash,
        0,
        0,
        new Float32Array([1, 0]),
        'test-model',
        now,
      );
      store.internal.insertEmbedding(
        staleHash,
        0,
        0,
        new Float32Array([0, 1]),
        'test-model',
        now,
      );

      expect(store.internal.db.prepare(
        'SELECT COUNT(*) AS count FROM content_vectors',
      ).get()).toEqual({ count: 2 });
      expect(store.internal.db.prepare(
        'SELECT COUNT(*) AS count FROM vectors_vec',
      ).get()).toEqual({ count: 2 });

      const stats = pruneStaleQmdDocuments(
        store,
        'tasks',
        new Set(['task-current']),
      );

      expect(stats.deactivated).toBe(1);
      expect(store.internal.db.prepare(
        'SELECT path, hash, active FROM documents WHERE path = ?',
      ).get('task-stale')).toEqual({
        path: 'task-stale',
        hash: staleHash,
        active: 0,
      });
      expect(store.internal.db.prepare(
        'SELECT hash, doc FROM content WHERE hash = ?',
      ).get(staleHash)).toEqual({
        hash: staleHash,
        doc: 'stale vector body',
      });
      expect(store.internal.db.prepare(
        'SELECT COUNT(*) AS count FROM content_vectors',
      ).get()).toEqual({ count: 2 });
      expect(store.internal.db.prepare(
        'SELECT hash FROM content_vectors WHERE hash = ?',
      ).get(staleHash)).toEqual({ hash: staleHash });
      expect(store.internal.db.prepare(
        'SELECT COUNT(*) AS count FROM vectors_vec',
      ).get()).toEqual({ count: 2 });
      expect(store.internal.db.prepare(
        'SELECT hash_seq FROM vectors_vec WHERE hash_seq = ?',
      ).get(`${staleHash}_0`)).toEqual({ hash_seq: `${staleHash}_0` });
    } finally {
      await store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('removes stale vectors that would crowd active semantic hits out of top-k', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-qmd-vector-crowding-'));
    const store = await createStore({
      dbPath: path.join(tempDir, 'search.sqlite'),
      config: {
        collections: {
          tasks: {
            path: tempDir,
            pattern: '__qmd_programmatic_only__',
          },
        },
      },
    });
    const previousWorkerFlag = process.env.WALNUT_QMD_WORKER;

    try {
      store.internal.ensureVecTable(2);
      const activeHash = insertDocument(
        store,
        'task-active',
        'Active task',
        'active semantic result',
      );
      store.internal.insertEmbedding(
        activeHash,
        0,
        0,
        new Float32Array([0, 1]),
        'test-model',
        new Date().toISOString(),
      );

      for (let index = 0; index < 120; index++) {
        const staleHash = insertDocument(
          store,
          `task-stale-${index}`,
          `Stale task ${index}`,
          `stale semantic result ${index}`,
        );
        store.internal.insertEmbedding(
          staleHash,
          0,
          0,
          new Float32Array([1, 0]),
          'test-model',
          new Date().toISOString(),
        );
      }

      pruneStaleQmdDocuments(store, 'tasks', new Set(['task-active']));
      const queryEmbedding = new Float32Array([1, 0]);
      await expect(store.internal.searchVec(
        'semantic query',
        'test-model',
        40,
        'tasks',
        undefined,
        queryEmbedding,
      )).resolves.toEqual([]);

      process.env.WALNUT_QMD_WORKER = '1';
      expect(cleanupOrphanedQmdData(store)).toEqual({
        deletedDocuments: 120,
        deletedContent: 120,
        deletedVectors: 120,
      });

      await expect(store.internal.searchVec(
        'semantic query',
        'test-model',
        40,
        'tasks',
        undefined,
        queryEmbedding,
      )).resolves.toEqual([
        expect.objectContaining({ filepath: 'qmd://tasks/task-active' }),
      ]);
    } finally {
      if (previousWorkerFlag === undefined) {
        delete process.env.WALNUT_QMD_WORKER;
      } else {
        process.env.WALNUT_QMD_WORKER = previousWorkerFlag;
      }
      await store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
