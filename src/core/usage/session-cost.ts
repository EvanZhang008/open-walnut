/**
 * What one session cost: the engine's own per-request usage (read on the
 * session's host, session-cost-core.ts) priced per request tier with the price
 * book. Nothing is guessed: a request with no price stays unpriced and is counted
 * as such, so a partly known session shows its known part plus what is missing,
 * never a total that silently treats the missing part as zero.
 */
import { ensurePriceBook, priceBookInfo, priceThresholds, resolvePrice, type UserPriceRates } from './price-book.js';
import { priceScanWith, type SessionCostPayload } from './session-cost-pricing.js';
import type { SessionCostScan } from '../../providers/session-cost-core.js';

export type { SessionCostLine, SessionCostModel, SessionCostPayload, SessionCostRates, SessionCostTier } from './session-cost-pricing.js';
export { priceBucket } from './session-cost-pricing.js';

export async function priceSessionScan(scan: SessionCostScan, thresholds: number[], overrides?: Record<string, UserPriceRates>): Promise<SessionCostPayload> {
  await ensurePriceBook();
  return priceScanWith(scan, thresholds, (model, speed) => resolvePrice(model, speed, overrides), priceBookInfo());
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
