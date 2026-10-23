/**
 * Model price data in Walnut's own small shape, built from LiteLLM's public price
 * file (model_prices_and_context_window.json). Pure: no I/O. The bundled snapshot
 * (src/data/pricing/model-prices.json, `scripts/update-model-prices.ts`) and the
 * server's daily refresh (price-book.ts) both go through `trimLiteLlmPrices`, so
 * they can never disagree about what a row means.
 *
 * Rates are USD per million tokens. A row with `threshold` switches the WHOLE
 * request to `long` once its prompt (input + cache reads + cache writes) is
 * larger than the threshold; that is how LiteLLM's `*_above_<N>k_tokens` keys
 * and the providers' own price pages describe it.
 */
import type { PricingEntry, PricingRates } from './pricing.js';

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export interface PriceRow {
  provider: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  threshold?: number;
  long?: PricingRates;
}

export interface PriceSnapshot {
  source: 'litellm';
  url: string;
  /** When Walnut fetched the file (ISO). */
  fetchedAt: string;
  models: Record<string, PriceRow>;
}

/** First-party API providers: their rows are the list prices the engines' models are sold at. */
const FIRST_PARTY = new Set(['anthropic', 'openai', 'gemini', 'xai', 'mistral', 'deepseek', 'zai', 'moonshot', 'dashscope']);
const CHAT_MODES = new Set(['chat', 'responses', undefined]);

function perMillion(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1e6 * 1e6) / 1e6;
}

function defined<T extends object>(row: T): T {
  for (const key of Object.keys(row) as (keyof T)[]) if (row[key] === undefined) delete row[key];
  return row;
}

/** One LiteLLM row → Walnut's row; undefined when it is not a priced chat model. */
export function liteLlmRow(raw: Record<string, unknown>): PriceRow | undefined {
  const input = perMillion(raw.input_cost_per_token);
  const output = perMillion(raw.output_cost_per_token);
  if (input === undefined || output === undefined) return undefined;
  const row: PriceRow = defined({
    provider: String(raw.litellm_provider ?? ''),
    input, output,
    cacheRead: perMillion(raw.cache_read_input_token_cost),
    cacheWrite: perMillion(raw.cache_creation_input_token_cost),
    cacheWrite1h: perMillion(raw.cache_creation_input_token_cost_above_1hr),
  });
  // The smallest prompt threshold that changes the input rate decides the tier.
  let threshold: number | undefined;
  for (const key of Object.keys(raw)) {
    const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (m && perMillion(raw[key]) !== undefined) {
      const t = Number(m[1]) * 1000;
      if (threshold === undefined || t < threshold) threshold = t;
    }
  }
  if (threshold !== undefined) {
    const k = `${threshold / 1000}k`;
    row.threshold = threshold;
    // A component the file gives no long rate for keeps its base rate.
    row.long = defined({
      input: perMillion(raw[`input_cost_per_token_above_${k}_tokens`])!,
      output: perMillion(raw[`output_cost_per_token_above_${k}_tokens`]) ?? output,
      cacheRead: perMillion(raw[`cache_read_input_token_cost_above_${k}_tokens`]) ?? row.cacheRead,
      cacheWrite: perMillion(raw[`cache_creation_input_token_cost_above_${k}_tokens`]) ?? row.cacheWrite,
      cacheWrite1h: perMillion(raw[`cache_creation_input_token_cost_above_1hr_above_${k}_tokens`]) ?? row.cacheWrite1h,
    });
  }
  return row;
}

export function trimLiteLlmPrices(raw: unknown, fetchedAt: string): PriceSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Price file is not a JSON object');
  const models: Record<string, PriceRow> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || key === 'sample_spec') continue;
    const row = value as Record<string, unknown>;
    if (!FIRST_PARTY.has(String(row.litellm_provider)) || !CHAT_MODES.has(row.mode as string | undefined)) continue;
    const trimmed = liteLlmRow(row);
    if (trimmed) models[key] = trimmed;
  }
  if (Object.keys(models).length < 20) throw new Error('Price file holds almost no chat models');
  return { source: 'litellm', url: LITELLM_PRICES_URL, fetchedAt, models };
}

/**
 * The name a price is looked up by: provider paths, region and vendor prefixes,
 * release dates, version suffixes and the `[1m]` window marker removed, and dots
 * between digits turned into dashes (`gpt-6.1-sol` and `claude-opus-5.5` style
 * names meet their dashed twins). Exact match only after this: a near miss must
 * stay unpriced, never borrow a neighbour's price.
 */
export function priceKey(model: string): string {
  let name = model.trim().toLowerCase().replace(/(?:\[[^\]]*\])+$/, '');
  name = name.slice(name.lastIndexOf('/') + 1);
  name = name.replace(/^(?:us|eu|apac|au|jp|global|us-gov)\./, '')
    .replace(/^(?:anthropic|openai|google|xai|mistral|deepseek|zai|moonshot)\./, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '')
    .replace(/(\d)\.(?=\d)/g, '$1-');
  return name;
}

/** Index a snapshot by price key; the first-listed provider row wins a tie. */
export function indexSnapshot(snapshot: PriceSnapshot): Map<string, { key: string; row: PriceRow }> {
  const index = new Map<string, { key: string; row: PriceRow }>();
  for (const [key, row] of Object.entries(snapshot.models)) {
    const k = priceKey(key);
    const existing = index.get(k);
    // The undated name is the current alias; prefer it over a dated snapshot row.
    if (!existing || (priceKey(existing.key) !== existing.key.toLowerCase() && priceKey(key) === key.toLowerCase())) {
      index.set(k, { key, row });
    }
  }
  return index;
}

export function rowToEntry(pattern: string, row: Omit<PriceRow, 'provider'> & { provider?: string }): PricingEntry {
  return defined({
    pattern,
    input: row.input, output: row.output,
    cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, cacheWrite1h: row.cacheWrite1h,
    contextThreshold: row.threshold, longContext: row.long,
    // Only Anthropic splits cache writes by lifetime; everyone else bills one write rate.
    separateCacheCreation: row.provider === 'anthropic' ? undefined : (row.cacheWrite1h === undefined ? true : undefined),
  });
}
