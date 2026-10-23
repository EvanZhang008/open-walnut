/**
 * What one session's usage would have cost on other models: the same requests
 * (input, cache read, cache write and output tokens, prompt size per request)
 * priced at each model's own list price and prompt tier. Another model would
 * tokenize, cache and answer differently, so this is a guide, not a quote.
 *
 * Two groups: the models the picker offers (the client sends their ids) and a
 * short list of popular models Walnut does not run.
 */
import type { PricingEntry } from './pricing.js';
import { resolvePrice, type PriceSourceKind, type UserPriceRates } from './price-book.js';
import { priceKey } from './price-data.js';
import { readSessionScan } from './session-cost.js';
import type { SessionCostBucket, SessionCostScan } from '../../providers/session-cost-core.js';

/** Popular models outside Walnut, newest of each family. Absent ones are skipped. */
export const POPULAR_COMPARISON_MODELS: { id: string; label: string }[] = [
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'kimi-k3', label: 'Kimi K3' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { id: 'glm-5.3', label: 'GLM-5.3' },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max' },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'grok-4.3', label: 'Grok 4.3' },
  { id: 'mistral-large-4', label: 'Mistral Large 4' },
];

/** The most model ids one request may ask about. */
export const MAX_COMPARE_MODELS = 60;

export interface SessionCostComparisonRow {
  /** The id as asked (or the popular list's id). */
  id: string;
  /** Price key the id resolved to; rows are unique by it. */
  key: string;
  label?: string;
  group: 'walnut' | 'popular';
  costUsd: number;
  /** Requests whose prompt went past this model's own threshold. */
  longResponses: number;
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number; threshold?: number };
  /** Where a rate was missing and what stood in for it. */
  assumptions: string[];
  /** One of the models this session actually ran on. */
  current: boolean;
  priceSource: { kind: PriceSourceKind; key: string };
}

export interface SessionCostComparison {
  sessionId: string;
  status: 'ok' | 'pending' | 'unavailable' | 'empty';
  reason?: string;
  responses: number;
  rows: SessionCostComparisonRow[];
  /** Ids that resolved to no price. */
  unknown: string[];
}

/**
 * How a model that prices cache writes by lifetime should take the writes the
 * session reported without one (a GPT session's): split like the session's own
 * Claude writes when it has some, else as Claude Code writes them (it asks for the
 * 1-hour cache: 99.5% of its writes measured 2026-10-22), else as 5-minute ones.
 */
export function unsplitWriteShare(buckets: SessionCostBucket[], engine: string): { share1h: number; note: string } {
  const w5 = buckets.reduce((n, b) => n + b.cacheWrite5m, 0);
  const w1 = buckets.reduce((n, b) => n + b.cacheWrite1h, 0);
  if (w5 + w1 > 0) {
    const share1h = w1 / (w5 + w1);
    return { share1h, note: `cache writes of unknown lifetime split like this session's own (${Math.round(share1h * 100)}% 1-hour)` };
  }
  return engine === 'claude'
    ? { share1h: 1, note: 'cache writes of unknown lifetime at the 1-hour price, as Claude Code writes them' }
    : { share1h: 0, note: 'cache writes of unknown lifetime at the 5-minute price' };
}

/** The write rate a model is compared at: its listed one, else (none, or a listed 0 on another model) its input rate. */
function writeRate(listed: number | undefined, input: number, own: boolean): number {
  if (listed !== undefined && (listed > 0 || own)) return listed;
  return input;
}

/**
 * Price every bucket at one model's rates; null when its tier cannot be told.
 * `own` is a model the session ran on: its listed rates are taken as they are
 * (a listed $0 write stays $0), so it reprices to exactly what /cost charged.
 */
