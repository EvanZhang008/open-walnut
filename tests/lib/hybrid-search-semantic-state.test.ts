/**
 * searchSemantic tells the caller its semantic state (SearchOptions.onSemantic)
 * even when no hit comes back.
 *
 * The host's result memo used to read the state off the hits, so a lane that
 * timed out with zero hits looked complete: a paraphrase with no keyword
 * overlap, asked while the query worker was cold, came back empty and the empty
 * list was replayed for the memo's 20 s (measured 2026-10-03: 0 results, then
 * 5 once the worker was warm). The worker here answers its first job at once
 * and stalls every later one for a second, so a small deadline always loses.
 */
import { describe, expect, it } from 'vitest';
import { createSearchIndex } from '../../src/lib/hybrid-search/index.js';

const STALLING_WORKER = new URL('./fixtures/slow-embed-worker.cjs', import.meta.url).pathname;
const KINDS = { task: { weight: 1.0 } };

describe('searchSemantic state report', () => {
  it('reports a timeout for a search that found nothing by keyword', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:', kinds: KINDS,
      embedder: { modelId: 'fake/unit-x', dims: 4, workerPath: STALLING_WORKER },
    });
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'orbit telemetry alert', updatedAt: Date.now() });
      const states: string[] = [];
      // Job 1 answers: the worker is up (no vectors written, so 'cold').
      await index.searchSemantic('orbit telemetry', { semanticDeadlineMs: 5_000, onSemantic: (s) => states.push(s) });
      // Job 2 stalls past the deadline, and no keyword lane matches anything.
      const hits = await index.searchSemantic('satellite downlink warning', { semanticDeadlineMs: 25, onSemantic: (s) => states.push(s) });
      expect(hits).toEqual([]);
      expect(states).toEqual(['cold', 'timeout']);
    } finally {
      index.close();
    }
  });

  it('reports disabled without an embedder, and a throwing hook cannot break the search', async () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    try {
      index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
      const states: string[] = [];
      expect(await index.searchSemantic('nothing like it', { onSemantic: (s) => states.push(s) })).toEqual([]);
      const hits = await index.searchSemantic('retry timeout', { onSemantic: () => { throw new Error('hook bug'); } });
      expect(hits[0]?.ref).toBe('t1');
      expect(states).toEqual(['disabled']);
    } finally {
      index.close();
    }
  });
});
