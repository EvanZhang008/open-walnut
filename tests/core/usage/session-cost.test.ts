import { afterEach, describe, expect, it } from 'vitest';
import { priceSessionScan } from '../../../src/core/usage/session-cost.js';
import { priceThresholds, resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import type { PriceSnapshot } from '../../../src/core/usage/price-data.js';
import type { SessionCostBucket, SessionCostScan } from '../../../src/providers/session-cost-core.js';

const SNAPSHOT: PriceSnapshot = {
  source: 'litellm', url: '', fetchedAt: '2026-10-20T00:00:00.000Z',
  models: {
    'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    'claude-haiku-5-5': { provider: 'anthropic', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2,
      threshold: 100_000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } },
    'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      threshold: 272_000, long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 } },
  },
};

function bucket(over: Partial<SessionCostBucket>): SessionCostBucket {
  return { model: 'claude-opus-5-5', speed: 'standard', geo: 'global', tier: 'standard', band: 0, responses: 1,
    input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, webSearches: 0, incomplete: 0,
    firstAt: '2026-10-18T00:00:00.000Z', lastAt: '2026-10-18T00:00:00.000Z', ...over };
}

function scan(buckets: SessionCostBucket[], over: Partial<SessionCostScan> = {}): SessionCostScan {
  return { engine: 'claude', sessionId: 's1', source: 'claude-transcript', found: true, files: 1, buckets,
    firstAt: buckets[0]?.firstAt, lastAt: buckets.at(-1)?.lastAt, scanMs: 1, ...over };
}

const close = (a: number | null | undefined, b: number) => expect(a).toBeCloseTo(b, 9);

