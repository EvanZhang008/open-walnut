/**
 * What the vector backfill logs (src/core/search/backfill-log.ts, wiring.ts).
 *
 * 2026-10-06: the progress line (`total % 800 < 16`) held for every pass total
 * from 1 to 15, so a pass that embedded a few docs logged on each of its
 * batches and the log read like a loop. Now each batch that handed out docs
 * logs its doc count and elapsed ms, and the progress line fires only when a
 * batch carries the total across a multiple of 800.
 *
 * The wiring half drives the real startSearchV2Wiring with backfillVectors
 * scripted (the index is the singleton on the isolated test home; keyword only,
 * no model is loaded or needed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';
import { _resetMemoryPressureForTest } from '../../src/core/memory-pressure.js';
import { backfillBatchLogFields, crossedProgressMilestone } from '../../src/core/search/backfill-log.js';
import {
  getSearchV2Index, resetSearchV2IndexForTests, startSearchV2Wiring, VEC_BATCH_BUDGET_MS, type SearchV2Wiring,
} from '../../src/core/search/wiring.js';
import type { BackfillVectorsResult } from '../../src/lib/hybrid-search/index.js';
import { log } from '../../src/logging/index.js';

describe('crossedProgressMilestone', () => {
  it('fires once per multiple of 800, never for small totals', () => {
    expect(crossedProgressMilestone(0, 3)).toBe(false);
    expect(crossedProgressMilestone(3, 9)).toBe(false); // the old test fired on both of these
    expect(crossedProgressMilestone(790, 806)).toBe(true);
    expect(crossedProgressMilestone(806, 812)).toBe(false);
    expect(crossedProgressMilestone(1_599, 1_600)).toBe(true);
    expect(crossedProgressMilestone(1_600, 1_600)).toBe(false);
  });
});

describe('backfillBatchLogFields', () => {
  it('describes a batch that ran inference, and nothing for a scan-only step or a query yield', () => {
    const ctx = { phase: 'all' as const, passEmbedded: 7, fullPass: true };
    expect(backfillBatchLogFields({ embedded: 0, drained: false, cursor: null, scanned: 128 }, 3, ctx)).toBeNull();
    expect(backfillBatchLogFields(
      { embedded: 0, drained: false, cursor: null, scanned: 9, docs: 4, passages: 0, yielded: 'query' }, 2, ctx,
    )).toBeNull();
    expect(backfillBatchLogFields(
      { embedded: 2, drained: false, cursor: null, scanned: 128, docs: 5, passages: 41, yielded: 'budget' }, 15_012.4, ctx,
    )).toEqual({ phase: 'all', docs: 5, embedded: 2, passages: 41, ms: 15_012, yielded: 'budget', passEmbedded: 7, fullPass: true });
  });
});

describe('the wiring logs each batch', () => {
  let wiring: SearchV2Wiring | null = null;
  const infos: Array<[string, Record<string, unknown> | undefined]> = [];

  beforeEach(() => {
    resetSearchV2IndexForTests();
    _resetMemoryPressureForTest();
    infos.length = 0;
    vi.spyOn(log.memory, 'info').mockImplementation(((msg: string, data?: Record<string, unknown>) => {
      infos.push([msg, data]);
    }) as never);
    vi.spyOn(log.memory, 'warn').mockImplementation(() => {});
    vi.spyOn(log.memory, 'debug').mockImplementation(() => {});
  });
  afterEach(async () => {
    await wiring?.stop();
    wiring = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSearchV2IndexForTests();
  });

  async function pumpUntil(cond: () => boolean, fakeMs = 1_000_000): Promise<void> {
    for (let t = 0; t < fakeMs && !cond(); t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      await new Promise((r) => setImmediate(r));
    }
  }

  function script(results: BackfillVectorsResult[]) {
    const index = getSearchV2Index();
    const queue = [...results];
    const spy = vi.spyOn(index, 'backfillVectors').mockImplementation(async () =>
      queue.shift() ?? { embedded: 0, drained: true, cursor: null, scanned: 0 });
    vi.spyOn(index, 'releasePassageWorker').mockResolvedValue(true);
    return spy;
  }

  const lines = (msg: string) => infos.filter(([m]) => m === msg).map(([, d]) => d!);

  it('one line per batch with docs and ms; no progress line for a small pass; a yield is not a new pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const spy = script([
      // Light phase: the first batch yields on its budget and hands back the
      // null cursor it was given. Under the old start-of-pass test that began
      // a second pass (and reset the pass's scan count).
      { embedded: 1, drained: false, cursor: null, scanned: 5, docs: 2, passages: 3, yielded: 'budget' },
      { embedded: 2, drained: false, cursor: { updatedAt: 1, id: 1 }, scanned: 5, docs: 2, passages: 2 },
      { embedded: 0, drained: true, cursor: null, scanned: 3 },
      { embedded: 3, drained: true, cursor: null, scanned: 4, docs: 3, passages: 9 },
    ]);
    wiring = startSearchV2Wiring(new EventBus());
    await pumpUntil(() => lines('search-v2 vector backfill drained').length > 0);

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [opts] of spy.mock.calls.slice(0, 4)) expect(opts?.budgetMs).toBe(VEC_BATCH_BUDGET_MS);
    const batches = lines('search-v2 vector backfill batch');
    expect(batches.map((b) => [b.phase, b.docs, b.embedded, b.passEmbedded, b.yielded])).toEqual([
      ['light', 2, 1, 1, 'budget'],
      ['light', 2, 2, 3, null],
      ['all', 3, 3, 6, null],
    ]);
    for (const b of batches) expect(typeof b.ms).toBe('number');
    expect(lines('search-v2 vector backfill progress')).toEqual([]);
    expect(lines('search-v2 vector backfill drained')[0]).toMatchObject({ embedded: 6, docsScanned: 17, fullPass: true });
  }, 60_000);

  it('a failed pass does not carry its count into the next one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const index = getSearchV2Index();
    const steps: Array<BackfillVectorsResult | Error> = [
      { embedded: 2, drained: false, cursor: { updatedAt: 1, id: 1 }, scanned: 5, docs: 2, passages: 2 },
      new Error('embed worker exited (SIGKILL)'),
      { embedded: 1, drained: false, cursor: { updatedAt: 1, id: 1 }, scanned: 5, docs: 1, passages: 1 },
      { embedded: 0, drained: true, cursor: null, scanned: 1 },
      { embedded: 0, drained: true, cursor: null, scanned: 1 },
    ];
    vi.spyOn(index, 'backfillVectors').mockImplementation(async () => {
      const step = steps.shift() ?? { embedded: 0, drained: true, cursor: null, scanned: 0 };
      if (step instanceof Error) throw step;
      return step;
    });
    vi.spyOn(index, 'releasePassageWorker').mockResolvedValue(true);
    wiring = startSearchV2Wiring(new EventBus());
    await pumpUntil(() => lines('search-v2 vector backfill drained').length > 0);
    expect(lines('search-v2 vector backfill batch').map((b) => b.passEmbedded)).toEqual([2, 1]);
    expect(lines('search-v2 vector backfill drained')[0]).toMatchObject({ embedded: 1 });
  }, 60_000);

  it('a stalled worker ends the pass and the next try is a sweep interval away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const index = getSearchV2Index();
    let calls = 0;
    const spy = vi.spyOn(index, 'backfillVectors').mockImplementation(async () =>
      ++calls === 1
        ? { embedded: 0, drained: false, cursor: null, scanned: 3, docs: 1, passages: 0, stalled: true }
        : { embedded: 0, drained: true, cursor: null, scanned: 0 });
    const release = vi.spyOn(index, 'releasePassageWorker').mockResolvedValue(true);
    wiring = startSearchV2Wiring(new EventBus());
    let fakeMs = 0;
    const step = async () => {
      await vi.advanceTimersByTimeAsync(250);
      fakeMs += 250;
      await new Promise((r) => setImmediate(r));
    };
    while (spy.mock.calls.length < 1 && fakeMs < 120_000) await step();
    const stalledAt = fakeMs;
    expect(spy).toHaveBeenCalledTimes(1);
    while (spy.mock.calls.length < 2 && fakeMs < stalledAt + 1_000_000) await step();
    // Not a pause-and-retry loop on a dead worker: the walk waits out the
    // 10-minute sweep interval (a drained pass waits the same).
    expect(fakeMs - stalledAt).toBeGreaterThanOrEqual(10 * 60_000 - 250);
    expect(release).toHaveBeenCalled();
  }, 60_000);

  it('a pass that crosses 800 logs exactly one progress line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const big = (n: number): BackfillVectorsResult =>
      ({ embedded: n, drained: false, cursor: { updatedAt: 1, id: 1 }, scanned: 128, docs: n, passages: n });
    script([
      { embedded: 0, drained: true, cursor: null, scanned: 0 }, // light phase: nothing
      big(300), big(300), big(300), big(300),
      { embedded: 0, drained: true, cursor: null, scanned: 1 },
    ]);
    wiring = startSearchV2Wiring(new EventBus());
    await pumpUntil(() => lines('search-v2 vector backfill drained').length > 0);
    expect(lines('search-v2 vector backfill progress')).toEqual([{ embedded: 900 }]);
    expect(lines('search-v2 vector backfill batch')).toHaveLength(4);
  }, 60_000);
});
