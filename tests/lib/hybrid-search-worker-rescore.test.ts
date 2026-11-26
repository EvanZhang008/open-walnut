/**
 * The semantic rescore's vector read runs in the query worker, never on the
 * host thread (2026-11: that read, `SELECT ... FROM doc_vec WHERE doc_id IN`,
 * was the server's biggest synchronous SQLite site: cold overflow-page I/O,
 * 270-480 ms per call in production). Covers the guard (no such statement on
 * the host connection, same ranking as the in-thread read), the degrade paths
 * (worker error, budget), and the real worker's rescore job.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';
import { createEmbedder, type Embedder } from '../../src/lib/hybrid-search/embedder.js';
import { readMaxCosines } from '../../src/lib/hybrid-search/doc-vec-cosine.js';
import { createWriter } from '../../src/lib/hybrid-search/writer.js';
import { setSqliteCallObserver } from '../../src/lib/sqlite.js';
import { drainBackfill, makeTempDir, openTextIndex, type TextIndexHandle } from './text-embed-index.js';

const KINDS = { task: { weight: 1.0 } };
const FAKE_EMBEDDER = {
  modelId: 'fake/unit-x',
  dims: 4,
  workerPath: new URL('./fixtures/fake-embed-worker.cjs', import.meta.url).pathname,
};
const TEXT_WORKER = new URL('./fixtures/text-embed-worker.cjs', import.meta.url).pathname;
const REAL_WORKER = path.resolve(import.meta.dirname, '..', '..', 'src', 'lib', 'hybrid-search', 'embed-worker.ts');
const HOST_VEC_READ = /FROM\s+doc_vec\s+WHERE\s+doc_id\s+IN/i;

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  setSqliteCallObserver(null);
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Every statement source run on this thread while `fn` runs. */
async function hostStatements<T>(fn: () => Promise<T>): Promise<{ result: T; sources: string[] }> {
  const sources: string[] = [];
  setSqliteCallObserver({ begin: () => null, end: (source) => { sources.push(source); } });
  try {
    return { result: await fn(), sources };
  } finally {
    setSqliteCallObserver(null);
  }
}

/** Eight docs that all match the query; vectors order them against recency. */
function seed(index: SearchIndex, now: number): void {
  const w = createWriter(index.db);
  for (let i = 0; i < 8; i++) {
    const { docId } = index.upsert({
      kind: 'task', ref: `doc-${i}`, title: 'orbit telemetry alert', note: `body ${i}`,
      updatedAt: now - i * 60_000,
    });
    // Older docs point closer to the query's [127,0,0,0]; doc-3 has two chunk
    // vectors (the max counts), doc-5 one of another length (skipped), doc-6 none.
    if (i === 6) continue;
    if (i === 5) { w.writeVectors(docId, [new Int8Array([127, 0, 0])]); continue; }
    const vecs = [new Int8Array([10 * i, 100 - 10 * i, 0, 0])];
    if (i === 3) vecs.push(new Int8Array([127, 5, 0, 0]));
    w.writeVectors(docId, vecs);
  }
}

describe('searchSemantic with a worker that can rescore', () => {
  it('reads no doc_vec rows on the host thread and ranks as the in-thread read did', async () => {
    const now = Date.now();
    const dir = tempDir('hs-worker-rescore-');
    const fileIndex = createSearchIndex({ dbPath: path.join(dir, 'search.sqlite'), kinds: KINDS, embedder: FAKE_EMBEDDER });
    // Same docs and vectors, in memory: no other process can open it, so its
    // embedder has no rescore() and it reads in-thread (the old path).
    const memIndex = createSearchIndex({ dbPath: ':memory:', kinds: KINDS, embedder: FAKE_EMBEDDER });
    cleanups.push(async () => {
      for (const ix of [fileIndex, memIndex]) { await ix.stopEmbedder(); ix.close(); }
    });
    seed(fileIndex, now);
    seed(memIndex, now);

    const opts = { limit: 8, semanticDeadlineMs: 10_000 };
    const inThread = await hostStatements(() => memIndex.searchSemantic('orbit telemetry', opts));
    // The fixture itself proves the guard can fail: the old path runs the read here.
    expect(inThread.sources.some((s) => HOST_VEC_READ.test(s))).toBe(true);

    const { result: hits, sources } = await hostStatements(() => fileIndex.searchSemantic('orbit telemetry', opts));
    expect(sources.filter((s) => HOST_VEC_READ.test(s))).toEqual([]);
    expect(hits[0].semantic).toBe('ok');
    expect(hits.map((h) => h.ref)).toEqual(inThread.result.map((h) => h.ref));
    hits.forEach((h, i) => {
      const want = inThread.result[i];
      if (want.components.cosine === undefined) expect(h.components.cosine).toBeUndefined();
      else expect(h.components.cosine).toBeCloseTo(want.components.cosine, 9);
      expect(h.score).toBeCloseTo(want.score, 6);
    });
    // The vectors really reordered the page: keyword order is newest first.
    expect(hits[0].ref).not.toBe('doc-0');
    expect(hits.find((h) => h.ref === 'doc-3')!.components.cosine).toBeCloseTo(
      127 / Math.sqrt(127 * 127 + 25), 6,
    );
    expect(hits.find((h) => h.ref === 'doc-5')!.components.cosine).toBeUndefined();
    expect(hits.find((h) => h.ref === 'doc-6')!.components.cosine).toBeUndefined();
  });
});

