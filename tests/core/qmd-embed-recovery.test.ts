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
): QMDStore {
  return {
    internal: {
      db,
      getHashesForEmbedding: () => [{
        hash: 'touched',
        body: 'body',
        path: 'task-touched',
      }],
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
  it('clears only hashes touched by an interrupted pass before retrying', async () => {
    const db = createDatabase();
    insertVector(db, 'stable', 0);
    let attempt = 0;
    let rowsSeenByRetry: { touched: number; stable: number } | null = null;
    const store = makeStore(db, vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        insertVector(db, 'touched', 0);
        insertVector(db, 'touched', 1);
        throw new Error('process interrupted');
      }

      rowsSeenByRetry = {
        touched: countRows(db, 'content_vectors', 'touched'),
        stable: countRows(db, 'content_vectors', 'stable'),
      };
      insertVector(db, 'touched', 0);
      insertVector(db, 'touched', 1);
      return {
        docsProcessed: 1,
        chunksEmbedded: 2,
        errors: 0,
        durationMs: 1,
      };
    }));

    await expect(embedQmdStore(store, 'task', { model: 'test-model' }))
      .rejects.toThrow('process interrupted');
    expect(countRows(db, 'content_vectors', 'touched')).toBe(2);

    await embedQmdStore(store, 'task', { model: 'test-model' });

    expect(rowsSeenByRetry).toEqual({ touched: 0, stable: 1 });
    expect(countRows(db, 'content_vectors', 'touched')).toBe(2);
    expect(countRows(db, 'vectors_vec', 'stable')).toBe(1);
    const marker = db.prepare(
      'SELECT COUNT(*) AS count FROM walnut_qmd_embed_runs',
    ).get() as { count: number };
    expect(marker.count).toBe(0);
  });

  it('rejects reported chunk errors and clears their partial vectors', async () => {
    const db = createDatabase();
    insertVector(db, 'stable', 0);
    const store = makeStore(db, vi.fn(async () => {
      insertVector(db, 'touched', 0);
      return {
        docsProcessed: 1,
        chunksEmbedded: 1,
        errors: 1,
        durationMs: 1,
      };
    }));

    await expect(embedQmdStore(store, 'task', { model: 'test-model' }))
      .rejects.toThrow(
        'QMD task: embedding failed for 1 chunk(s); partial vectors cleared for retry',
      );

    expect(countRows(db, 'content_vectors', 'touched')).toBe(0);
    expect(countRows(db, 'vectors_vec', 'touched')).toBe(0);
    expect(countRows(db, 'content_vectors', 'stable')).toBe(1);
    const marker = db.prepare(
      'SELECT COUNT(*) AS count FROM walnut_qmd_embed_runs',
    ).get() as { count: number };
    expect(marker.count).toBe(1);
  });
});
