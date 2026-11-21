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
import type { BudgetState } from '../../providers/usage-budget-runtime.js';
import { SwrCache } from './session-cost-cache.js';
import { settledCost } from './session-cost-settled.js';

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

/** One session's cost read now, within the deadline (degraded, never hanging). */
async function readSessionCost(sessionId: string): Promise<SessionCostPayload> {
  const read = await readSessionScan(sessionId);
  if (!read.ok) return read.payload;
  return priceSessionScan(read.scan, read.thresholds, read.overrides);
}

const costCache = new SwrCache<SessionCostPayload>({
  read: readSessionCost,
  keep: settledCost,
  max: 200,
  freshMs: 5_000,
  onRefreshError: (sessionId, err) => {
    void import('../../logging/index.js').then(({ log }) => log.usage.warn('session cost refresh failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })).catch(() => {});
  },
});
let watchingTurns = false;

/** A session's turn ended: its kept cost is stale, so the next read starts a refresh. Nothing is read
 *  now (a read per turn end of every kept session would push the daemon's own cache out). */
function watchTurnEnds(): void {
  if (watchingTurns) return;
  watchingTurns = true;
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe('session-cost-cache', (event) => {
      const sid = (event.data as { sessionId?: string } | undefined)?.sessionId;
      if (sid) costCache.invalidate(sid);
    }, { global: true, interest: [EventNames.SESSION_RESULT] });
  }).catch(() => { watchingTurns = false; });
}

/**
 * One session's cost. The last finished read answers at once and one background read brings it
 * current (SwrCache): the picker's first frame and the phone's sheet get a number, never the
 * host's long first read. With nothing read yet it waits for the read, within its deadline.
 */
export async function getSessionCost(sessionId: string): Promise<SessionCostPayload> {
  watchTurnEnds();
  return costCache.get(sessionId);
}

/** Test seam: forget every kept cost. */
export function resetSessionCostCacheForTests(): void { costCache.clear(); }

/** GET /api/v1/sessions/:id/cost (the phone's model sheet): the cost and the budget in one answer. */
export interface SessionCostFacts {
  cost: SessionCostPayload;
  /** null: no budget here (an engine without per-request usage, a host that does not know the session, or no answer in time). */
  budget: BudgetState | null;
}

/**
 * The cost and the budget of one session, read in parallel, each within its own deadline (cost
 * 25s, budget 10s), so the answer is degraded, never hung. A session nobody recorded is a 404
 * (SessionControlError, so the v1 route and the replica relay answer it the same way).
 */
export async function getSessionCostFacts(sessionId: string): Promise<SessionCostFacts> {
  const [{ SessionControlError }, { getSessionBudget }] = await Promise.all([
    import('../sessions/session-controls.js'), import('./session-budget.js'),
  ]);
  const budget = getSessionBudget(sessionId).then((answer) => answer.budget, () => null);
  try {
    const cost = await getSessionCost(sessionId);
    return { cost, budget: await budget };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw new SessionControlError('session not found', 404);
    throw err;
  }
}
