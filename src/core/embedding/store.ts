/**
 * Embedding store — SQLite BLOB read/write for task and chunk embeddings.
 * Uses the same memory-index.sqlite database as FTS5.
 */

import { getDb } from '../memory-index.js';
import { bufferToFloat32, float32ToBuffer } from './cosine.js';

/** Ensure embedding tables exist (idempotent, called from getDb schema init). */
export function ensureEmbeddingTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_embeddings (
      task_id TEXT PRIMARY KEY,
      composite_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

// ── Task embeddings ──

export function getTaskEmbeddingHash(taskId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT composite_hash FROM task_embeddings WHERE task_id = ?').get(taskId) as { composite_hash: string } | undefined;
  return row?.composite_hash ?? null;
}

export function upsertTaskEmbedding(
  taskId: string,
  compositeHash: string,
  embedding: Float32Array,
  model: string,
): void {
  const db = getDb();
  const buf = float32ToBuffer(embedding);
  db.prepare(`
    INSERT INTO task_embeddings (task_id, composite_hash, embedding, model, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(task_id) DO UPDATE SET
      composite_hash = excluded.composite_hash,
      embedding = excluded.embedding,
      model = excluded.model,
      created_at = excluded.created_at
  `).run(taskId, compositeHash, buf, model);
}

export function deleteTaskEmbedding(taskId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM task_embeddings WHERE task_id = ?').run(taskId);
}

export function getAllTaskEmbeddings(): Array<{ task_id: string; embedding: Float32Array }> {
  const db = getDb();
  const rows = db.prepare('SELECT task_id, embedding FROM task_embeddings').all() as Array<{ task_id: string; embedding: Buffer }>;
  return rows.map((r) => ({
    task_id: r.task_id,
    embedding: bufferToFloat32(r.embedding),
  }));
}

// ── Chunk embeddings ──

export function getChunkEmbeddingIds(): Set<number> {
  const db = getDb();
  const rows = db.prepare('SELECT chunk_id FROM chunk_embeddings').all() as Array<{ chunk_id: number }>;
  return new Set(rows.map((r) => r.chunk_id));
}

export function upsertChunkEmbedding(
  chunkId: number,
  embedding: Float32Array,
  model: string,
): void {
  const db = getDb();
  const buf = float32ToBuffer(embedding);
  db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, embedding, model, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chunk_id) DO UPDATE SET
      embedding = excluded.embedding,
      model = excluded.model,
      created_at = excluded.created_at
  `).run(chunkId, buf, model);
}

export function getAllChunkEmbeddings(): Array<{ chunk_id: number; path: string; text: string; embedding: Float32Array }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ce.chunk_id, f.path, c.text, ce.embedding
    FROM chunk_embeddings ce
    JOIN chunks c ON c.id = ce.chunk_id
    JOIN files f ON f.id = c.file_id
  `).all() as Array<{ chunk_id: number; path: string; text: string; embedding: Buffer }>;
  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    path: r.path,
    text: r.text,
    embedding: bufferToFloat32(r.embedding),
  }));
}

/** Remove chunk embeddings whose chunk_id no longer exists in chunks table. */
export function cleanOrphanedChunkEmbeddings(): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM chunk_embeddings
    WHERE chunk_id NOT IN (SELECT id FROM chunks)
  `).run();
  return result.changes;
}

/** Get all chunk IDs that exist in chunks table but NOT in chunk_embeddings. */
export function getUnembeddedChunkIds(): Array<{ id: number; text: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT c.id, c.text FROM chunks c
    LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id
    WHERE ce.chunk_id IS NULL
  `).all() as Array<{ id: number; text: string }>;
}
