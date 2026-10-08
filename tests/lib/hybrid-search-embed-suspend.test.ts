/**
 * Suspending the embedder under machine memory pressure.
 *
 * Each embed worker holds a full model copy (measured +2.2 GB of footprint
 * per lane for the default model). When the kernel reports memory pressure the
 * server gives that back:
 * suspend() stops both workers and spawns none until resume(). While
 * suspended, a query degrades to a cached vector or keyword order, and the
 * backfill holds its place without counting anything as a failure, so no doc
 * is quarantined for the time the model was away.
 *
 * The worker is the stop-protocol fixture (fixtures/busy-embed-worker.cjs),
 * which marks each finished job and its own clean exit in a file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbedder, type Embedder } from '../../src/lib/hybrid-search/embedder.js';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';

const BUSY_WORKER = new URL('./fixtures/busy-embed-worker.cjs', import.meta.url).pathname;

let dir = '';
let embedder: Embedder | null = null;

function marks(): string[] {
  const file = path.join(dir, 'marks.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function make(workerData: Record<string, unknown> = {}): Embedder {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-embed-suspend-'));
  const knobs = { markerFile: path.join(dir, 'marks.txt'), ...workerData };
  embedder = createEmbedder(
    { modelId: 'fake/busy:' + JSON.stringify(knobs), dims: 4, workerPath: BUSY_WORKER },
    () => {},
  );
  return embedder;
}

afterEach(async () => {
  await embedder?.dispose();
  embedder = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('embedder suspend', () => {
  it('stops both workers, spawns none while suspended, and comes back on resume', async () => {
    const e = make();
    expect((await e.embedQuery('known query', 5_000))?.source).toBe('worker');
    expect(await e.embedPassages(['one passage'])).toHaveLength(1);
    expect(marks()).toEqual(['done 1', 'done 1']); // one job per lane

    await e.suspend();
    expect(e.isSuspended()).toBe(true);
    // Both worker processes ended themselves: the model memory is gone.
    expect(marks().filter((m) => m === 'exit-clean')).toHaveLength(2);

    await expect(e.embedPassages(['another passage'])).rejects.toThrow('embed worker unavailable');
    // A query the cache knows is still served; a new one degrades to null
    // (keyword order) at once instead of loading the model again.
    expect((await e.embedQuery('known query', 5_000))?.source).toBe('cache');
    const t0 = Date.now();
    expect(await e.embedQuery('a new query', 5_000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(marks()).toHaveLength(4); // no worker spawned, no job ran

    e.resume();
    expect(e.isSuspended()).toBe(false);
    expect(await e.embedPassages(['back again'])).toHaveLength(1);
    expect((await e.embedQuery('a new query', 5_000))?.source).toBe('worker');
  });

  it('a run in flight finishes before its worker exits (never cut mid-run)', async () => {
    const e = make({ holdMs: 400 });
    const run = e.embedPassages(['a slow passage']);
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await e.suspend();
    expect(marks()).toEqual(['done 1', 'exit-clean']);
    await expect(run).rejects.toThrow('embed worker terminated');
  });

  it('suspend is idempotent and a no-op after dispose', async () => {
    const e = make();
    await e.suspend();
    await e.suspend();
    expect(e.isSuspended()).toBe(true);
    await e.dispose();
    await e.suspend();
    expect(marks()).toEqual([]);
  });
});

const KINDS = { task: { weight: 1.0 } };

function vecCount(index: SearchIndex): number {
  return (index.db.prepare('SELECT COUNT(*) AS n FROM doc_vec').get() as { n: number }).n;
}

describe('search index while the embedder is suspended', () => {
  it('the backfill holds its place and quarantines nothing; queries say skipped', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: { modelId: 'no/such-model', dims: 4, workerPath: '/nonexistent.js' },
    });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    await index.suspendEmbedder();

    // Suspended passes hold the walk: not drained, nothing touched.
    for (let i = 0; i < 3; i++) {
      expect(await index.backfillVectors()).toEqual({ embedded: 0, drained: false, cursor: null });
    }
    expect(vecCount(index)).toBe(0);

    // Back to normal: the broken worker now stalls the walk, and still no doc
    // is blamed for it (hybrid-search-quarantine.test.ts).
    index.resumeEmbedder();
    expect(await index.backfillVectors()).toMatchObject({ embedded: 0, stalled: true });
    expect(await index.backfillVectors()).toMatchObject({ embedded: 0, stalled: true });
    expect(vecCount(index)).toBe(0);

    // A query while suspended skips the rescore on purpose (keyword order),
    // reported as skipped rather than as a worker timeout. Last, because a
    // live query makes the backfill yield for a quiet window.
    index.upsert({ kind: 'task', ref: 't2', title: 'unrelated retry note', updatedAt: 2 });
    await index.suspendEmbedder();
    const hits = await index.searchSemantic('retry timeout', { semanticDeadlineMs: 200 });
    expect(hits[0].ref).toBe('t1');
    expect(hits.every((h) => h.semantic === 'skipped')).toBe(true);
    index.close();
  });
});