describe('a rescore the worker cannot answer', () => {
  let handle: TextIndexHandle | null = null;
  afterEach(async () => { await handle?.close(); handle = null; });

  it('keeps keyword order labelled timeout, and never falls back to a host read', async () => {
    const dir = makeTempDir('hs-rescore-error-');
    dirs.push(dir);
    const rescoreLog = path.join(dir, 'rescore.log');
    handle = openTextIndex(dir, { rescoreError: true, rescoreLog });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      handle.index.upsert({ kind: 'task', ref: `t-${i}`, title: `orbit telemetry ${i}`, updatedAt: now - i * 60_000 });
    }
    await drainBackfill(handle.index);
    const keyword = handle.index.search('orbit telemetry', { limit: 10 }).map((h) => h.ref);
    const { result: hits, sources } = await hostStatements(
      () => handle!.index.searchSemantic('orbit telemetry', { limit: 10, semanticDeadlineMs: 10_000 }),
    );
    // The job reached the worker, with the whole pool.
    expect(fs.readFileSync(rescoreLog, 'utf8').trim().split(',')).toHaveLength(5);
    expect(sources.filter((s) => HOST_VEC_READ.test(s))).toEqual([]);
    expect(hits.map((h) => h.ref)).toEqual(keyword);
    expect(new Set(hits.map((h) => h.semantic))).toEqual(new Set(['timeout']));
  });
});