describe('session cost', () => {
  afterEach(() => resetPriceBookForTests());

  it('prices each cache lifetime at its own rate and sums models', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    const cost = await priceSessionScan(scan([
      bucket({ responses: 3, input: 1_000, output: 2_000, cacheRead: 1_000_000, cacheWrite5m: 100_000, cacheWrite1h: 200_000 }),
      bucket({ model: 'gpt-6-1-sol', responses: 2, input: 10_000, output: 1_000, cacheRead: 100_000, cacheWrite: 50_000 }),
    ]), t);
    const opus = cost.models.find(m => m.model === 'claude-opus-5-5')!;
    close(opus.costUsd, (1_000 * 4 + 2_000 * 20 + 1_000_000 * 0.2 + 100_000 * 5 + 200_000 * 8) / 1e6);
    const sol = cost.models.find(m => m.model === 'gpt-6-1-sol')!;
    close(sol.costUsd, (10_000 * 2 + 1_000 * 10 + 100_000 * 0.1 + 50_000 * 2.5) / 1e6);
    close(cost.totalUsd, opus.costUsd! + sol.costUsd!);
    expect(cost.status).toBe('priced');
    expect(cost.responses).toBe(5);
    expect(opus.priceSource).toMatchObject({ kind: 'litellm', key: 'claude-opus-5-5' });
  });

  it('switches a whole request to the long tier only past the model\'s own threshold', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    const at100k = t.indexOf(100_000);
    const cost = await priceSessionScan(scan([
      // Same tokens, two bands: below 100K and above it.
      bucket({ model: 'claude-haiku-5-5', band: at100k, input: 1_000, output: 1_000, cacheRead: 50_000 }),
      bucket({ model: 'claude-haiku-5-5', band: at100k + 1, input: 1_000, output: 1_000, cacheRead: 150_000 }),
    ]), t);
    const haiku = cost.models[0]!;
    close(haiku.costUsd, (1_000 * 0.1 + 1_000 * 0.5 + 50_000 * 0.01) / 1e6 + (1_000 * 0.5 + 1_000 * 2.5 + 150_000 * 0.05) / 1e6);
    expect(haiku.longResponses).toBe(1);
    expect(haiku.rates).toMatchObject({ threshold: 100_000, long: { input: 0.5 } });
    // The cost table: one block per tier, each row tokens x its own tier's rate.
    expect(haiku.tiers.map(t => [t.tier, t.responses])).toEqual([['base', 1], ['long', 1]]);
    const long = haiku.tiers[1]!;
    expect(long.lines.find(l => l.kind === 'cacheRead')).toMatchObject({ count: 150_000, rate: 0.05 });
    close(long.lines.find(l => l.kind === 'cacheRead')!.costUsd, 150_000 * 0.05 / 1e6);
    close(haiku.tiers.reduce((n, t) => n + t.costUsd, 0), haiku.costUsd!);
    for (const t of haiku.tiers) close(t.lines.reduce((n, l) => n + l.costUsd, 0), t.costUsd);
  });

  it('sums buckets of one tier into one table row per token kind, with one cache write rate for OpenAI', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    const band = t.indexOf(272_000) + 1;
    const cost = await priceSessionScan(scan([
      bucket({ model: 'gpt-6-1-sol', band, input: 100, cacheRead: 300_000, cacheWrite: 1_000, output: 10 }),
      bucket({ model: 'gpt-6-1-sol', band, geo: 'us', input: 100, cacheRead: 300_000, cacheWrite: 1_000, output: 10 }),
    ]), t);
    const sol = cost.models[0]!;
    expect(sol.tiers).toHaveLength(1);
    const lines = sol.tiers[0]!.lines;
    expect(lines.map(l => l.kind)).toEqual(['input', 'cacheWrite', 'cacheRead', 'output']);
    expect(lines.find(l => l.kind === 'cacheWrite')).toMatchObject({ count: 2_000, rate: 5 });
    // The US-only request's row cost carries its 1.1x; the rate column stays the list price.
    close(lines.find(l => l.kind === 'cacheRead')!.costUsd, 300_000 * 0.2 / 1e6 * 2.1);
    close(sol.tiers[0]!.costUsd, sol.costUsd!);
  });

  it('keeps the known part and counts what has no price, never as zero', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const cost = await priceSessionScan(scan([
      bucket({ input: 1_000_000 }),
      bucket({ model: 'some-new-model', responses: 4, input: 1_000 }),
    ]), priceThresholds());
    expect(cost.status).toBe('partial');
    close(cost.totalUsd, 4);
    expect(cost.unpricedResponses).toBe(4);
    const unknown = cost.models.find(m => m.model === 'some-new-model')!;
    expect(unknown.costUsd).toBeNull();
    expect(unknown.tiers).toEqual([]);
    expect(unknown.unpricedReason).toMatch(/no price for some-new-model/);
  });

  it('uses the fast-mode row, the US region surcharge, and refuses other service tiers', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const cost = await priceSessionScan(scan([
      bucket({ speed: 'fast', input: 1_000_000 }),
      bucket({ geo: 'us', input: 1_000_000 }),
      bucket({ tier: 'priority', input: 1_000_000 }),
    ]), priceThresholds());
    const fast = cost.models.find(m => m.speed === 'fast')!;
    close(fast.costUsd, 8);
    expect(fast.priceSource?.kind).toBe('builtin');
    const std = cost.models.find(m => m.speed === 'standard')!;
    close(std.costUsd, 4 * 1.1);
    expect(std.usRegionResponses).toBe(1);
    expect(std.unpricedResponses).toBe(1);
    expect(std.unpricedReason).toMatch(/priority service tier/);
  });

  it('prices a model named <x>-fast at its fast rate even with a standard speed field', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const cost = await priceSessionScan(scan([bucket({ model: 'claude-opus-5-5-fast', input: 1_000_000 })]), priceThresholds());
    close(cost.totalUsd, 8);
    expect(cost.models[0]!.speed).toBe('fast');
  });

  it('will not guess the lifetime of an unsplit Claude cache write', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const cost = await priceSessionScan(scan([bucket({ cacheWrite: 10_000 })]), priceThresholds());
    expect(cost.status).toBe('unpriced');
    expect(cost.totalUsd).toBeNull();
    expect(cost.models[0]!.unpricedReason).toMatch(/5m\/1h split/);
  });

  it('lets the user\'s own rates win over every other source', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const overrides = { 'claude-opus-5-5': { input: 1, output: 1, cache_read: 0, cache_write: 0, cache_write_1h: 0 } };
    const cost = await priceSessionScan(scan([bucket({ input: 1_000_000, output: 1_000_000 })]), priceThresholds(overrides), overrides);
    close(cost.totalUsd, 2);
    expect(cost.models[0]!.priceSource).toMatchObject({ kind: 'override', key: 'claude-opus-5-5' });
  });

  it('adds Claude web searches at their per-request price', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const cost = await priceSessionScan(scan([bucket({ webSearches: 3 })]), priceThresholds());
    close(cost.totalUsd, 0.03);
    expect(cost.models[0]!.tiers[0]!.lines.find(l => l.kind === 'webSearch')).toMatchObject({ count: 3, rate: 10 });
  });

  it('reports an unreadable session as unavailable with its reason, and an empty one as $0', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const none = await priceSessionScan(scan([], { found: false, source: 'none', reason: 'Goose keeps only totals.' }), []);
    expect(none).toMatchObject({ status: 'unavailable', reason: 'Goose keeps only totals.', totalUsd: null });
    const empty = await priceSessionScan(scan([]), []);
    expect(empty).toMatchObject({ status: 'empty', responses: 0 });
  });

  it('falls back to the built-in table when no price file is loaded', async () => {
    resetPriceBookForTests({ ...SNAPSHOT, models: {} });
    const cost = await priceSessionScan(scan([bucket({ model: 'claude-sonnet-5-5', cacheRead: 1_000_000 })]), priceThresholds());
    close(cost.totalUsd, 0.1);
    expect(cost.models[0]!.priceSource?.kind).toBe('builtin');
  });
});
