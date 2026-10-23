/**
 * What one session cost: the engine's own per-request usage (read on the
 * session's host, session-cost-core.ts) priced per request tier with the price
 * book. Nothing is guessed: a request with no price stays unpriced and is counted
 * as such, so a partly known session shows its known part plus what is missing,
 * never a total that silently treats the missing part as zero.
 */
import type { PricingEntry, PricingRates } from './pricing.js';
import { priceWithEntry } from './pricing.js';
import { ensurePriceBook, priceBookInfo, priceThresholds, resolvePrice, type PriceSourceKind, type UserPriceRates } from './price-book.js';
import type { SessionCostBucket, SessionCostScan, SessionCostSource } from '../../providers/session-cost-core.js';

/** Anthropic's server-side web search, per request (USD). */
const WEB_SEARCH_USD = 0.01;

export interface SessionCostRates extends PricingRates {
  threshold?: number;
  long?: PricingRates;
  /** Cache writes billed at one rate regardless of lifetime. */
  singleCacheWrite?: boolean;
}

/** One row of a model's cost table: tokens (searches for webSearch) times a rate. */
export interface SessionCostLine {
  kind: 'input' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead' | 'output' | 'webSearch';
  /** Tokens, or searches for webSearch. */
  count: number;
  /** USD per million tokens, or per thousand searches. */
  rate: number;
  /** What the row cost, the US-region surcharge included. */
  costUsd: number;
}

/** The priced requests of one model at one prompt tier: base, or past the model's threshold. */
export interface SessionCostTier {
  tier: 'base' | 'long';
  responses: number;
  costUsd: number;
  lines: SessionCostLine[];
}

export interface SessionCostModel {
  /** The model name as the engine reported it (normalized). */
  model: string;
  speed: 'standard' | 'fast';
  responses: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWrite: number };
  /** Cost of the priced responses; null when none of them could be priced. */
  costUsd: number | null;
  unpricedResponses: number;
  unpricedReason?: string;
  /** Responses whose prompt went past the model's tier threshold. */
  longResponses: number;
  webSearches: number;
  /** Responses billed at the US-only region surcharge (1.1x). */
  usRegionResponses: number;
  rates?: SessionCostRates;
  /** Cost table per prompt tier, priced requests only. */
  tiers: SessionCostTier[];
  priceSource?: { kind: PriceSourceKind; key: string; asOf?: string };
  firstAt: string;
  lastAt: string;
}

export interface SessionCostPayload {
  sessionId: string;
  engine: string;
  source: SessionCostSource | 'unavailable';
  /** priced: every response priced; partial: some; unpriced: usage but no prices; empty: no responses yet;
   *  pending: a long first read is still going (ask again); unavailable: usage not readable. */
  status: 'priced' | 'partial' | 'unpriced' | 'empty' | 'pending' | 'unavailable';
  pending?: { readBytes: number; totalBytes: number };
  reason?: string;
  totalUsd: number | null;
  responses: number;
  unpricedResponses: number;
  models: SessionCostModel[];
  firstAt?: string;
  lastAt?: string;
  /** What the engine itself reports (its own built-in prices and clocks). */
  engineCostUsd?: number;
  apiDurationMs?: number;
  durationMs?: number;
  prices: { source: 'litellm' | 'builtin'; asOf?: string };
  scanMs?: number;
}

function ratesOf(entry: PricingEntry): SessionCostRates {
  return {
    input: entry.input, output: entry.output,
    ...(entry.cacheRead !== undefined ? { cacheRead: entry.cacheRead } : {}),
    ...(entry.cacheWrite !== undefined ? { cacheWrite: entry.cacheWrite } : {}),
    ...(entry.cacheWrite1h !== undefined && !entry.separateCacheCreation ? { cacheWrite1h: entry.cacheWrite1h } : {}),
    ...(entry.contextThreshold !== undefined && entry.longContext ? { threshold: entry.contextThreshold, long: entry.longContext } : {}),
    ...(entry.separateCacheCreation ? { singleCacheWrite: true } : {}),
  };
}

interface BucketPrice { costUsd: number; long: boolean; lines: SessionCostLine[] }