export function repriceBuckets(buckets: SessionCostBucket[], entry: PricingEntry, thresholds: number[],
  unsplit: { share1h: number; note: string } = { share1h: 0, note: 'cache writes of unknown lifetime at the 5-minute price' },
  own = false):
  { costUsd: number; longResponses: number; assumptions: string[] } | null {
  let index = -1;
  if (entry.contextThreshold !== undefined && entry.longContext) {
    index = thresholds.indexOf(entry.contextThreshold);
    if (index < 0) return null;
  }
  // Only a model that prices both cache lifetimes splits writes by lifetime.
  const byLifetime = !entry.separateCacheCreation && entry.cacheWrite1h !== undefined;
  const assumptions = new Set<string>();
  let usd = 0;
  let longResponses = 0;
  for (const b of buckets) {
    const long = index >= 0 && b.band > index;
    if (long) longResponses += b.responses;
    const r = long ? entry.longContext! : entry;
    if (r.cacheRead === undefined && b.cacheRead > 0) assumptions.add('cache reads at the input price (no cache price listed)');
    const read = r.cacheRead ?? r.input;
    const written = b.cacheWrite5m + b.cacheWrite1h + b.cacheWrite;
    let writes: number;
    if (!byLifetime) {
      const rate = writeRate(r.cacheWrite, r.input, own);
      // A provider that lists no write price bills a cache miss as ordinary input.
      if (written > 0 && rate === r.input && r.cacheWrite !== r.input) assumptions.add('cache writes at the input price (no cache write price listed)');
      writes = written * rate;
    } else {
      const w5 = r.cacheWrite ?? r.input;
      const w1 = r.cacheWrite1h ?? w5;
      if (b.cacheWrite > 0) assumptions.add(unsplit.note);
      writes = (b.cacheWrite5m + b.cacheWrite * (1 - unsplit.share1h)) * w5 + (b.cacheWrite1h + b.cacheWrite * unsplit.share1h) * w1;
    }
    usd += (b.input * r.input + b.cacheRead * read + writes + b.output * r.output) / 1e6;
  }
  return { costUsd: usd, longResponses, assumptions: [...assumptions] };
}

function ratesOf(entry: PricingEntry, own: boolean): SessionCostComparisonRow['rates'] {
  return {
    input: entry.input, output: entry.output,
    cacheRead: entry.cacheRead ?? entry.input,
    cacheWrite: writeRate(entry.cacheWrite, entry.input, own),
    ...(entry.contextThreshold !== undefined && entry.longContext ? { threshold: entry.contextThreshold } : {}),
  };
}

export function compareSessionScan(scan: SessionCostScan, thresholds: number[], ids: string[], overrides?: Record<string, UserPriceRates>): SessionCostComparison {
  const base = { sessionId: scan.sessionId, rows: [] as SessionCostComparisonRow[], unknown: [] as string[] };
  if (scan.pending) return { ...base, status: 'pending', responses: 0 };
  if (!scan.found) return { ...base, status: 'unavailable', responses: 0, ...(scan.reason ? { reason: scan.reason } : {}) };
  const responses = scan.buckets.reduce((n, b) => n + b.responses, 0);
  if (responses === 0) return { ...base, status: 'empty', responses };
  const unsplit = unsplitWriteShare(scan.buckets, scan.engine);
  const used = new Set(scan.buckets.map(b => priceKey(b.model).replace(/-fast$/, '')));
  const seen = new Set<string>();
  const add = (id: string, group: SessionCostComparisonRow['group'], label?: string) => {
    const resolved = resolvePrice(id, 'standard', overrides);
    if (!resolved) { if (group === 'walnut') base.unknown.push(id); return; }
    const key = priceKey(resolved.sourceKey);
    if (seen.has(key)) return;
    const own = used.has(key);
    const priced = repriceBuckets(scan.buckets, resolved.entry, thresholds, unsplit, own);
    if (!priced) { if (group === 'walnut') base.unknown.push(id); return; }
    seen.add(key);
    base.rows.push({
      id, key, ...(label ? { label } : {}), group, costUsd: priced.costUsd, longResponses: priced.longResponses,
      rates: ratesOf(resolved.entry, own), assumptions: priced.assumptions, current: own,
      priceSource: { kind: resolved.source, key: resolved.sourceKey },
    });
  };
  for (const id of ids.slice(0, MAX_COMPARE_MODELS)) add(id, 'walnut');
  // What the session ran on belongs in the list even when the picker no longer offers it.
  for (const b of scan.buckets) add(priceKey(b.model).replace(/-fast$/, ''), 'walnut');
  for (const m of POPULAR_COMPARISON_MODELS) add(m.id, 'popular', m.label);
  base.rows.sort((a, b) => a.costUsd - b.costUsd);
  return { ...base, status: 'ok', responses };
}

/** What one session's usage would cost on each model (GET /api/sessions/:id/cost/compare). */
export async function getSessionCostComparison(sessionId: string, ids: string[]): Promise<SessionCostComparison> {
  const read = await readSessionScan(sessionId);
  if (!read.ok) {
    return { sessionId, status: read.payload.status === 'pending' ? 'pending' : 'unavailable', responses: 0, rows: [], unknown: [],
      ...(read.payload.reason ? { reason: read.payload.reason } : {}) };
  }
  return compareSessionScan(read.scan, read.thresholds, ids, read.overrides);
}
