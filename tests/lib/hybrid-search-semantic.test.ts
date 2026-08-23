/**
 * Semantic-layer logic tests — everything EXCEPT real model inference (that
 * runs in the golden eval): chunking, int8 cosine, vector storage/self-heal,
 * and searchSemantic's degrade ladder (disabled → timeout → keyword order).
 */
import { describe, expect, it } from 'vitest';
import {
  createSearchIndex,
  cosineInt8,
  passagesForDoc,
} from '../../src/lib/hybrid-search/index.js';
import { CHUNK_TARGET_CHARS, MAX_CHUNKS_PER_DOC } from '../../src/lib/hybrid-search/chunk.js';

const KINDS = {
  task: { weight: 1.0 },
  session: { weight: 0.9, chunkVectors: true },
};

describe('passagesForDoc', () => {
  it('doc-level kinds produce one passage: title + summary + note head', () => {
    const p = passagesForDoc(
      { title: 'T', summary: 'S', note: 'N'.repeat(5000) },
      false,
    );
    expect(p).toHaveLength(1);
    expect(p[0].startsWith('T\nS')).toBe(true);
    expect(p[0].length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 4);
  });

  it('chunked kinds split the note on paragraph boundaries, head first', () => {
    const para = 'word '.repeat(100).trim(); // ~500 chars
    const p = passagesForDoc(
      { title: 'Head', note: [para, para, para, para, para].join('\n\n') },
      true,
    );
    expect(p[0]).toBe('Head');
    expect(p.length).toBeGreaterThan(2);
    for (const chunk of p.slice(1)) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 2);
    }
  });

  it('hard-splits an unbroken wall and respects the per-doc cap', () => {
    const p = passagesForDoc(
      { title: 'W', note: 'x'.repeat(CHUNK_TARGET_CHARS * (MAX_CHUNKS_PER_DOC + 10)) },
      true,
    );
    expect(p.length).toBe(MAX_CHUNKS_PER_DOC);
  });

  it('empty doc yields no passages', () => {
    expect(passagesForDoc({ title: '', note: '' }, false)).toEqual([]);
  });

  it('over the cap, keeps the TAIL of a chunked body (recent turns), not the head', () => {
    // Distinct markers per chunk so we can see which side survived the cap.
    const paras: string[] = [];
    for (let i = 0; i < MAX_CHUNKS_PER_DOC + 20; i++) {
      paras.push(`marker-${i} ${'x'.repeat(CHUNK_TARGET_CHARS)}`);
    }
    const p = passagesForDoc({ title: 'Head', note: paras.join('\n\n') }, true);
    expect(p.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
    expect(p[0]).toBe('Head');
    const body = p.slice(1).join('\n');
    expect(body).not.toContain('marker-0 ');           // oldest dropped
    expect(body).toContain(`marker-${MAX_CHUNKS_PER_DOC + 19}`); // newest kept
  });
});

describe('cosineInt8', () => {
  it('is 1 for identical vectors, -1 for opposite, 0 for orthogonal/zero', () => {
    const a = new Int8Array([100, 50, -30]);
    const neg = new Int8Array([-100, -50, 30]);
    expect(cosineInt8(a, a)).toBeCloseTo(1, 6);
    expect(cosineInt8(a, neg)).toBeCloseTo(-1, 6);
    expect(cosineInt8(new Int8Array([127, 0]), new Int8Array([0, 127]))).toBe(0);
    expect(cosineInt8(a, new Int8Array(3))).toBe(0);
  });
});