/** Price one bucket; a string is the reason it cannot be priced. */
export function priceBucket(bucket: SessionCostBucket, entry: PricingEntry, thresholds: number[]): BucketPrice | string {
  if (bucket.tier !== 'standard') return `${bucket.tier} service tier has no price here`;
  if (!['global', 'us', ''].includes(bucket.geo)) return `region ${bucket.geo} has no price here`;
  const separate = entry.separateCacheCreation === true;
  if (!separate && bucket.cacheWrite > 0) return 'cache writes were reported without their 5m/1h split';
  let long = false;
  if (entry.contextThreshold !== undefined && entry.longContext) {
    const index = thresholds.indexOf(entry.contextThreshold);
    if (index < 0) return 'request sizes were not grouped by this model\'s tier threshold';
    long = bucket.band > index;
  }
  const writes = bucket.cacheWrite5m + bucket.cacheWrite1h + bucket.cacheWrite;
  const price = priceWithEntry(entry, {
    model: bucket.model,
    input_tokens: bucket.input,
    output_tokens: bucket.output,
    cache_read_input_tokens: bucket.cacheRead,
    cache_creation_input_tokens: writes,
    ...(separate ? {} : { cache_creation: { ephemeral_5m_input_tokens: bucket.cacheWrite5m, ephemeral_1h_input_tokens: bucket.cacheWrite1h } }),
    inference_geo: bucket.geo === 'us' ? 'us' : '',
  }, { long });
  if (price.costUsd === null) {
    const missing = Object.entries(price.components).filter(([, v]) => v === null).map(([k]) => k);
    return `no rate for ${missing.join(', ') || 'these tokens'}`;
  }
  const rates = (long ? entry.longContext : entry) ?? entry;
  const c = price.components;
  const lines: SessionCostLine[] = [
    { kind: 'input', count: bucket.input, rate: rates.input, costUsd: c.input ?? 0 },
    ...(separate
      ? [{ kind: 'cacheWrite' as const, count: writes, rate: rates.cacheWrite ?? 0, costUsd: c.cacheWrite ?? 0 }]
      : [{ kind: 'cacheWrite5m' as const, count: bucket.cacheWrite5m, rate: rates.cacheWrite ?? 0, costUsd: c.cacheWrite5m ?? 0 },
        { kind: 'cacheWrite1h' as const, count: bucket.cacheWrite1h, rate: rates.cacheWrite1h ?? 0, costUsd: c.cacheWrite1h ?? 0 }]),
    { kind: 'cacheRead', count: bucket.cacheRead, rate: rates.cacheRead ?? 0, costUsd: c.cacheRead ?? 0 },
    { kind: 'output', count: bucket.output, rate: rates.output, costUsd: c.output ?? 0 },
  ];
  const searches = bucket.model.startsWith('claude-') ? bucket.webSearches : 0;
  if (searches > 0) lines.push({ kind: 'webSearch', count: searches, rate: WEB_SEARCH_USD * 1_000, costUsd: searches * WEB_SEARCH_USD });
  return { costUsd: price.costUsd + searches * WEB_SEARCH_USD, long, lines };
}

/** Fold a priced bucket's rows into its model's tier table. */
function addToTier(m: SessionCostModel, priced: BucketPrice, responses: number): void {
  const tier = priced.long ? 'long' : 'base';
  let t = m.tiers.find(x => x.tier === tier);
  if (!t) {
    t = { tier, responses: 0, costUsd: 0, lines: [] };
    m.tiers.push(t);
    m.tiers.sort((a, b) => (a.tier === 'base' ? 0 : 1) - (b.tier === 'base' ? 0 : 1));
  }
  t.responses += responses;
  t.costUsd += priced.costUsd;
  for (const line of priced.lines) {
    const row = t.lines.find(l => l.kind === line.kind);
    if (row) { row.count += line.count; row.costUsd += line.costUsd; } else t.lines.push({ ...line });
  }
}

