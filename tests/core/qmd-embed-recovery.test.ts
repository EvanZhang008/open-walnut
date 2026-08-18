import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QMDStore } from '@tobilu/qmd';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn(),
}));
vi.mock('../../src/constants.js', () =>
  createMockConstants('qmd-embed-recovery-test'));

import { embedQmdStore } from '../../src/core/qmd-store.js';

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      pos INTEGER NOT NULL,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    );
    CREATE TABLE vectors_vec (
      hash_seq TEXT PRIMARY KEY,
      embedding BLOB
    );
  `);
  databases.push(db);
  return db;
}

function insertVector(
  db: Database.Database,
  hash: string,
  seq: number,
): void {
  db.prepare(`
    INSERT INTO content_vectors (hash, seq, pos, model, embedded_at)
    VALUES (?, ?, ?, 'test-model', '2026-07-19T00:00:00.000Z')
  `).run(hash, seq, seq);
  db.prepare(
    'INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)',
  ).run(`${hash}_${seq}`, Buffer.from([seq]));
}

function countRows(
  db: Database.Database,
  table: 'content_vectors' | 'vectors_vec',
  hash: string,
): number {
  const column = table === 'content_vectors' ? 'hash' : 'hash_seq';
  const suffix = table === 'vectors_vec' ? '%' : '';
  const operator = table === 'vectors_vec' ? 'LIKE' : '=';
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} ${operator} ?`,
  ).get(`${hash}${suffix}`) as { count: number };
  return row.count;
}