describe('vector storage', () => {
  it('writeVectors + listDocsMissingVectors + upsert self-heal', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const { docId } = index.upsert({
      kind: 'task', ref: 't1', title: 'Alpha work', note: 'body', updatedAt: 1,
    });
    const w = indexWriterView(index);
    expect(w.listDocsMissingVectors(10).docs.map((d) => d.id)).toContain(docId);

    w.writeVectors(docId, [new Int8Array(4).fill(1), new Int8Array(4).fill(2)]);
    expect(w.listDocsMissingVectors(10).docs).toHaveLength(0);
    expect(vecCount(index)).toBe(2);

    // Content change drops vectors → doc is missing again (self-heal queue).
    index.upsert({ kind: 'task', ref: 't1', title: 'Alpha work v2', note: 'body', updatedAt: 2 });
    expect(vecCount(index)).toBe(0);
    expect(w.listDocsMissingVectors(10).docs.map((d) => d.id)).toContain(docId);

    // Timestamp-only change keeps them.
    w.writeVectors(docId, [new Int8Array(4).fill(3)]);
    index.upsert({ kind: 'task', ref: 't1', title: 'Alpha work v2', note: 'body', updatedAt: 3 });
    expect(vecCount(index)).toBe(1);
    index.close();
  });

  it('remove cascades vectors away', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const { docId } = index.upsert({ kind: 'task', ref: 't1', title: 'Gone soon', updatedAt: 1 });
    indexWriterView(index).writeVectors(docId, [new Int8Array(4).fill(1)]);
    index.remove('task', 't1');
    expect(vecCount(index)).toBe(0);
    index.close();
  });

  it('keyset cursor resumes the missing-vectors walk without revisiting', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(index.upsert({
        kind: 'task', ref: `t${i}`, title: `Doc ${i}`, updatedAt: 100 + i,
      }).docId);
    }
    const w = indexWriterView(index);
    const page1 = w.listDocsMissingVectors(2);
    expect(page1.docs).toHaveLength(2);
    expect(page1.cursor).not.toBeNull();
    const page2 = w.listDocsMissingVectors(2, page1.cursor);
    expect(page2.docs).toHaveLength(2);
    const page3 = w.listDocsMissingVectors(2, page2.cursor);
    expect(page3.docs).toHaveLength(1);
    const all = [...page1.docs, ...page2.docs, ...page3.docs].map((d) => d.id).sort();
    expect(all).toEqual([...ids].sort()); // every doc exactly once
    // Walk order is updated_at DESC — newest first.
    expect(page1.docs.map((d) => d.ref)).toContain('t4');
    index.close();
  });
});

describe('searchSemantic degrade ladder', () => {
  it('no embedder → keyword order, semantic=disabled; backfill drains as no-op', async () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    const hits = await index.searchSemantic('retry timeout');
    expect(hits[0].ref).toBe('t1');
    expect(hits[0].semantic).toBe('disabled');
    expect(await index.backfillVectors()).toEqual({ embedded: 0, drained: true, cursor: null });
    index.close();
  });

  it('embedder configured but worker unavailable → timeout marker, keyword order intact', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: {
        modelId: 'no/such-model',
        dims: 4,
        workerPath: '/nonexistent/embed-worker.js',
      },
    });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    index.upsert({ kind: 'task', ref: 't2', title: 'unrelated doc about retry', updatedAt: 1 });
    const hits = await index.searchSemantic('retry timeout', { semanticDeadlineMs: 200 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe('t1');
    expect(hits[0].semantic).toBe('timeout');
    // sync search still works beside it
    expect(index.search('retry')[0].semantic).toBe('skipped');
    index.close();
  });

  it('semanticDeadlineMs 0 skips the rescore entirely', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: { modelId: 'no/such-model', dims: 4, workerPath: '/nonexistent.js' },
    });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    const hits = await index.searchSemantic('retry', { semanticDeadlineMs: 0 });
    expect(hits[0].semantic).toBe('skipped');
    index.close();
  });

  it('a doc whose embed keeps failing is quarantined instead of wedging the backfill', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: { modelId: 'no/such-model', dims: 4, workerPath: '/nonexistent.js' },
    });
    index.upsert({ kind: 'task', ref: 'poison', title: 'never embeds', updatedAt: 1 });
    // Failure 1: retried next pass; failure 2: quarantined with a zero vector.
    const first = await index.backfillVectors();
    expect(first.embedded).toBe(0);
    const second = await index.backfillVectors();
    expect(second.embedded).toBe(0);
    expect(vecCount(index)).toBe(1); // the zero sentinel
    expect((await index.backfillVectors()).drained).toBe(true);
    index.close();
  });
});

// ── helpers ──

import type { SearchIndex } from '../../src/lib/hybrid-search/index.js';
import { createWriter } from '../../src/lib/hybrid-search/writer.js';

/** The writer surface for a live index (same db handle). */
function indexWriterView(index: SearchIndex) {
  return createWriter(index.db);
}

function vecCount(index: SearchIndex): number {
  return (index.db.prepare('SELECT COUNT(*) AS n FROM doc_vec').get() as { n: number }).n;
}
