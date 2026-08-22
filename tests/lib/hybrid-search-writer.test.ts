import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchIndex, type SearchIndex, type Doc } from '../../src/lib/hybrid-search/index.js';

const open = (dbPath = ':memory:') => createSearchIndex({ dbPath });

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    kind: 'task',
    ref: 't1',
    title: 'Reconciler duplicate kind across GVRs check',
    note: 'The AcmeEventOperator watch cache keys by kind alone.',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function ftsMatch(index: SearchIndex, expr: string): number[] {
  return (index.db.prepare(`SELECT rowid FROM doc_fts WHERE doc_fts MATCH ?`)
    .all(expr) as Array<{ rowid: number }>).map((r) => r.rowid);
}

let indexes: SearchIndex[] = [];
function track(index: SearchIndex): SearchIndex {
  indexes.push(index);
  return index;
}
afterEach(() => {
  for (const index of indexes) {
    try { index.close(); } catch { /* already closed */ }
  }
  indexes = [];
});

describe('hybrid-search writer', () => {
  it('upsert indexes orig and sub streams into the right columns', () => {
    const index = track(open());
    const { docId, changed } = index.upsert(doc());
    expect(changed).toBe(true);
    // subword of AcmeEventOperator hits the note field's SUB column only
    expect(ftsMatch(index, 'nsub:"operator"')).toEqual([docId]);
    expect(ftsMatch(index, 'tsub:"operator"')).toEqual([]);
    expect(ftsMatch(index, 'note:"operator"')).toEqual([]);
    // whole identifier survives in the note column
    expect(ftsMatch(index, 'note:"acmeeventoperator"')).toEqual([docId]);
    expect(ftsMatch(index, 'title:"reconciler"')).toEqual([docId]);
  });

  it('same content hash skips FTS work but refreshes updated_at', () => {
    const index = track(open());
    const first = index.upsert(doc());
    const second = index.upsert(doc({ updatedAt: 1_800_000_000_000 }));
    expect(second.changed).toBe(false);
    expect(second.docId).toBe(first.docId);
    const row = index.db.prepare(`SELECT updated_at FROM doc WHERE id = ?`)
      .get(first.docId) as { updated_at: number };
    expect(row.updated_at).toBe(1_800_000_000_000);
  });

  it('content change reuses the SAME rowid (doc_vec/ident reference it)', () => {
    const index = track(open());
    const first = index.upsert(doc());
    const second = index.upsert(doc({ title: 'Renamed check' }));
    expect(second.changed).toBe(true);
    expect(second.docId).toBe(first.docId);
    // old title token must be gone from the index
    expect(ftsMatch(index, 'title:"reconciler"')).toEqual([]);
    expect(ftsMatch(index, 'title:"renamed"')).toEqual([first.docId]);
  });

  it('content change drops stale vectors and rewrites identifiers', () => {
    const index = track(open());
    const { docId } = index.upsert(doc({ identifiers: ['CR-111'] }));
    index.db.prepare(`INSERT INTO doc_vec (doc_id, seq, vec) VALUES (?, 0, ?)`)
      .run(docId, Buffer.alloc(4));
    index.upsert(doc({ note: 'changed', identifiers: ['CR-222'] }));
    const vecs = index.db.prepare(`SELECT COUNT(*) AS n FROM doc_vec`).get() as { n: number };
    expect(vecs.n).toBe(0);
    const idents = (index.db.prepare(`SELECT token FROM ident WHERE doc_id = ?`)
      .all(docId) as Array<{ token: string }>).map((r) => r.token);
    expect(idents).toEqual(['cr-222']);
  });

  it('remove deletes FTS postings and cascades vec + ident', () => {
    const index = track(open());
    const { docId } = index.upsert(doc({ identifiers: ['CR-111'] }));
    index.db.prepare(`INSERT INTO doc_vec (doc_id, seq, vec) VALUES (?, 0, ?)`)
      .run(docId, Buffer.alloc(4));
    expect(index.remove('task', 't1')).toBe(true);
    expect(index.remove('task', 't1')).toBe(false);
    expect(ftsMatch(index, 'title:"reconciler"')).toEqual([]);
    expect((index.db.prepare(`SELECT COUNT(*) AS n FROM ident`).get() as { n: number }).n).toBe(0);
    expect((index.db.prepare(`SELECT COUNT(*) AS n FROM doc_vec`).get() as { n: number }).n).toBe(0);
  });

  it('CJK bigram phrases match in order and reject reordered text', () => {
    const index = track(open());
    const a = index.upsert(doc({ ref: 'cjk1', title: '能否自动重试', note: '' }));
    index.upsert(doc({ ref: 'cjk2', title: '重试后自动上报', note: '' }));
    // ordered bigrams of 自动重试: 自动 动重 重试 — only cjk1 has the contiguous run
    expect(ftsMatch(index, 'tsub:"自动 动重 重试"')).toEqual([a.docId]);
  });

  it('sub phrases cannot chain across field boundaries', () => {
    const index = track(open());
    // title ends 自动 / note begins 重试 — a phrase must not bridge them
    // (structural: each field's sub stream is its own FTS column)
    index.upsert(doc({ ref: 'x', title: '开启自动', note: '重试三次', summary: '', meta: '' }));
    expect(ftsMatch(index, '{tsub ssub nsub msub}:"自动 重试"')).toEqual([]);
  });

  it('rebuildAll wipes and re-feeds (sync + async sources)', async () => {
    const index = track(open());
    index.upsert(doc());
    index.upsert(doc({ ref: 't2', title: 'other thing' }));
    const { inserted } = await index.rebuildAll([doc({ ref: 't3', title: 'only survivor' })]);
    expect(inserted).toBe(1);
    expect(index.stats().docs).toBe(1);
    expect(ftsMatch(index, 'title:"survivor"').length).toBe(1);
    expect(ftsMatch(index, 'title:"reconciler"')).toEqual([]);

    // async source streams through the same path
    async function* source() {
      yield doc({ ref: 'a1', title: 'streamed alpha' });
      yield doc({ ref: 'a2', title: 'streamed beta' });
    }
    const streamed = await index.rebuildAll(source());
    expect(streamed.inserted).toBe(2);
    expect(index.stats().docs).toBe(2);
  });

  it('tokenizer version bump re-tokenizes from stored docs (no data loss)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-test-'));
    const dbPath = path.join(dir, 'search.sqlite');
    try {
      const first = track(createSearchIndex({ dbPath }));
      first.upsert(doc());
      expect(first.needsRebuild).toBe(false);
      first.close();

      // simulate an older tokenizer having built the index
      const tamper = track(createSearchIndex({ dbPath }));
      tamper.db.prepare(`UPDATE meta SET value = '0' WHERE key = 'tokenizer_version'`).run();
      tamper.close();

      const reopened = track(createSearchIndex({ dbPath }));
      expect(reopened.needsRebuild).toBe(false);
      // doc rows survived AND the FTS layer was rebuilt from them at open
      expect(reopened.stats().docs).toBe(1);
      expect(ftsMatch(reopened, 'title:"reconciler"').length).toBe(1);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('doc schema version bump wipes everything and reports needsRebuild', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-test-'));
    const dbPath = path.join(dir, 'search.sqlite');
    try {
      const first = track(createSearchIndex({ dbPath }));
      first.upsert(doc());
      first.db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();
      first.close();

      const reopened = track(createSearchIndex({ dbPath }));
      expect(reopened.needsRebuild).toBe(true);
      expect(reopened.stats().docs).toBe(0);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('embed model change clears vectors but keeps the keyword index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-test-'));
    const dbPath = path.join(dir, 'search.sqlite');
    try {
      const first = track(createSearchIndex({
        dbPath,
        embedder: { modelId: 'model-a', dims: 4 },
      }));
      const { docId } = first.upsert(doc());
      first.db.prepare(`INSERT INTO doc_vec (doc_id, seq, vec) VALUES (?, 0, ?)`)
        .run(docId, Buffer.alloc(4));
      first.close();

      const swapped = track(createSearchIndex({
        dbPath,
        embedder: { modelId: 'model-b', dims: 4 },
      }));
      expect(swapped.needsRebuild).toBe(false);
      expect(swapped.stats().docs).toBe(1);
      expect(swapped.stats().vectors).toBe(0);
      swapped.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