export async function priceSessionScan(scan: SessionCostScan, thresholds: number[], overrides?: Record<string, UserPriceRates>): Promise<SessionCostPayload> {
  await ensurePriceBook();
  const models = new Map<string, SessionCostModel>();
  for (const bucket of scan.buckets) {
    const speed = bucket.speed === 'fast' || /-fast$/.test(bucket.model) ? 'fast' : 'standard';
    const id = `${bucket.model}\u0000${speed}`;
    let m = models.get(id);
    const resolved = resolvePrice(bucket.model, speed, overrides);
    if (!m) {
      m = { model: bucket.model, speed, responses: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 },
        costUsd: null, unpricedResponses: 0, longResponses: 0, webSearches: 0, usRegionResponses: 0, tiers: [],
        ...(resolved ? { rates: ratesOf(resolved.entry), priceSource: { kind: resolved.source, key: resolved.sourceKey, ...(resolved.asOf ? { asOf: resolved.asOf } : {}) } } : {}),
        firstAt: bucket.firstAt, lastAt: bucket.lastAt };
      models.set(id, m);
    }
    m.responses += bucket.responses;
    m.tokens.input += bucket.input; m.tokens.output += bucket.output; m.tokens.cacheRead += bucket.cacheRead;
    m.tokens.cacheWrite5m += bucket.cacheWrite5m; m.tokens.cacheWrite1h += bucket.cacheWrite1h; m.tokens.cacheWrite += bucket.cacheWrite;
    m.webSearches += bucket.webSearches;
    if (bucket.firstAt < m.firstAt) m.firstAt = bucket.firstAt;
    if (bucket.lastAt > m.lastAt) m.lastAt = bucket.lastAt;
    const cost = resolved ? priceBucket(bucket, resolved.entry, thresholds)
      : `no price for ${bucket.model}${speed === 'fast' ? ' in fast mode' : ''}`;
    if (typeof cost !== 'string') {
      m.costUsd = (m.costUsd ?? 0) + cost.costUsd;
      addToTier(m, cost, bucket.responses);
      if (cost.long) m.longResponses += bucket.responses;
      if (bucket.geo === 'us') m.usRegionResponses += bucket.responses;
    } else {
      m.unpricedResponses += bucket.responses;
      m.unpricedReason ??= cost;
    }
  }
  const list = [...models.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.responses - a.responses);
  const responses = list.reduce((n, m) => n + m.responses, 0);
  const unpriced = list.reduce((n, m) => n + m.unpricedResponses, 0);
  const priced = list.filter(m => m.costUsd !== null);
  const totalUsd = priced.length ? priced.reduce((sum, m) => sum + m.costUsd!, 0) : null;
  const status: SessionCostPayload['status'] = scan.pending ? 'pending' : !scan.found ? 'unavailable'
    : responses === 0 ? 'empty' : unpriced === 0 ? 'priced' : totalUsd === null ? 'unpriced' : 'partial';
  return {
    sessionId: scan.sessionId, engine: scan.engine, source: scan.source, status,
    ...(scan.reason ? { reason: scan.reason } : {}),
    ...(scan.pending ? { pending: scan.pending } : {}),
    totalUsd, responses, unpricedResponses: unpriced, models: list,
    ...(scan.firstAt ? { firstAt: scan.firstAt, lastAt: scan.lastAt } : {}),
    // Claude Code's saved figure is as old as its last save and priced with its own stale table; only
    // an engine that prices every message as it goes (OpenCode) has a figure worth showing beside ours.
    ...(scan.engineTotals?.costUsd !== undefined && scan.source !== 'claude-transcript' ? { engineCostUsd: scan.engineTotals.costUsd } : {}),
    ...(scan.engineTotals?.apiDurationMs !== undefined ? { apiDurationMs: scan.engineTotals.apiDurationMs } : {}),
    ...(scan.engineTotals?.durationMs !== undefined ? { durationMs: scan.engineTotals.durationMs } : {}),
    prices: priceBookInfo(), scanMs: scan.scanMs,
  };
}

export function unavailable(sessionId: string, engine: string, reason: string): SessionCostPayload {
  return { sessionId, engine, source: 'unavailable', status: 'unavailable', reason, totalUsd: null,
    responses: 0, unpricedResponses: 0, models: [], prices: priceBookInfo() };
}

const DEADLINE_MS = 25_000;

export type SessionScanRead =
  | { ok: true; scan: SessionCostScan; thresholds: number[]; overrides?: Record<string, UserPriceRates> }
  | { ok: false; payload: SessionCostPayload };

/** Read one session's usage on its host, within the deadline (degraded, never hanging). */
export async function readSessionScan(sessionId: string): Promise<SessionScanRead> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw Object.assign(new Error('session not found'), { statusCode: 404 });
  const engine = record.engine ?? 'claude';
  const host = record.host ?? '__local__';
  const [{ getConfig }, { DaemonFileReader }] = await Promise.all([
    import('../config-manager.js'), import('../daemon-file-reader.js'), ensurePriceBook(),
  ]);
  const overrides = (await getConfig()).usage?.prices;
  const thresholds = priceThresholds(overrides);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), DEADLINE_MS); });
  try {
    const read = new DaemonFileReader(host).readSessionCost({ sessionId, engine, cwd: record.cwd, thresholds }, DEADLINE_MS);
    // A read that loses the race may still fail later; that failure has no listener left.
    read.catch(() => {});
    const scan = await Promise.race([read, deadline]);
    if (scan === 'timeout') return { ok: false, payload: unavailable(sessionId, engine, 'The session\'s host did not answer in time.') };
    if (scan === null) return { ok: false, payload: unavailable(sessionId, engine, 'The session\'s host runs an older Walnut daemon; it updates on its next connect.') };
    return { ok: true, scan: scan as SessionCostScan, thresholds, ...(overrides ? { overrides } : {}) };
  } catch (err) {
    return { ok: false, payload: unavailable(sessionId, engine, `Usage could not be read: ${(err as Error).message}`) };
  } finally {
    clearTimeout(timer);
  }
}

/** One session's cost, answered within the deadline (degraded, never hanging). */
export async function getSessionCost(sessionId: string): Promise<SessionCostPayload> {
  const read = await readSessionScan(sessionId);
  if (!read.ok) return read.payload;
  return priceSessionScan(read.scan, read.thresholds, read.overrides);
}