describe('Embedder.rescore', () => {
  let embedder: Embedder | null = null;
  afterEach(async () => { await embedder?.dispose(); embedder = null; });

  /** An index file with known vectors, closed again: the worker reads it. */
  function indexFile(): { dbPath: string; ids: number[]; index: SearchIndex } {
    const dir = tempDir('hs-rescore-embedder-');
    const dbPath = path.join(dir, 'search.sqlite');
    const index = createSearchIndex({ dbPath, kinds: KINDS });
    cleanups.push(() => index.close());
    const w = createWriter(index.db);
    const ids: number[] = [];
    const vectors: Int8Array[][] = [
      [new Int8Array([127, 0, 0, 0])],
      [new Int8Array([0, 127, 0, 0]), new Int8Array([90, 90, 0, 0])], // max of two
      [new Int8Array([0, 0, 0, 0])], // quarantine marker: cosine 0
      [new Int8Array([1, 2, 3])], // another model's length: skipped
      [], // no vectors yet
    ];
    vectors.forEach((vecs, i) => {
      const { docId } = index.upsert({ kind: 'task', ref: `v-${i}`, title: `vec doc ${i}`, updatedAt: 1 });
      if (vecs.length) w.writeVectors(docId, vecs);
      ids.push(docId);
    });
    return { dbPath, ids, index };
  }

  it('is absent when the index is not a file the worker can open', () => {
    embedder = createEmbedder({ modelId: 'none', dims: 4, workerPath: REAL_WORKER }, () => {});
    expect(embedder.rescore).toBeUndefined();
  });

  it('the real worker answers the max cosine per doc on one kept connection', async () => {
    const { dbPath, ids, index } = indexFile();
    embedder = createEmbedder({ modelId: 'none', dims: 4, workerPath: REAL_WORKER, dbPath }, () => {});
    const q = new Int8Array([127, 0, 0, 0]);
    const got = await embedder.rescore!(q, ids, 30_000);
    expect(got).not.toBeNull();
    const want = readMaxCosines(index.db, q, ids);
    expect([...got!.keys()].sort()).toEqual([...want.keys()].sort());
    expect(got!.size).toBe(3);
    for (const [id, cos] of want) expect(got!.get(id)).toBeCloseTo(cos, 12);
    expect(got!.get(ids[1])).toBeCloseTo(Math.SQRT1_2, 6);
    expect(got!.get(ids[2])).toBe(0);
    // No model was loaded for it, and the empty pool needs no worker round-trip.
    expect(await embedder.rescore!(q, [], 1)).toEqual(new Map());
    // Vectors written after the first job: the kept connection sees them.
    createWriter(index.db).writeVectors(ids[4], [new Int8Array([127, 0, 0, 0])]);
    const again = await embedder.rescore!(q, ids, 30_000);
    expect(again!.get(ids[4])).toBeCloseTo(1, 12);
  });

  it('gives up at its budget, ignores the late reply, and the next job is answered', async () => {
    const { dbPath, ids } = indexFile();
    const dir = tempDir('hs-rescore-budget-');
    const rescoreLog = path.join(dir, 'rescore.log');
    const knobs = (k: object) => 'fake/text:' + JSON.stringify(k);
    embedder = createEmbedder({ modelId: knobs({ rescoreHoldMs: 600, rescoreLog }), dims: 4, workerPath: TEXT_WORKER, dbPath }, () => {});
    const q = new Int8Array([127, 0, 0, 0]);
    const t0 = performance.now();
    expect(await embedder.rescore!(q, ids, 50)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(550);
    // The second job waits behind nothing on the host; its own answer comes back.
    const next = await embedder.rescore!(q, ids.slice(0, 1), 30_000);
    expect([...next!.entries()]).toEqual([[ids[0], 1]]);
    expect(fs.readFileSync(rescoreLog, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(embedder.rescoreStats!()).toMatchObject({ ok: 1, timeout: 1, failed: 0 });
  });

  it('counts every fallback by reason and warns once per reason, so a rescore that stays off is seen', async () => {
    // A worker that cannot open the index answers every job with an error: without a count and a
    // warning, semantic ranking would stay off without a word.
    const dir = tempDir('hs-rescore-unopenable-');
    const warns: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    embedder = createEmbedder(
      { modelId: 'none', dims: 4, workerPath: REAL_WORKER, dbPath: path.join(dir, 'missing.sqlite') },
      (level, msg, data) => { if (level === 'warn') warns.push({ msg, data }); },
    );
    const q = new Int8Array([127, 0, 0, 0]);
    for (let i = 0; i < 3; i++) expect(await embedder.rescore!(q, [1, 2], 30_000)).toBeNull();
    expect(embedder.rescoreStats!()).toEqual({ ok: 0, suspended: 0, disposed: 0, unavailable: 0, timeout: 0, failed: 3 });
    const fellBack = warns.filter((w) => w.msg.includes('semantic rescore fell back'));
    expect(fellBack).toHaveLength(1);
    expect(fellBack[0].data).toMatchObject({ reason: 'failed' });
    await embedder.suspend();
    expect(await embedder.rescore!(q, [1, 2], 30_000)).toBeNull();
    expect(await embedder.rescore!(q, [1, 2], 30_000)).toBeNull();
    expect(embedder.rescoreStats!()).toMatchObject({ suspended: 2, failed: 3 });
    expect(warns.filter((w) => w.msg.includes('semantic rescore fell back'))).toHaveLength(2);
  });

  it('answers null when suspended or disposed, without starting a worker', async () => {
    const { dbPath, ids } = indexFile();
    embedder = createEmbedder({ modelId: 'none', dims: 4, workerPath: REAL_WORKER, dbPath }, () => {});
    await embedder.suspend();
    expect(await embedder.rescore!(new Int8Array([127, 0, 0, 0]), ids, 30_000)).toBeNull();
    expect(embedder.running().query).toBe(false);
    embedder.resume();
    await embedder.dispose();
    expect(await embedder.rescore!(new Int8Array([127, 0, 0, 0]), ids, 30_000)).toBeNull();
    expect(embedder.rescoreStats!()).toMatchObject({ suspended: 1, disposed: 1, ok: 0 });
  });
});
