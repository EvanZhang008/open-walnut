import { describe, it, expect } from 'vitest';
import { computeCost, findPricing, DEFAULT_PRICING, PRICING_VERSION } from '../../../src/core/usage/pricing.js';

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

    it('returns undefined for unknown models', () => {
      const entry = findPricing('totally-unknown-model-xyz');
      expect(entry).toBeUndefined();
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

    it('falls back to most expensive pricing for unknown models', () => {
      const cost = computeCost({
        model: 'unknown-model',
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      // Fallback: 15 + 75 = 90
      expect(cost).toBeCloseTo(90.00, 2);
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
