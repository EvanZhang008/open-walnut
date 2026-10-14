import { describe, it, expect } from 'vitest';
import { computeCost, priceUsage, priceReconciledUsage, findPricing, DEFAULT_PRICING, PRICING_VERSION } from '../../../src/core/usage/pricing.js';
import type { PriceUsageParams } from '../../../src/core/usage/pricing.js';

describe('pricing', () => {
  describe('findPricing', () => {
    it('matches Bedrock model IDs with prefix', () => {
      const entry = findPricing('global.anthropic.claude-opus-4-6-v1');
      expect(entry).toBeDefined();
      expect(entry!.pattern).toBe('claude-opus-4-6');
      expect(entry!.input).toBe(5.00);
      expect(entry!.output).toBe(25.00);
    });

    it('matches plain model IDs', () => {
      const entry = findPricing('claude-sonnet-4');
      expect(entry).toBeDefined();
      expect(entry!.input).toBe(3.00);
      expect(entry!.output).toBe(15.00);
    });

    it('prices each GPT family by its own row, never the Opus fallback', () => {
      expect(findPricing('openai.gpt-6.1-sol')!.pattern).toBe('gpt-6.1-sol');
      expect(findPricing('global.openai.gpt-6-sol')!.pattern).toBe('gpt-6-sol');
      expect(findPricing('openai.gpt-6-luna[high]')!.pattern).toBe('gpt-6-luna');
      expect(findPricing('openai.gpt-6-astra')!.pattern).toBe('gpt-6-astra');
      expect(findPricing('openai.gpt-5.6-sol[max]')!.pattern).toBe('gpt-5.6');
    });

    it('returns undefined for unknown models', () => {
      const entry = findPricing('totally-unknown-model-xyz');
      expect(entry).toBeUndefined();
    });

    it.each([
      'claude-3-5-haiku',
      'claude-3-5-haiku-20241022',
      'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-haiku-3-5',
      'claude-haiku-3-5-20241022',
      'bedrock/us.anthropic.claude-haiku-3-5-20241022-v1:0[1m]',
    ])('matches the raw or normalized Haiku 3.5 alias %s', (model) => {
      expect(findPricing(model)?.pattern).toBe('claude-3-5-haiku');
      const result = priceUsage({ model, input_tokens: 1_000, output_tokens: 100 });
      expect(result.pricingStatus).toBe('priced');
      expect(result.costUsd).toBeCloseTo(0.0012, 9);
    });

    it('matches GLM models', () => {
      const entry = findPricing('glm-4.7');
      expect(entry).toBeDefined();
      expect(entry!.input).toBe(0.60);
      expect(entry!.output).toBe(2.20);
    });

    it('matches GLM flash (free tier)', () => {
      const entry = findPricing('glm-4-flash');
      expect(entry).toBeDefined();
      expect(entry!.input).toBe(0);
      expect(entry!.output).toBe(0);
    });

    it('matches Perplexity sonar-pro', () => {
      const entry = findPricing('sonar-pro');
      expect(entry).toBeDefined();
      expect(entry!.input).toBe(3.00);
      expect(entry!.output).toBe(15.00);
    });

    it('matches Opus 5 (base vs fast tier)', () => {
      const base = findPricing('global.anthropic.claude-opus-5');
      const fast = findPricing('claude-opus-5-fast');
      expect(base!.input).toBe(5.00);
      expect(base!.output).toBe(25.00);
      expect(fast!.input).toBe(10.00);
      expect(fast!.output).toBe(50.00);
    });

    it('prices Opus 5.5 by its own row, not the opus-5 substring', () => {
      const base = findPricing('global.anthropic.claude-opus-5-5');
      const fast = findPricing('claude-opus-5-5-fast');
      expect(base!.pattern).toBe('claude-opus-5-5');
      expect(base!.input).toBe(4.00);
      expect(base!.output).toBe(20.00);
      expect(base!.cacheRead).toBe(0.20);
      expect(fast!.pattern).toBe('claude-opus-5-5-fast');
      expect(fast!.input).toBe(8.00);
      expect(fast!.output).toBe(40.00);
      // Opus 5 keeps its own price; the new row must not shadow it.
      expect(findPricing('global.anthropic.claude-opus-5[1m]')!.pattern).toBe('claude-opus-5');
    });

    it('prices Sonnet 5.5 and Sonnet 5 at $2 / $10', () => {
      const s55 = findPricing('global.anthropic.claude-sonnet-5-5');
      expect(s55!.pattern).toBe('claude-sonnet-5-5');
      expect([s55!.input, s55!.output, s55!.cacheWrite, s55!.cacheRead]).toEqual([2.00, 10.00, 2.50, 0.20]);
      expect(findPricing('global.anthropic.claude-sonnet-5[1m]')!.pattern).toBe('claude-sonnet-5');
      // Sonnet 4.x keeps its own $3 / $15 row.
      expect(findPricing('global.anthropic.claude-sonnet-4-5-20250929-v1:0')!.input).toBe(3.00);
    });

    it('prices Haiku 5.5 at $0.10 / $0.50 and keeps Haiku 4.5 at $1 / $5', () => {
      for (const id of ['global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-haiku-5-5[1m]', 'claude-haiku-5-5']) {
        const h = findPricing(id);
        expect(h!.pattern).toBe('claude-haiku-5-5');
        expect([h!.input, h!.output, h!.cacheWrite, h!.cacheRead]).toEqual([0.10, 0.50, 0.125, 0.01]);
      }
      expect(findPricing('us.anthropic.claude-haiku-4-5-20251001-v1:0')!.input).toBe(1.00);
    });

    it('prefers more specific patterns (opus-4-6 over opus-4)', () => {
      const entry46 = findPricing('claude-opus-4-6-v1');
      const entry4 = findPricing('claude-opus-4-v1');
      expect(entry46!.input).toBe(5.00);  // Opus 4.6 = $5
      expect(entry4!.input).toBe(15.00);  // Opus 4.0 = $15
    });

    it('prefers custom pricing over defaults', () => {
      const custom = [{ pattern: 'claude-opus-4-6', input: 99.99, output: 99.99 }];
      const entry = findPricing('global.anthropic.claude-opus-4-6-v1', custom);
      expect(entry!.input).toBe(99.99);
    });

    it('falls back to defaults when custom has no match', () => {
      const custom = [{ pattern: 'some-other-model', input: 1, output: 1 }];
      const entry = findPricing('claude-opus-4-6-v1', custom);
      expect(entry!.pattern).toBe('claude-opus-4-6');
    });
  });

  describe('computeCost', () => {
    it('computes basic input + output cost', () => {
      const cost = computeCost({
        model: 'global.anthropic.claude-opus-4-6-v1',
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      // 5 + 25 = 30
      expect(cost).toBeCloseTo(30.00, 2);
    });

    it('includes cache write and read costs', () => {
      const cost = computeCost({
        model: 'global.anthropic.claude-opus-4-6-v1',
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 200_000,
        cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 0 },
        cache_read_input_tokens: 300_000,
      });
      // input: 0.5M * 5 = 2.50
      // output: 0.1M * 25 = 2.50
      // cache_write: 0.2M * 6.25 = 1.25
      // cache_read: 0.3M * 0.50 = 0.15
      expect(cost).toBeCloseTo(6.40, 2);
    });

    it('returns 0 for free models', () => {
      const cost = computeCost({
        model: 'glm-4-flash',
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      expect(cost).toBe(0);
    });

    it('returns NaN for unpriced usage without guessing another model', () => {
      expect(computeCost({
        model: 'unknown-model',
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      })).toBeNaN();
      expect(computeCost({
        model: 'claude-opus-5-5',
        input_tokens: 100,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
      })).toBeNaN();
    });

    it('handles zero tokens', () => {
      const cost = computeCost({
        model: 'claude-opus-4-6',
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(cost).toBe(0);
    });

    it('handles small token counts correctly', () => {
      const cost = computeCost({
        model: 'claude-opus-4-6',
        input_tokens: 1000,
        output_tokens: 500,
      });
      // 0.001M * 5 = 0.005, 0.0005M * 25 = 0.0125
      expect(cost).toBeCloseTo(0.0175, 4);
    });
  });

  describe('priceUsage', () => {
    const response: Omit<PriceUsageParams, 'model'> = {
      input_tokens: 124,
      output_tokens: 3_180,
      cache_read_input_tokens: 91_400,
      cache_creation_input_tokens: 26_000,
      cache_creation: { ephemeral_5m_input_tokens: 26_000, ephemeral_1h_input_tokens: 0 },
    };

    it.each([
      ['claude-opus-5-5', 0.212376],
      ['claude-fable-5-1', 0.50809],
      ['gpt-6.1-sol', 0.106188],
      ['gpt-6-astra', 0.57664],
      ['claude-haiku-5-5', 0.028832],
    ])('compares %s on the same cache-heavy response', (model, expected) => {
      const result = priceUsage({ model, ...response });
      expect(result.pricingStatus).toBe('priced');
      expect(result.costUsd).toBeCloseTo(expected, 9);
      expect(result.pricingVersion).toBe(PRICING_VERSION);
      expect(Object.values(result.components).reduce<number>((sum, cost) => sum + cost!, 0))
        .toBeCloseTo(expected, 9);
    });

    it.each([
      ['claude-opus-5-5', 0.290376],
      ['claude-fable-5-1', 0.70309],
    ])('prices %s one-hour writes from response details', (model, expected) => {
      expect(priceUsage({
        model, ...response,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 26_000 },
      }).costUsd).toBeCloseTo(expected, 9);
    });

    it('uses fast and geographic prices only when the response reports them', () => {
      const base = { model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0 };
      expect(priceUsage({ ...base, speed: 'standard', inference_geo: '' }).costUsd).toBe(4);
      expect(priceUsage({ ...base, speed: 'fast' }).costUsd).toBe(8);
      expect(priceUsage({ ...base, inference_geo: 'us' }).costUsd).toBeCloseTo(4.4, 9);
      expect(priceUsage({ ...base, service_tier: 'batch' }).costUsd).toBeNull();
      expect(priceUsage({ ...base, speed: 'unknown' }).costUsd).toBeNull();
      expect(priceUsage({ ...base, pricing_context_complete: false }).costUsd).toBeNull();
    });

    it('does not verify an unknown provider route or a Converse cache rate', () => {
      const base = { model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0,
        speed: 'standard', inference_geo: '', service_tier: 'standard', pricing_context_complete: true };
      expect(priceReconciledUsage({ ...base, forwardedModel: 'global.anthropic.claude-opus-5-5' }).costUsd).toBe(4);
      for (const forwardedModel of [null, 'claude-opus-5-5', 'us.anthropic.claude-opus-5-5']) {
        expect(priceReconciledUsage({ ...base, forwardedModel }).costUsd).toBeNull();
      }
      expect(priceReconciledUsage({ ...base, model: 'gpt-6-astra', forwardedModel: 'global.openai.gpt-6-astra' }).costUsd).toBeNull();
      expect(priceReconciledUsage({ ...base, model: 'claude-opus-4-8', forwardedModel: 'global.anthropic.claude-opus-4-8' }).costUsd).toBeNull();
    });

    it('prices Sol cache totals without using zero Claude TTL placeholders', () => {
      const usage = { model: 'gpt-6-1-sol', input_tokens: 436, output_tokens: 350,
        cache_creation_input_tokens: 5_814, cache_read_input_tokens: 349_530 };
      const priced = priceUsage(usage);
      expect(priced.costUsd).toBeCloseTo(0.10597, 12);
      expect(priced.components.cacheWrite).toBeCloseTo(0.02907, 12);
      expect(priceUsage({ ...usage, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })).toEqual(priced);
      for (const cache_creation of [{ ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 },
        { ephemeral_5m_input_tokens: 0 }, { ephemeral_1h_input_tokens: 0 }]) {
        expect(priceUsage({ ...usage, cache_creation }).costUsd).toBeNull();
      }
      expect(priceUsage({ ...usage, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: null } as never }).costUsd).toBeNull();
      expect(priceReconciledUsage({ ...usage, forwardedModel: 'global.openai.gpt-6.1-sol',
        pricing_context_complete: true, speed: 'standard', service_tier: 'standard', inference_geo: '' }).costUsd).toBeNull();
    });

    it('prices consecutive responses with real one-hour token shapes', () => {
      const calls = [
        { input_tokens: 2, output_tokens: 1_711, cache_creation_input_tokens: 460_039, cache_read_input_tokens: 0 },
        { input_tokens: 2, output_tokens: 184, cache_creation_input_tokens: 2_911, cache_read_input_tokens: 460_039 },
      ];
      const prices = calls.map((usage) => priceUsage({
        model: 'claude-opus-5-5', ...usage,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: usage.cache_creation_input_tokens },
      }));
      expect(prices[0].costUsd).toBeCloseTo(3.71454, 9);
      expect(prices[1].costUsd).toBeCloseTo(0.1189838, 9);
      expect(prices.every((price) => price.pricingStatus === 'priced')).toBe(true);
      expect(prices[0].components.cacheWrite1h).toBeCloseTo(3.680312, 9);
      expect(prices[1].components.cacheRead).toBeCloseTo(0.0920078, 9);
      expect(prices.reduce((sum, price) => sum + price.costUsd!, 0)).toBeCloseTo(3.8335238, 9);
    });

    it.each([
      ['claude-opus-5-5', ['claude-opus-5.5', 'global.anthropic.claude-opus-5-5-v1:0', 'bedrock/global.anthropic.claude-opus-5.5-v1:0[1m]']],
      ['claude-fable-5-1', ['claude-fable-5.1', 'anthropic/claude-fable-5-1[1m]']],
      ['gpt-6.1-sol', ['gpt-6-1-sol', 'openai.gpt-6.1-sol', 'bedrock/global.openai.gpt-6-1-sol[1m]']],
      ['claude-haiku-5-5', ['claude-haiku-5.5', 'anthropic.claude-haiku-5-5[1m]']],
    ])('normalizes %s without changing its price', (model, aliases) => {
      const expected = priceUsage({ model, ...response });
      for (const alias of aliases) {
        expect(priceUsage({ model: alias, ...response })).toEqual(expected);
      }
    });

    it.each([
      ['gpt-6.1-sol', 272_000, 2, 10, 0.1, 4, 15, 0.2],
      ['gpt-6-astra', 272_000, 10, 50, 1, 20, 75, 2],
      ['gpt-6-luna', 272_000, 0.1, 0.5, 0.01, 0.2, 0.75, 0.02],
      ['claude-haiku-5-5', 100_000, 0.1, 0.5, 0.01, 0.5, 2.5, 0.05],
    ])('selects %s rates at the exact context boundary', (model, boundary, input, output, read, longInput, longOutput, longRead) => {
      for (const delta of [-1, 0, 1]) {
        const isLong = delta > 0;
        const result = priceUsage({
          model: `${model}[1m]`, input_tokens: boundary - 21 + delta, output_tokens: 1_000_000,
          cache_creation_input_tokens: 10, cache_read_input_tokens: 11,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
        });
        const inputRate = isLong ? longInput : input;
        expect(result.pricingStatus).toBe('priced');
        expect(result.components.output).toBe(isLong ? longOutput : output);
        expect(result.components.cacheRead).toBeCloseTo(11 * (isLong ? longRead : read) / 1_000_000, 12);
        if (model.startsWith('gpt')) {
          expect(result.components.input).toBeCloseTo((boundary - 21 + delta) * inputRate / 1_000_000, 12);
          expect(result.components.cacheWrite).toBeCloseTo(10 * inputRate * 1.25 / 1_000_000, 12);
          expect(result.components.cacheWrite5m).toBe(0);
          expect(result.components.cacheWrite1h).toBe(0);
        } else {
          expect(result.components.input).toBeCloseTo((boundary - 21 + delta) * inputRate / 1_000_000, 12);
          expect(result.components.cacheWrite5m).toBeCloseTo(4 * inputRate * 1.25 / 1_000_000, 12);
          expect(result.components.cacheWrite1h).toBeCloseTo(6 * inputRate * 2 / 1_000_000, 12);
        }
      }
    });

    it('uses response context rather than accumulated session tokens', () => {
      const calls = Array.from({ length: 4 }, () => ({
        model: 'gpt-6.1-sol', input_tokens: 50_000, output_tokens: 100,
        cache_creation_input_tokens: 20_000, cache_read_input_tokens: 30_000,
      }));
      expect(calls.map(priceUsage).reduce((sum, price) => sum + price.costUsd!, 0)).toBeCloseTo(0.616, 9);
      expect(priceUsage({
        model: 'gpt-6.1-sol', input_tokens: 200_000, output_tokens: 400,
        cache_creation_input_tokens: 80_000, cache_read_input_tokens: 120_000,
      }).costUsd).toBeCloseTo(1.23, 9);
    });

    it('reports separate mixed-TTL cost components', () => {
      const result = priceUsage({
        model: 'claude-opus-5-5', input_tokens: 1_500, output_tokens: 2_200,
        cache_read_input_tokens: 35_000, cache_creation_input_tokens: 17_000,
        cache_creation: { ephemeral_5m_input_tokens: 12_000, ephemeral_1h_input_tokens: 5_000 },
      });
      expect(result.pricingStatus).toBe('priced');
      const expected = { input: 0.006, output: 0.044, cacheRead: 0.007, cacheWrite5m: 0.06, cacheWrite1h: 0.04 };
      for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
        expect(result.components[key]).toBeCloseTo(expected[key], 12);
      }
      expect(result.costUsd).toBeCloseTo(0.157, 9);
    });

    it('derives a missing creation total from TTL details without double counting', () => {
      expect(priceUsage({
        model: 'claude-fable-5-1', input_tokens: 0, output_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      }).costUsd).toBeCloseTo(0.00525, 9);
    });

    it('accepts a single explicit TTL counter and zero-token details', () => {
      expect(priceUsage({
        model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 },
      }).costUsd).toBeCloseTo(0.0008, 12);
      expect(priceUsage({
        model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      }).costUsd).toBe(0);
    });

    it.each([undefined, null, {}])('does not invent cache TTL when details are %s', (cache_creation) => {
      const result = priceUsage({
        model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 200,
        cache_creation_input_tokens: 300, cache_creation,
      });
      expect(result.costUsd).toBeNull();
      expect(result.pricingStatus).toBe('unpriced');
      expect(result.components.input).toBeCloseTo(0.0004, 9);
      expect(result.components.cacheWrite5m).toBeNull();
      expect(result.components.cacheWrite1h).toBeNull();
    });

    it.each(['gpt-6.1-sol', 'gpt-6-astra'])('prices %s separate creation at its published write rate without claiming a Claude TTL', (model) => {
      const result = priceUsage({
        model, input_tokens: 1_000, output_tokens: 100,
        cache_creation_input_tokens: 2_000, cache_read_input_tokens: 3_000,
      });
      expect(result.pricingStatus).toBe('priced');
      expect(result.components.input).toBeCloseTo(model === 'gpt-6.1-sol' ? 0.002 : 0.01, 9);
      expect(result.components.cacheWrite).toBeCloseTo(model === 'gpt-6.1-sol' ? 0.005 : 0.025, 9);
      expect(result.components.cacheWrite5m).toBe(0);
      expect(result.components.cacheWrite1h).toBe(0);
    });

    it.each([0, 299, 301])('rejects creation total %s inconsistent with mixed TTL details', (total) => {
      expect(priceUsage({
        model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 100,
        cache_creation_input_tokens: total,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      }).pricingStatus).toBe('unpriced');
    });

    it('rejects inconsistent TTL details even for implicit cache creation', () => {
      expect(priceUsage({
        model: 'gpt-6.1-sol', input_tokens: 100, output_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
      }).pricingStatus).toBe('unpriced');
    });

    it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid token count %s', (invalid) => {
      const params = { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0 };
      for (const field of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        expect(priceUsage({ ...params, [field]: invalid }).pricingStatus).toBe('unpriced');
      }
      for (const field of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
        expect(priceUsage({ ...params, cache_creation: { [field]: invalid } }).pricingStatus).toBe('unpriced');
      }
    });

    it('rejects unsafe combined context counts', () => {
      expect(priceUsage({
        model: 'gpt-6.1-sol', input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0,
        cache_read_input_tokens: 1,
      }).pricingStatus).toBe('unpriced');
    });

    it.each(['unknown-model', 'claude-opus-5-50', 'claude-opus-5-6', 'claude-haiku-5-6', 'gpt-6.1-sol-preview', 'notclaude-opus-5-5'])('keeps unknown model %s unpriced', (model) => {
      expect(findPricing(model)).toBeUndefined();
      expect(priceUsage({ model, input_tokens: 100, output_tokens: 200 })).toEqual({
        costUsd: null, pricingStatus: 'unpriced', pricingVersion: PRICING_VERSION,
        components: { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null },
      });
    });

    it('distinguishes known zero cost from unknown zero-token usage', () => {
      expect(priceUsage({ model: 'glm-4-flash', input_tokens: 100, output_tokens: 200 }).costUsd).toBe(0);
      expect(priceUsage({ model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0 }).pricingStatus).toBe('priced');
      expect(priceUsage({ model: 'unknown', input_tokens: 0, output_tokens: 0 }).pricingStatus).toBe('unpriced');
    });

    it('honors explicit custom cache rates and normalized model overrides', () => {
      const result = priceUsage({
        model: 'bedrock/global.anthropic.claude-opus-5.5[1m]', input_tokens: 1_000, output_tokens: 1_000,
        cache_creation_input_tokens: 3_000, cache_read_input_tokens: 1_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
        customPricing: [{ pattern: 'claude-opus-5-5', input: 2, output: 3, cacheWrite: 4, cacheWrite1h: 5, cacheRead: 6 }],
      });
      expect(result.costUsd).toBeCloseTo(0.025, 9);
      expect(result.pricingStatus).toBe('priced');
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])('does not price invalid or overflowing custom rates %s', (input) => {
      expect(priceUsage({
        model: 'custom-model', input_tokens: 2_000_000, output_tokens: 0,
        customPricing: [{ pattern: 'custom-model', input, output: 0 }],
      }).pricingStatus).toBe('unpriced');
    });

    it('does not silently zero a cache component with no known price', () => {
      expect(priceUsage({
        model: 'custom-model', input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 100,
        customPricing: [{ pattern: 'custom-model', input: 1, output: 1 }],
      }).pricingStatus).toBe('unpriced');
      expect(priceUsage({
        model: 'custom-model', input_tokens: 100, output_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 100 },
        customPricing: [{ pattern: 'custom-model', input: 1, output: 1, cacheWrite: 1.25 }],
      }).components.cacheWrite1h).toBeNull();
    });
  });

  describe('jev (System One decisions)', () => {
    it('bills input only — output tokens are free', () => {
      const cost = computeCost({ model: 'jev-1.13.0', input_tokens: 1_000_000, output_tokens: 5_000 });
      expect(cost).toBeCloseTo(0.042, 6);
    });

    it('matches gateway model ids by substring', () => {
      const cost = computeCost({ model: 'typesafe/jev-1.13-20260917', input_tokens: 500_000, output_tokens: 0 });
      expect(cost).toBeCloseTo(0.021, 6);
    });
  });

  describe('metadata', () => {
    it('has a pricing version string', () => {
      expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('default pricing table has entries', () => {
      expect(DEFAULT_PRICING.length).toBeGreaterThan(10);
    });

    it('all entries have required fields', () => {
      for (const entry of DEFAULT_PRICING) {
        expect(entry.pattern).toBeTruthy();
        expect(typeof entry.input).toBe('number');
        expect(typeof entry.output).toBe('number');
      }
    });
  });
});
