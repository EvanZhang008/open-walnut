/**
 * Resolving a model's price from a price snapshot, the user's own rates and
 * Walnut's built-in table: pure, so the session daemon prices its budgets with
 * the very same rules the server's cost line uses (price-book.ts holds the
 * server's loaded snapshot; the daemon holds the copy the server pushed it).
 */
import { DEFAULT_PRICING, findPricing, type PricingEntry } from './pricing.js';
import { indexSnapshot, priceKey, rowToEntry, type PriceRow, type PriceSnapshot } from './price-data.js';

export type PriceSourceKind = 'override' | 'litellm' | 'builtin';

export interface ResolvedPrice {
  entry: PricingEntry;
  source: PriceSourceKind;
  /** The row's own name in its source (a LiteLLM key, a config key, a table pattern). */
  sourceKey: string;
  /** When the source's data was fetched (LiteLLM only). */
  asOf?: string;
}

export interface UserPriceRates {
  input?: number; output?: number;
  cache_read?: number; cache_write?: number; cache_write_1h?: number;
  /** Prompt size above which `long` applies to the whole request. */
  threshold?: number;
  long?: Omit<UserPriceRates, 'threshold' | 'long'>;
}

export type PriceIndex = ReturnType<typeof indexSnapshot>;

export function userEntry(model: string, rates: UserPriceRates): PricingEntry | undefined {
  if (typeof rates.input !== 'number' || typeof rates.output !== 'number') return undefined;
  const long = rates.long && typeof rates.long.input === 'number' && typeof rates.long.output === 'number'
    ? { input: rates.long.input, output: rates.long.output, cacheRead: rates.long.cache_read, cacheWrite: rates.long.cache_write, cacheWrite1h: rates.long.cache_write_1h }
    : undefined;
  const row: Omit<PriceRow, 'provider'> & { provider?: string } = {
    input: rates.input, output: rates.output, cacheRead: rates.cache_read, cacheWrite: rates.cache_write, cacheWrite1h: rates.cache_write_1h,
    ...(typeof rates.threshold === 'number' && long ? { threshold: rates.threshold, long } : {}),
    provider: model.startsWith('claude-') ? 'anthropic' : undefined,
  };
  return rowToEntry(model, row);
}

/**
 * The price for one model at one speed. Fast mode is its own row in every
 * source (`<model>-fast`); a model with no fast row stays unpriced in fast mode.
 */
export function resolveWith(index: PriceIndex | undefined, asOf: string | undefined, model: string, speed: string,
  overrides?: Record<string, UserPriceRates>): ResolvedPrice | undefined {
  const named = priceKey(model);
  const base = named.replace(/-fast$/, '');
  // A model named `<x>-fast` is fast mode whatever its speed field says.
  const key = speed === 'fast' || named !== base ? `${base}-fast` : base;
  const fast = key !== base;
  for (const [name, rates] of Object.entries(overrides ?? {})) {
    if (priceKey(name) !== key) continue;
    const entry = userEntry(name, rates);
    if (entry) return { entry, source: 'override', sourceKey: name };
  }
  const hit = index?.get(key);
  if (hit) return { entry: rowToEntry(hit.key, hit.row), source: 'litellm', sourceKey: hit.key, ...(asOf ? { asOf } : {}) };
  const builtin = findPricing(key);
  if (builtin && (!fast || builtin.pattern.endsWith('-fast'))) return { entry: builtin, source: 'builtin', sourceKey: builtin.pattern };
  return undefined;
}

/** Every prompt threshold any known price uses, ascending (the daemon buckets by them). */
export function thresholdsWith(snapshot: PriceSnapshot | undefined, overrides?: Record<string, UserPriceRates>): number[] {
  const set = new Set<number>();
  for (const entry of DEFAULT_PRICING) if (entry.contextThreshold) set.add(entry.contextThreshold);
  for (const row of Object.values(snapshot?.models ?? {})) if (row.threshold) set.add(row.threshold);
  for (const rates of Object.values(overrides ?? {})) if (typeof rates.threshold === 'number' && rates.threshold > 0) set.add(rates.threshold);
  return [...set].sort((a, b) => a - b);
}
