/**
 * Time tracking routes.
 *
 *   POST /api/time/heartbeats  — the browser banks closed lease windows here.
 *   GET  /api/time/summary?days=N — per-day per-task human + agent time.
 *
 * Both answer fast or answer DEGRADED, never hang: the summary races a deadline
 * and returns whatever the in-memory rollup already holds (flagged
 * `degraded: true`) rather than pinning a connection while disk/store work
 * finishes. One stalled response starves the browser's 6-connection pool.
 *
 * Not `/api/timeline` — that path belongs to the screen-activity Life Tracker.
 */

import { Router, type Request, type Response } from 'express';
import { CLOUD_MODE } from '../../constants.js';
import { log } from '../../logging/index.js';
import {
  getIndex, hydrate, localDateKey, recentDateKeys, recordTime, resetTimeStore,
  sanitizeSamples, startAgentTimeCollector, stopAgentTimeCollector, summarize, withLedgerBackfill,
  type RollupIndex, type TimeRecord, type TimeSummary,
} from '../../core/time-tracking/index.js';

export const timeRouter = Router();

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
/** Budget for the whole summary (hydrate + focus tiers + ledger backfill). */
const SUMMARY_DEADLINE_MS = 2_000;

/** Start the collectors. Idempotent; safe to call on every server boot. */
export function startTimeTracking(): void {
  if (CLOUD_MODE) return; // a replica has no local sessions and no local store
  startAgentTimeCollector();
  // Warm the rollup off the request path so the first /summary is already hot.
  void hydrate();
}

/**
 * Counterpart of startTimeTracking, called from stopServer(). Detaching the bus
 * subscription is the part that matters: a mid-tick `session:result` after
 * shutdown would otherwise bank time into a torn-down store (and a test's next
 * startServer() would inherit the previous run's rollup).
 * Unconditional — cheap, and correct even if CLOUD_MODE flipped since boot.
 */
export function stopTimeTracking(): void {
  stopAgentTimeCollector();
  resetTimeStore();
}

/** Session→task resolution is bounded: at most this many lookups per request. */
const MAX_TASK_LOOKUPS = 20;
/** The lookups are indexed sqlite reads, but never let them hold the response. */
const LOOKUP_DEADLINE_MS = 500;

// POST /api/time/heartbeats — { samples: [{ ts, durationMs, kind, taskId?, sessionId? }] }
// 204 once the samples are folded into the live rollup; the JSONL append settles
// behind the response.
timeRouter.post('/heartbeats', async (req: Request, res: Response) => {
  try {
    if (CLOUD_MODE) {
      res.status(501).json({ error: 'not_supported_cloud', message: 'time tracking lives on the primary box only' });
      return;
    }
    const records = sanitizeSamples((req.body ?? {}).samples, new Date());
    if (records.length === 0) {
      res.status(204).end();
      return;
    }
    // The client sends sessionId for a session panel and lets the server own the
    // session→task mapping (the panel DOM carries no task id, and the client
    // must not be the authority on it).
    const bail = deadline(LOOKUP_DEADLINE_MS);
    try {
      await Promise.race([attachTaskIds(records), bail.promise]);
    } finally {
      bail.cancel();
    }
    void recordTime(records); // folds synchronously, appends in the background
    res.status(204).end();
  } catch (err) {
    // Telemetry must never surface as a user-visible failure.
    log.web.warn('time heartbeats rejected', { error: err instanceof Error ? err.message : String(err) });
    res.status(204).end();
  }
});

/** A cancellable timeout — Promise.race never cancels its loser on its own. */
function deadline(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

/** Fill in taskId for session samples from the sessions table. Best-effort. */
async function attachTaskIds(records: TimeRecord[]): Promise<void> {
  const needs = [...new Set(records.filter((r) => !r.taskId && r.sessionId).map((r) => r.sessionId!))];
  if (needs.length === 0) return;
  try {
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js');
    const map = new Map<string, string>();
    for (const sid of needs.slice(0, MAX_TASK_LOOKUPS)) {
      const rec = await getSessionByClaudeId(sid).catch(() => null);
      if (rec?.taskId) map.set(sid, rec.taskId);
    }
    for (const r of records) {
      if (r.taskId || !r.sessionId) continue;
      const taskId = map.get(r.sessionId);
      if (taskId) r.taskId = taskId;
    }
  } catch { /* unattributed session time still counts, just under '' */ }
}

// GET /api/time/summary?days=N — the whole panel in one round trip.
timeRouter.get('/summary', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'time tracking lives on the primary box only' });
    return;
  }
  // Only a positive integer is a window; 0 / negative / junk fall back to the
  // default rather than silently collapsing to a one-day answer.
  const raw = parseInt(String(req.query.days), 10);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_DAYS) : DEFAULT_DAYS;
  const today = localDateKey(new Date());
  const dates = recentDateKeys(today, days);

  // Never pin the connection: on the deadline, answer with whatever the live
  // rollup already holds (no disk, no join) and flag it degraded. One stalled
  // response starves the browser's 6-connection pool for the whole app.
  const bail = deadline(SUMMARY_DEADLINE_MS);
  const partial = (): TimeSummary => summarize(getIndex(), { days: dates, today, degraded: true });
  // The loser of the race keeps running, so its failure must be absorbed here
  // rather than becoming an unhandled rejection after the response is sent.
  const build = buildSummary(dates, today).catch((err: unknown) => {
    log.web.warn('time summary failed', { error: err instanceof Error ? err.message : String(err) });
    return partial();
  });

  try {
    res.json(await Promise.race([build, bail.promise.then(partial)]));
  } finally {
    bail.cancel();
  }
});

async function buildSummary(dates: string[], today: string): Promise<TimeSummary> {
  await hydrate();
  // Copy before layering the backfill so the live rollup is never polluted.
  const index: RollupIndex = new Map(getIndex());
  await withLedgerBackfill(index, dates);
  const focusTaskIds = await readFocusTaskIds();
  return summarize(index, { days: dates, today, focusTaskIds });
}

/** Focus-tier membership drives the "focus share" stat. Empty on any failure. */
async function readFocusTaskIds(): Promise<string[]> {
  try {
    const { getTierSplit } = await import('../../core/task-manager.js');
    const split = await getTierSplit();
    return split.focus_tasks ?? [];
  } catch {
    return [];
  }
}
