/**
 * Query-embedding LRU + per-query segment instrumentation.
 *
 * Why the cache exists (the thing these tests protect): ONE /api/search runs
 * THREE hybrid lanes (tasks, sessions, files) serially, and each one embedded
 * the same query string in its own worker round-trip under its own 150ms
 * deadline. Two of the three are now free, and a query whose worker misses the
 * deadline can still be rescored from the cached vector instead of silently
 * falling back to keyword order.
 *
 * The fake worker (fixtures/fake-embed-worker.cjs) answers instantly and
 * deterministically, so every assertion here is about the HOST-side bookkeeping.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmbedder,
  QUERY_CACHE_CAP,
  DEFAULT_RECALL_FRESH_MS,
} from '../../src/lib/hybrid-search/embedder.js';
import {
  createSearchIndex,
  setQuerySegmentObserver,
  SLOW_QUERY_LOG_MS,
  SLOW_QUERY_LOG_MIN_GAP_MS,
  type QuerySegments,
} from '../../src/lib/hybrid-search/index.js';

const FAKE_WORKER = new URL('./fixtures/fake-embed-worker.cjs', import.meta.url).pathname;
const STALLING_WORKER = new URL('./fixtures/slow-embed-worker.cjs', import.meta.url).pathname;
const noopLog = () => {};

function makeEmbedder(extra: Record<string, unknown> = {}) {
  return createEmbedder(
    { modelId: 'fake/unit-x', dims: 4, workerPath: FAKE_WORKER, ...extra },
    noopLog,
  );
}

describe('query-embedding LRU', () => {
  it('serves a repeated query from cache without a worker round-trip', async () => {
    const embedder = makeEmbedder();
    try {
      const first = await embedder.embedQuery('orbit telemetry', 5_000);
      expect(first?.source).toBe('worker');

      const second = await embedder.embedQuery('orbit telemetry', 5_000);
      expect(second?.source).toBe('cache');
      // Same Int8Array INSTANCE proves it came from the cache rather than a
      // second inference that happened to produce equal bytes.
      expect(second?.vec).toBe(first?.vec);
      expect(second?.recall).toBe(first?.recall);
    } finally {
      await embedder.dispose();
    }
  });

  it('a different query text is a miss', async () => {
    const embedder = makeEmbedder();
    try {
      expect((await embedder.embedQuery('alpha', 5_000))?.source).toBe('worker');
      expect((await embedder.embedQuery('beta', 5_000))?.source).toBe('worker');
      expect((await embedder.embedQuery('alpha', 5_000))?.source).toBe('cache');
    } finally {
      await embedder.dispose();
    }
  });

  it('recallK is part of the key — a wider recall request re-runs the worker', async () => {
    // recallK only reaches the worker when a db file exists, so the key only
    // varies by it in that mode (a bogus path is fine: the fake worker fails
    // its readonly open and answers with an empty recall list).
    const embedder = makeEmbedder({ dbPath: path.join(os.tmpdir(), 'hs-no-such-index.sqlite') });
    try {
      expect((await embedder.embedQuery('orbit', 5_000, 30))?.source).toBe('worker');
      expect((await embedder.embedQuery('orbit', 5_000, 150))?.source).toBe('worker');
      expect((await embedder.embedQuery('orbit', 5_000, 30))?.source).toBe('cache');
      expect((await embedder.embedQuery('orbit', 5_000, 150))?.source).toBe('cache');
    } finally {
      await embedder.dispose();
    }
  });

  it('stops serving recall once the entry goes stale, and re-runs the worker', async () => {
    // The VECTOR is deterministic (no expiry); the recall list is a snapshot of
    // doc_vec, which the paced backfill rewrites continuously — so freshness is
    // what bounds a cache hit. 20ms window, 60ms wait: a late timer only makes
    // the entry staler, so this can't flake in the passing direction.
    const embedder = makeEmbedder({ recallFreshMs: 20 });
    try {
      expect((await embedder.embedQuery('orbit', 5_000))?.source).toBe('worker');
      expect((await embedder.embedQuery('orbit', 5_000))?.source).toBe('cache');
      await new Promise((r) => setTimeout(r, 60));
      expect((await embedder.embedQuery('orbit', 5_000))?.source).toBe('worker');
    } finally {
      await embedder.dispose();
    }
  });

  it('evicts the oldest entry at the cap', async () => {
    const embedder = makeEmbedder();
    try {
      for (let i = 0; i <= QUERY_CACHE_CAP; i++) {
        expect((await embedder.embedQuery(`q${i}`, 5_000))?.source).toBe('worker');
      }
      // q0 was pushed out by the (cap+1)-th insert; the newest is still there.
      expect((await embedder.embedQuery(`q${QUERY_CACHE_CAP}`, 5_000))?.source).toBe('cache');
      expect((await embedder.embedQuery('q0', 5_000))?.source).toBe('worker');
    } finally {
      await embedder.dispose();
    }
  });

  it('reading an entry does not extend its freshness', async () => {
    // A hit moves the entry to the young end of the LRU but must NOT re-date
    // it, otherwise a query someone keeps re-issuing would serve a recall
    // snapshot from minutes ago forever. Both sleeps overshooting only makes
    // the entry staler, so the assertion holds in both timing directions.
    const embedder = makeEmbedder({ recallFreshMs: 40 });
    try {
      expect((await embedder.embedQuery('orbit', 5_000))?.source).toBe('worker');
      await new Promise((r) => setTimeout(r, 15));
      await embedder.embedQuery('orbit', 5_000); // touch mid-window
      await new Promise((r) => setTimeout(r, 60));
      expect((await embedder.embedQuery('orbit', 5_000))?.source).toBe('worker');
    } finally {
      await embedder.dispose();
    }
  });

  it('a blown deadline is rescued by the cached vector (recall dropped)', async () => {
    // The interesting case is a STALE entry: it can no longer serve recall, so
    // the worker runs — and when the worker misses the deadline, the vector is
    // still exactly as good as it ever was. Pre-cache, this path resolved null
    // and the whole rescore silently degraded to keyword order ('timeout').
    // slow-embed-worker answers job #1 instantly and stalls the rest for 1s, so
    // a 25ms deadline on the second call cannot flap.
    const embedder = createEmbedder(
      { modelId: 'fake/unit-x', dims: 4, workerPath: STALLING_WORKER, recallFreshMs: 1 },
      noopLog,
    );
    try {
      const warm = await embedder.embedQuery('orbit telemetry', 5_000);
      expect(warm?.source).toBe('worker');
      await new Promise((r) => setTimeout(r, 10)); // entry now stale for recall
      const rescued = await embedder.embedQuery('orbit telemetry', 25);
      expect(rescued?.source).toBe('cache-vec');
      expect(rescued?.vec).toBe(warm?.vec);
      expect(rescued?.recall).toEqual([]);
    } finally {
      await embedder.dispose();
    }
  });

  it('with nothing cached, a blown deadline still resolves null', async () => {
    const embedder = makeEmbedder();
    try {
      expect(await embedder.embedQuery('never seen before', 0)).toBeNull();
    } finally {
      await embedder.dispose();
    }
  });

  it('an unavailable worker resolves null, never throws into the search path', async () => {
    const embedder = createEmbedder(
      { modelId: 'no/such', dims: 4, workerPath: '/nonexistent/embed-worker.js' },
      noopLog,
    );
    try {
      expect(await embedder.embedQuery('orbit', 200)).toBeNull();
    } finally {
      await embedder.dispose();
    }
  });

  it('the default freshness window is a real 20s, not an accident', () => {
    expect(DEFAULT_RECALL_FRESH_MS).toBe(20_000);
    expect(QUERY_CACHE_CAP).toBe(200);
  });
});

describe('query segment instrumentation', () => {
  const KINDS = { task: { weight: 1.0 } };

  function collect(): { seen: QuerySegments[]; detach: () => void } {
    const seen: QuerySegments[] = [];
    setQuerySegmentObserver((s) => seen.push({ ...s }));
    return { seen, detach: () => setQuerySegmentObserver(null) };
  }

  it('keyword-only index publishes the disabled path with no embed time', async () => {
    const { seen, detach } = collect();
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
      await index.searchSemantic('retry timeout');
      expect(seen).toHaveLength(1);
      expect(seen[0].semantic).toBe('disabled');
      expect(seen[0].embedSource).toBe('none');
      expect(seen[0].embedMs).toBe(0);
      expect(seen[0].keywordMs).toBeGreaterThanOrEqual(0);
      expect(seen[0].totalMs).toBeGreaterThanOrEqual(seen[0].keywordMs);
      expect(seen[0].poolSize).toBe(1);
    } finally {
      detach();
      index.close();
    }
  });

  it('reports every segment plus the embed source, and the second lane hits cache', async () => {
    const { seen, detach } = collect();
    const index = createSearchIndex({
      dbPath: ':memory:', kinds: KINDS,
      embedder: { modelId: 'fake/unit-x', dims: 4, workerPath: FAKE_WORKER },
    });
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'orbit telemetry alert', updatedAt: Date.now() });
      // Two lanes of one request: same query, different kind filter.
      await index.searchSemantic('orbit telemetry', { kinds: ['task'], semanticDeadlineMs: 5_000 });
      await index.searchSemantic('orbit telemetry', { kinds: ['task'], semanticDeadlineMs: 5_000 });
      expect(seen).toHaveLength(2);
      expect(seen[0].embedSource).toBe('worker');
      expect(seen[1].embedSource).toBe('cache');
      expect(seen[1].embedMs).toBeLessThanOrEqual(seen[0].embedMs);
      for (const seg of seen) {
        // No vectors written, so the rescore honestly reports 'cold'.
        expect(seg.semantic).toBe('cold');
        expect(seg.totalMs).toBeGreaterThanOrEqual(0);
        expect(seg.rescoreMs).toBeGreaterThanOrEqual(0);
        expect(seg.recallAdded).toBe(0);
      }
    } finally {
      detach();
      index.close();
    }
  });

  it('an observer that throws cannot break a search, and detaching stops it', async () => {
    const boom = vi.fn(() => { throw new Error('observer bug'); });
    setQuerySegmentObserver(boom);
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
      const hits = await index.searchSemantic('retry timeout');
      expect(hits[0].ref).toBe('t1');
      expect(boom).toHaveBeenCalledTimes(1);
      setQuerySegmentObserver(null);
      await index.searchSemantic('retry timeout');
      expect(boom).toHaveBeenCalledTimes(1);
    } finally {
      setQuerySegmentObserver(null);
      index.close();
    }
  });

  it('a fast query logs NOTHING — the warn line is for the tail only', async () => {
    const lines: Array<[string, string]> = [];
    const index = createSearchIndex({
      dbPath: ':memory:', kinds: KINDS,
      logger: (level, msg) => { lines.push([level, msg]); },
    });
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
      await index.searchSemantic('retry timeout');
      expect(lines.filter(([, msg]) => msg.includes('slow query'))).toEqual([]);
      expect(SLOW_QUERY_LOG_MS).toBe(500);
    } finally {
      index.close();
    }
  });

  it('the slow-query line carries the split and a CAPPED query string', async () => {
    // Drive the threshold from the observer instead of manufacturing 500ms of
    // real work: the observer runs inside publish(), before the log decision.
    const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const index = createSearchIndex({
      dbPath: ':memory:', kinds: KINDS,
      logger: (level, msg, data) => { lines.push({ level, msg, data }); },
    });
    setQuerySegmentObserver((seg) => { seg.totalMs = SLOW_QUERY_LOG_MS + 1; });
    const longQuery = 'retry timeout '.repeat(20);
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
      await index.searchSemantic(longQuery);
      const slow = lines.filter((l) => l.msg.includes('slow query'));
      expect(slow).toHaveLength(1);
      expect(slow[0].level).toBe('warn');
      expect(slow[0].data).toMatchObject({
        semantic: 'disabled',
        embedSource: 'none',
        embedMs: 0,
      });
      expect(typeof slow[0].data?.keywordMs).toBe('number');
      expect(typeof slow[0].data?.rescoreMs).toBe('number');
      expect(String(slow[0].data?.query).length).toBe(80);
      expect(longQuery.length).toBeGreaterThan(80);
    } finally {
      setQuerySegmentObserver(null);
      index.close();
    }
  });

  it('a storm of slow lanes collapses into ONE line that carries the suppressed count', async () => {
    // The threshold fires per LANE (one /api/search = three legs; the agent lane
    // fans out variants), and it fires exactly when the machine is loaded — so
    // unthrottled it buries the log of the incident it is meant to expose.
    const lines: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const index = createSearchIndex({
      dbPath: ':memory:', kinds: KINDS,
      logger: (_level, msg, data) => { lines.push({ msg, data }); },
    });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    let totalMs = SLOW_QUERY_LOG_MS + 1;
    setQuerySegmentObserver((seg) => { seg.totalMs = totalMs; });
    // The gap is wall-clock (Date.now), so the storm is simulated, not slept.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await index.searchSemantic('retry timeout');
      totalMs = SLOW_QUERY_LOG_MS + 900;   // the worst of the suppressed batch
      await index.searchSemantic('retry timeout');
      totalMs = SLOW_QUERY_LOG_MS + 5;
      await index.searchSemantic('retry timeout');
      let slow = lines.filter((l) => l.msg.includes('slow query'));
      expect(slow).toHaveLength(1);
      expect(slow[0].data).toMatchObject({ suppressed: 0 });

      // Past the gap the next slow lane reports what it stood in for.
      clock.mockReturnValue(1_000_000 + SLOW_QUERY_LOG_MIN_GAP_MS);
      await index.searchSemantic('retry timeout');
      slow = lines.filter((l) => l.msg.includes('slow query'));
      expect(slow).toHaveLength(2);
      expect(slow[1].data).toMatchObject({
        suppressed: 2,
        suppressedMaxMs: SLOW_QUERY_LOG_MS + 900,
      });
    } finally {
      clock.mockRestore();
      setQuerySegmentObserver(null);
      index.close();
    }
  });
});

describe('cache never leaks across index handles', () => {
  it('a fresh index re-embeds (the LRU lives on the embedder instance)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-qcache-'));
    const seen: QuerySegments[] = [];
    setQuerySegmentObserver((s) => seen.push({ ...s }));
    const open = () => createSearchIndex({
      dbPath: path.join(dir, 'search.sqlite'), kinds: { task: { weight: 1 } },
      embedder: { modelId: 'fake/unit-x', dims: 4, workerPath: FAKE_WORKER },
    });
    try {
      const a = open();
      a.upsert({ kind: 'task', ref: 't1', title: 'orbit telemetry', updatedAt: Date.now() });
      await a.searchSemantic('orbit', { semanticDeadlineMs: 5_000 });
      a.close();
      const b = open();
      await b.searchSemantic('orbit', { semanticDeadlineMs: 5_000 });
      b.close();
      expect(seen.map((s) => s.embedSource)).toEqual(['worker', 'worker']);
    } finally {
      setQuerySegmentObserver(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
