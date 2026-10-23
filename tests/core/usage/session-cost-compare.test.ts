import { afterEach, describe, expect, it } from 'vitest';
import { compareSessionScan, POPULAR_COMPARISON_MODELS, unsplitWriteShare } from '../../../src/core/usage/session-cost-compare.js';
import { priceSessionScan } from '../../../src/core/usage/session-cost.js';
import { priceThresholds, resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import type { PriceSnapshot } from '../../../src/core/usage/price-data.js';
import type { SessionCostBucket, SessionCostScan } from '../../../src/providers/session-cost-core.js';

const SNAPSHOT: PriceSnapshot = {
  source: 'litellm', url: '', fetchedAt: '2026-10-22T00:00:00.000Z',
  models: {
    'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      threshold: 272_000, long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 } },
    'deepseek-v4-pro': { provider: 'deepseek', input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    'moonshot/kimi-k3': { provider: 'moonshot', input: 3, output: 15, cacheRead: 0.3 },
    'moonshot/moonshot-v1-8k': { provider: 'moonshot', input: 0.2, output: 2 },
    'gemini/gemini-3.1-pro-preview': { provider: 'gemini', input: 2, output: 12, cacheRead: 0.2,
      threshold: 200_000, long: { input: 4, output: 18, cacheRead: 0.4 } },
  },
};

function bucket(over: Partial<SessionCostBucket>): SessionCostBucket {
  return { model: 'gpt-6-1-sol', speed: 'standard', geo: 'global', tier: 'standard', band: 0, responses: 1,
    input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, webSearches: 0, incomplete: 0,
    firstAt: '2026-10-18T00:00:00.000Z', lastAt: '2026-10-18T00:00:00.000Z', ...over };
}

function scan(buckets: SessionCostBucket[], over: Partial<SessionCostScan> = {}): SessionCostScan {
  return { engine: 'claude', sessionId: 's1', source: 'claude-transcript', found: true, files: 1, buckets, scanMs: 1, ...over };
}

const close = (a: number | undefined, b: number) => expect(a).toBeCloseTo(b, 9);

describe('session cost on other models', () => {
  afterEach(() => resetPriceBookForTests());

  it('prices the session\'s own model at exactly what the session cost', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    const long = t.indexOf(272_000) + 1;
    const s = scan([
      bucket({ responses: 3, input: 100, cacheRead: 100_000, cacheWrite: 5_000, output: 900 }),
      bucket({ responses: 2, band: long, input: 50, cacheRead: 300_000, cacheWrite: 1_000, output: 400 }),
    ]);
    const actual = await priceSessionScan(s, t);
    const c = compareSessionScan(s, t, ['converse/global.openai.gpt-6.1-sol']);
    const sol = c.rows.find(r => r.key === 'gpt-6-1-sol')!;
    expect(sol).toMatchObject({ group: 'walnut', current: true, longResponses: 2, id: 'converse/global.openai.gpt-6.1-sol' });
    close(sol.costUsd, actual.totalUsd!);
  });

  it('takes each model\'s own prompt tier, and stands the input price in for a missing cache price', () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    // Past Gemini's 200K but under Sol's 272K.
    const s = scan([bucket({ band: t.indexOf(200_000) + 1, input: 1_000, cacheRead: 250_000, cacheWrite: 10_000, output: 1_000 })]);
    const c = compareSessionScan(s, t, []);
    const gemini = c.rows.find(r => r.key === 'gemini-3-1-pro-preview')!;
    expect(gemini).toMatchObject({ group: 'popular', label: 'Gemini 3.1 Pro', longResponses: 1 });
    // No write price listed: a cache miss is billed as ordinary input.
    close(gemini.costUsd, (1_000 * 4 + 250_000 * 0.4 + 10_000 * 4 + 1_000 * 18) / 1e6);
    const deepseek = c.rows.find(r => r.key === 'deepseek-v4-pro')!;
    close(deepseek.costUsd, (1_000 * 1.32 + 250_000 * 0.044 + 10_000 * 1.32 + 1_000 * 3.96) / 1e6);
    expect(c.rows.find(r => r.key === 'gpt-6-1-sol')).toMatchObject({ current: true, longResponses: 0 });
    expect(deepseek.assumptions).toEqual(['cache writes at the input price (no cache write price listed)']);
  });

  it('keeps a listed $0 write price for the model the session ran on, so it matches /cost', async () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    const s = scan([bucket({ model: 'deepseek-v4-pro', input: 1_000, cacheRead: 50_000, cacheWrite: 20_000, output: 500 })]);
    const actual = await priceSessionScan(s, t);
    const row = compareSessionScan(s, t, []).rows.find(r => r.key === 'deepseek-v4-pro')!;
    expect(row.current).toBe(true);
    close(row.costUsd, actual.totalUsd!);
    expect(row.assumptions).toEqual([]);
  });

  it('adds no note for a price the session never needed', () => {
    resetPriceBookForTests(SNAPSHOT);
    const row = compareSessionScan(scan([bucket({ input: 1_000, output: 10 })]), priceThresholds(), ['moonshot-v1-8k'])
      .rows.find(r => r.key === 'moonshot-v1-8k')!;
    expect(row.assumptions).toEqual([]);
  });

  it('notes a model with no cache price at all', () => {
    resetPriceBookForTests(SNAPSHOT);
    const c = compareSessionScan(scan([bucket({ cacheRead: 1_000_000 })]), priceThresholds(), ['moonshot-v1-8k']);
    const v1 = c.rows.find(r => r.key === 'moonshot-v1-8k')!;
    close(v1.costUsd, 0.2);
    expect(v1.assumptions).toEqual(['cache reads at the input price (no cache price listed)']);
  });

  it('gives a Claude model the lifetime split the session shows, else Claude Code\'s 1-hour cache', () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    const gptOnly = scan([bucket({ cacheWrite: 1_000_000 })]);
    expect(unsplitWriteShare(gptOnly.buckets, 'claude').share1h).toBe(1);
    expect(unsplitWriteShare(gptOnly.buckets, 'codex').share1h).toBe(0);
    close(compareSessionScan(gptOnly, t, ['claude-opus-5-5']).rows.find(r => r.key === 'claude-opus-5-5')!.costUsd, 8);
    close(compareSessionScan({ ...gptOnly, engine: 'codex' }, t, ['claude-opus-5-5']).rows.find(r => r.key === 'claude-opus-5-5')!.costUsd, 5);
    const mixed = scan([
      bucket({ model: 'claude-opus-5-5', cacheWrite5m: 250_000, cacheWrite1h: 750_000 }),
      bucket({ cacheWrite: 1_000_000 }),
    ]);
    const opus = compareSessionScan(mixed, t, ['claude-opus-5-5']).rows.find(r => r.key === 'claude-opus-5-5')!;
    close(opus.costUsd, (250_000 * 5 + 750_000 * 8) / 1e6 * 2);
    expect(opus.assumptions[0]).toMatch(/75% 1-hour/);
  });

  it('lists each model once, the cheapest first, and names ids with no price', () => {
    resetPriceBookForTests(SNAPSHOT);
    const c = compareSessionScan(scan([bucket({ input: 1_000_000 })]), priceThresholds(),
      ['gpt-6.1-sol', 'global.openai.gpt-6.1-sol', 'deepseek-v4-pro', 'no-such-model']);
    expect(c.rows.map(r => r.key)).toEqual(['deepseek-v4-pro', 'gpt-6-1-sol', 'gemini-3-1-pro-preview', 'kimi-k3']);
    // An id the picker offers wins its row over the popular list.
    expect(c.rows.find(r => r.key === 'deepseek-v4-pro')!.group).toBe('walnut');
    expect(c.unknown).toEqual(['no-such-model']);
    expect(POPULAR_COMPARISON_MODELS.length).toBeGreaterThan(5);
  });

  it('says why when there is nothing to compare', () => {
    resetPriceBookForTests(SNAPSHOT);
    const t = priceThresholds();
    expect(compareSessionScan(scan([], { found: false, reason: 'No transcript.' }), t, [])).toMatchObject({ status: 'unavailable', reason: 'No transcript.', rows: [] });
    expect(compareSessionScan(scan([], { pending: { readBytes: 1, totalBytes: 2 } }), t, [])).toMatchObject({ status: 'pending' });
    expect(compareSessionScan(scan([]), t, [])).toMatchObject({ status: 'empty', rows: [] });
  });
});
