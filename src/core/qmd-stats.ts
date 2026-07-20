import type { QMDStore } from '@tobilu/qmd';
import {
  getMemoryStore,
  getNotesStore,
  getSessionStore,
  getTaskStore,
} from './qmd-store.js';

export interface QmdStoreStats {
  collections: Record<string, {
    indexed: number;
    embedded: number;
    chunks: number;
  }>;
  totalIndexed: number;
  totalEmbedded: number;
  totalChunks: number;
}

export interface QmdCorpusStats {
  memory: QmdStoreStats | null;
  notes: QmdStoreStats | null;
  tasks: QmdStoreStats | null;
  sessions: QmdStoreStats | null;
}

async function collectStoreStats(store: QMDStore): Promise<QmdStoreStats> {
  const collections = await store.listCollections();
  const embeddingStats = new Map<string, { embedded: number; chunks: number }>();

  try {
    const rows = store.internal.db.prepare(`
      SELECT d.collection,
        SUM(CASE WHEN d.hash IN (SELECT hash FROM content_vectors) THEN 1 ELSE 0 END) as embedded,
        (SELECT COUNT(*) FROM content_vectors cv2
         WHERE cv2.hash IN (
           SELECT hash FROM documents
           WHERE collection=d.collection AND active=1
         )
        ) as chunks
      FROM documents d
      WHERE d.active=1
      GROUP BY d.collection
    `).all() as Array<{ collection: string; embedded: number; chunks: number }>;
    for (const row of rows) {
      embeddingStats.set(row.collection, {
        embedded: row.embedded,
        chunks: row.chunks,
      });
    }
  } catch {
    // A new store may not have content_vectors yet.
  }

  const stats: QmdStoreStats = {
    collections: {},
    totalIndexed: 0,
    totalEmbedded: 0,
    totalChunks: 0,
  };
  for (const collection of collections) {
    const embedded = embeddingStats.get(collection.name) ?? {
      embedded: 0,
      chunks: 0,
    };
    stats.collections[collection.name] = {
      indexed: collection.active_count,
      embedded: embedded.embedded,
      chunks: embedded.chunks,
    };
    stats.totalIndexed += collection.active_count;
    stats.totalEmbedded += embedded.embedded;
    stats.totalChunks += embedded.chunks;
  }
  return stats;
}

async function collectSafely(
  getStore: () => Promise<QMDStore>,
): Promise<QmdStoreStats | null> {
  try {
    return await collectStoreStats(await getStore());
  } catch {
    return null;
  }
}

/**
 * Capture status while the caller already owns the QMD indexing context.
 * HTTP handlers must consume the resulting snapshot, never call this directly.
 */
export async function collectQmdCorpusStats(): Promise<QmdCorpusStats> {
  const [memory, notes, tasks, sessions] = await Promise.all([
    collectSafely(getMemoryStore),
    collectSafely(getNotesStore),
    collectSafely(getTaskStore),
    collectSafely(getSessionStore),
  ]);
  return { memory, notes, tasks, sessions };
}