function makeStore(
  db: Database.Database,
  embed: (options: unknown) => Promise<{
    docsProcessed: number;
    chunksEmbedded: number;
    errors: number;
    durationMs: number;
  }>,
  candidateHashes: string[] = ['touched'],
): QMDStore {
  return {
    internal: {
      db,
      getHashesForEmbedding: () => candidateHashes
        .filter((hash) => {
          const completed = db.prepare(
            'SELECT 1 FROM content_vectors WHERE hash = ? AND seq = 0',
          ).get(hash);
          return !completed;
        })
        .map((hash) => ({
          hash,
          body: 'body',
          path: `task-${hash}`,
        })),
      clearAllEmbeddings: () => {
        db.exec('DELETE FROM content_vectors; DELETE FROM vectors_vec;');
      },
    },
    embed,
  } as unknown as QMDStore;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('QMD embedding recovery marker', () => {
  it('retains completed documents and retries only incomplete documents after interruption', async () => {
    const db = createDatabase();
    insertVector(db, 'stable', 0);
    let attempt = 0;
    let retryState: {
      completed: number;
      partial: number;
      stable: number;
      markerHashes: string[];
      recoveryVersion: number;
    } | null = null;
    const store = makeStore(db, vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        insertVector(db, 'completed', 1);
        insertVector(db, 'completed', 0);
        insertVector(db, 'partial', 1);
        throw new Error('process interrupted');
      }

      const marker = db.prepare(`
        SELECT hashes_json, recovery_version
        FROM walnut_qmd_embed_runs
        WHERE id = 1
      `).get() as { hashes_json: string; recovery_version: number };
      retryState = {
        completed: countRows(db, 'content_vectors', 'completed'),
        partial: countRows(db, 'content_vectors', 'partial'),
        stable: countRows(db, 'content_vectors', 'stable'),
        markerHashes: JSON.parse(marker.hashes_json) as string[],
        recoveryVersion: marker.recovery_version,
      };
      insertVector(db, 'partial', 1);
      insertVector(db, 'partial', 0);
      return {
        docsProcessed: 1,
        chunksEmbedded: 2,
        errors: 0,
        durationMs: 1,
      };
    }), ['completed', 'partial']);

    await expect(embedQmdStore(store, 'task', { model: 'test-model' }))
      .rejects.toThrow('process interrupted');
    expect(countRows(db, 'content_vectors', 'completed')).toBe(2);
    expect(countRows(db, 'content_vectors', 'partial')).toBe(1);

    await embedQmdStore(store, 'task', { model: 'test-model' });

    expect(retryState).toEqual({
      completed: 2,
      partial: 0,
      stable: 1,
      markerHashes: ['partial'],
      recoveryVersion: 2,
    });
    expect(countRows(db, 'content_vectors', 'completed')).toBe(2);
    expect(countRows(db, 'content_vectors', 'partial')).toBe(2);
    expect(countRows(db, 'vectors_vec', 'stable')).toBe(1);
    const marker = db.prepare(
      'SELECT COUNT(*) AS count FROM walnut_qmd_embed_runs',
    ).get() as { count: number };
    expect(marker.count).toBe(0);
  });

  it('preserves completed documents when reported chunk errors clear incomplete vectors', async () => {
    const db = createDatabase();
    insertVector(db, 'stable', 0);
    const store = makeStore(db, vi.fn(async () => {
      insertVector(db, 'completed', 1);
      insertVector(db, 'completed', 0);
      insertVector(db, 'partial', 1);
      return {
        docsProcessed: 1,
        chunksEmbedded: 3,
        errors: 1,
        durationMs: 1,
      };
    }), ['completed', 'partial']);

    await expect(embedQmdStore(store, 'task', { model: 'test-model' }))
      .rejects.toThrow(
        'QMD task: embedding failed for 1 chunk(s); incomplete vectors cleared for retry; 1 completed document(s) retained',
      );

    expect(countRows(db, 'content_vectors', 'completed')).toBe(2);
    expect(countRows(db, 'vectors_vec', 'completed')).toBe(2);
    expect(countRows(db, 'content_vectors', 'partial')).toBe(0);
    expect(countRows(db, 'vectors_vec', 'partial')).toBe(0);
    expect(countRows(db, 'content_vectors', 'stable')).toBe(1);
    const marker = db.prepare(
      'SELECT COUNT(*) AS count FROM walnut_qmd_embed_runs',
    ).get() as { count: number };
    expect(marker.count).toBe(1);
  });

  it('clears every touched hash from a legacy marker before using version 2', async () => {
    const db = createDatabase();
    db.exec(`
      CREATE TABLE walnut_qmd_embed_runs (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        model TEXT NOT NULL,
        force INTEGER NOT NULL,
        hashes_json TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
    `);
    insertVector(db, 'legacy-partial', 0);
    insertVector(db, 'legacy-partial', 1);
    insertVector(db, 'stable', 0);
    db.prepare(`
      INSERT INTO walnut_qmd_embed_runs
        (id, model, force, hashes_json, started_at)
      VALUES (1, 'test-model', 0, ?, '2026-07-19T00:00:00.000Z')
    `).run(JSON.stringify(['legacy-partial']));

    let stateDuringRetry: {
      legacyRows: number;
      stableRows: number;
      recoveryVersion: number;
    } | null = null;
    const store = makeStore(db, vi.fn(async () => {
      const marker = db.prepare(`
        SELECT recovery_version
        FROM walnut_qmd_embed_runs
        WHERE id = 1
      `).get() as { recovery_version: number };
      stateDuringRetry = {
        legacyRows: countRows(db, 'content_vectors', 'legacy-partial'),
        stableRows: countRows(db, 'content_vectors', 'stable'),
        recoveryVersion: marker.recovery_version,
      };
      return {
        docsProcessed: 1,
        chunksEmbedded: 1,
        errors: 0,
        durationMs: 1,
      };
    }), ['legacy-partial']);

    await embedQmdStore(store, 'task', { model: 'test-model' });

    expect(stateDuringRetry).toEqual({
      legacyRows: 0,
      stableRows: 1,
      recoveryVersion: 2,
    });
    const markerCount = db.prepare(
      'SELECT COUNT(*) AS count FROM walnut_qmd_embed_runs',
    ).get() as { count: number };
    expect(markerCount.count).toBe(0);
  });
});
