/**
 * Where a model's price comes from, in order:
 *
 *   1. the user's own rates (config.yaml `usage.prices`, keyed by model name);
 *   2. LiteLLM's public price file: the copy the server refreshed within the last
 *      day (WALNUT_HOME/cache/pricing), else the snapshot shipped in this build;
 *   3. Walnut's built-in table (pricing.ts), which also holds the rows LiteLLM has
 *      no first-party entry for (Claude fast mode).
 *
 * The refresh never blocks a request: a lookup that finds the copy stale starts
 * one fetch in the background and answers from what it has.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { DEFAULT_PRICING, findPricing, type PricingEntry } from './pricing.js';
import { indexSnapshot, LITELLM_PRICES_URL, priceKey, rowToEntry, trimLiteLlmPrices, type PriceRow, type PriceSnapshot } from './price-data.js';

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

const REFRESH_MS = 24 * 60 * 60_000;
const RETRY_MS = 6 * 60 * 60_000;
const CACHE_FILE = path.join(WALNUT_HOME, 'cache', 'pricing', 'model-prices.json');

let loaded: { snapshot: PriceSnapshot; index: ReturnType<typeof indexSnapshot>; fromCache: boolean } | undefined;
let loading: Promise<void> | undefined;
let refreshing: Promise<void> | undefined;
let lastAttempt = 0;

/** The shipped snapshot: `data/` sits next to the bundle in dist/ and next to the sources under src/. */
async function bundledFile(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, 'data', 'pricing', 'model-prices.json');
    if (await fs.stat(candidate).then(s => s.isFile(), () => false)) return candidate;
    dir = path.dirname(dir);
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'pricing', 'model-prices.json');
}

async function readSnapshot(file: string): Promise<PriceSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as PriceSnapshot;
    if (parsed?.source === 'litellm' && parsed.models && typeof parsed.fetchedAt === 'string' && Object.keys(parsed.models).length >= 20) return parsed;
  } catch { /* absent or broken: the next source answers */ }
  return undefined;
}

function install(snapshot: PriceSnapshot, fromCache: boolean): void {
  loaded = { snapshot, index: indexSnapshot(snapshot), fromCache };
}

async function load(): Promise<void> {
  const [cached, bundled] = await Promise.all([readSnapshot(CACHE_FILE), bundledFile().then(readSnapshot)]);
  // A cached copy older than the build's own snapshot is never preferred.
  if (cached && (!bundled || cached.fetchedAt >= bundled.fetchedAt)) install(cached, true);
  else if (bundled) install(bundled, false);
}

function refreshAllowed(): boolean {
  if (process.env.WALNUT_PRICE_REFRESH === '0') return false;
  return !(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // One parse of the ~3 MB file a day: measured 4.3 ms, far below a loop stall.
    const snapshot = trimLiteLlmPrices(await res.json(), new Date().toISOString());
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot));
    await fs.rename(tmp, CACHE_FILE);
    install(snapshot, true);
    log.usage.info('model prices refreshed', { models: Object.keys(snapshot.models).length });
  } catch (err) {
    log.usage.warn('model price refresh failed; keeping the current prices', { error: String(err) });
  }
}

function maybeRefresh(): void {
  if (!refreshAllowed() || refreshing || !loaded) return;
  const age = Date.now() - Date.parse(loaded.snapshot.fetchedAt);
  if (age < REFRESH_MS || Date.now() - lastAttempt < RETRY_MS) return;
  lastAttempt = Date.now();
  refreshing = refresh().finally(() => { refreshing = undefined; });
}

/** Loads the price data once (async); later calls are free. */
export async function ensurePriceBook(): Promise<void> {
  if (!loaded) await (loading ??= load().finally(() => { loading = undefined; }));
  maybeRefresh();
}

function userEntry(model: string, rates: UserPriceRates): PricingEntry | undefined {
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
export function resolvePrice(model: string, speed: string, overrides?: Record<string, UserPriceRates>): ResolvedPrice | undefined {
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
  const hit = loaded?.index.get(key);
  if (hit) return { entry: rowToEntry(hit.key, hit.row), source: 'litellm', sourceKey: hit.key, asOf: loaded!.snapshot.fetchedAt };
  const builtin = findPricing(key);
  if (builtin && (!fast || builtin.pattern.endsWith('-fast'))) return { entry: builtin, source: 'builtin', sourceKey: builtin.pattern };
  return undefined;
}

/** Every prompt threshold any known price uses, ascending (the daemon buckets by them). */
export function priceThresholds(overrides?: Record<string, UserPriceRates>): number[] {
  const set = new Set<number>();
  for (const entry of DEFAULT_PRICING) if (entry.contextThreshold) set.add(entry.contextThreshold);
  for (const row of Object.values(loaded?.snapshot.models ?? {})) if (row.threshold) set.add(row.threshold);
  for (const rates of Object.values(overrides ?? {})) if (typeof rates.threshold === 'number' && rates.threshold > 0) set.add(rates.threshold);
  return [...set].sort((a, b) => a - b);
}

export function priceBookInfo(): { source: 'litellm' | 'builtin'; asOf?: string; refreshed: boolean } {
  return loaded ? { source: 'litellm', asOf: loaded.snapshot.fetchedAt, refreshed: loaded.fromCache } : { source: 'builtin', refreshed: false };
}

/** Test seam: forget what was loaded. */
export function resetPriceBookForTests(snapshot?: PriceSnapshot): void {
  loaded = undefined; loading = undefined; refreshing = undefined; lastAttempt = 0;
  if (snapshot) install(snapshot, false);
}
