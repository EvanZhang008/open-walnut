import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexSnapshot, liteLlmRow, priceKey, rowToEntry, trimLiteLlmPrices } from '../../../src/core/usage/price-data.js';

const M = 1e-6;

describe('price-data', () => {
  it('reads a tiered Anthropic row: one threshold, every component at its long rate', () => {
    const row = liteLlmRow({
      litellm_provider: 'anthropic', mode: 'chat',
      input_cost_per_token: 0.1 * M, output_cost_per_token: 0.5 * M,
      cache_read_input_token_cost: 0.01 * M, cache_creation_input_token_cost: 0.125 * M,
      cache_creation_input_token_cost_above_1hr: 0.2 * M,
      input_cost_per_token_above_100k_tokens: 0.5 * M, output_cost_per_token_above_100k_tokens: 2.5 * M,
      cache_read_input_token_cost_above_100k_tokens: 0.05 * M, cache_creation_input_token_cost_above_100k_tokens: 0.625 * M,
      cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1 * M,
    });
    expect(row).toEqual({
      provider: 'anthropic', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2,
      threshold: 100_000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 },
    });
    expect(rowToEntry('claude-haiku-5-5', row!).separateCacheCreation).toBeUndefined();
  });

  it('keeps the base rate for a long component the file does not name', () => {
    const row = liteLlmRow({ litellm_provider: 'openai', input_cost_per_token: 2 * M, output_cost_per_token: 10 * M,
      cache_read_input_token_cost: 0.1 * M, input_cost_per_token_above_272k_tokens: 4 * M });
    expect(row!.long).toEqual({ input: 4, output: 10, cacheRead: 0.1 });
    // OpenAI bills one cache-write rate, whatever the lifetime.
    expect(rowToEntry('gpt-6.1-sol', row!).separateCacheCreation).toBe(true);
  });

  it('skips rows without token prices and providers that are not first-party', () => {
    expect(liteLlmRow({ litellm_provider: 'openai', mode: 'chat' })).toBeUndefined();
    const raw: Record<string, unknown> = { sample_spec: { input_cost_per_token: 1 } };
    for (let i = 0; i < 25; i++) raw[`claude-x-${i}`] = { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: M, output_cost_per_token: M };
    raw['azure/claude-x-0'] = { litellm_provider: 'azure', mode: 'chat', input_cost_per_token: 9 * M, output_cost_per_token: 9 * M };
    raw['embed'] = { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: M, output_cost_per_token: 0 };
    const snap = trimLiteLlmPrices(raw, '2026-10-20T00:00:00.000Z');
    expect(Object.keys(snap.models)).toHaveLength(25);
    expect(snap.models['azure/claude-x-0']).toBeUndefined();
    expect(() => trimLiteLlmPrices({}, 'x')).toThrow(/almost no chat models/);
  });

  it('normalizes engine and price-file names to one key, and only exact keys meet', () => {
    expect(priceKey('global.anthropic.claude-opus-5-5-v1[1m]')).toBe('claude-opus-5-5');
    expect(priceKey('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(priceKey('openai.gpt-6.1-sol')).toBe('gpt-6-1-sol');
    expect(priceKey('gpt-6-1-sol')).toBe('gpt-6-1-sol');
    expect(priceKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(priceKey('vertex_ai/claude-opus-5-5@default')).toBe('claude-opus-5-5');
    expect(priceKey('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    // A different model never collapses onto a neighbour.
    expect(priceKey('claude-opus-5')).not.toBe(priceKey('claude-opus-5-5'));
  });

  it('prefers the undated alias over a dated snapshot of the same model', () => {
    const index = indexSnapshot({ source: 'litellm', url: '', fetchedAt: '', models: {
      'claude-haiku-4-5-20251001': { provider: 'anthropic', input: 9, output: 9 },
      'claude-haiku-4-5': { provider: 'anthropic', input: 1, output: 5 },
    } });
    expect(index.get('claude-haiku-4-5')!.key).toBe('claude-haiku-4-5');
  });

  it('ships a snapshot that holds the current models at their list prices', () => {
    const file = fileURLToPath(new URL('../../../src/data/pricing/model-prices.json', import.meta.url));
    const index = indexSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
    const opus = index.get('claude-opus-5-5')!.row;
    expect([opus.input, opus.output, opus.cacheWrite, opus.cacheWrite1h, opus.cacheRead]).toEqual([4, 20, 5, 8, 0.2]);
    const sonnet = index.get('claude-sonnet-5-5')!.row;
    expect(sonnet.cacheRead).toBe(0.1);
    const haiku = index.get('claude-haiku-5-5')!.row;
    expect(haiku.threshold).toBe(100_000);
    const sol = index.get('gpt-6-1-sol')!.row;
    expect([sol.input, sol.output, sol.cacheRead, sol.cacheWrite, sol.threshold]).toEqual([2, 10, 0.1, 2.5, 272_000]);
  });
});
