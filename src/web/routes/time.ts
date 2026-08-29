/**
 * Time tracking routes.
 *
 *   POST /api/time/heartbeats  — the browser banks closed lease windows here.
 *   GET  /api/time/summary?days=N — per-day per-task human + agent time.
 *   GET  /api/time/blocks?date=&kinds=&raw=1 — ONE day as intervals, for the
 *        timeline. `raw=1` switches from per-task merged blocks to ONE serial
 *        ribbon (non-overlapping by construction); see core/time-tracking/blocks.ts.
 *   GET  /api/time/apps?date= — ONE day of OUTSIDE activity: per Mac app, and per
 *        site for a browser, plus how much of it was inside Walnut.
 *   POST /api/time/apps/toggle — turn outside sampling on/off (opt-in, persisted).
 *
 * All of them answer fast or answer DEGRADED, never hang: the reads race a
 * deadline and return whatever is already in hand (flagged `degraded: true`)
 * rather than pinning a connection while disk/store work finishes. One stalled
 * response starves the browser's 6-connection pool.
 *
 * Not `/api/timeline` — that path belongs to the screen-activity Life Tracker.
 */

import { Router, type Request, type Response } from 'express';
import { CLOUD_MODE } from '../../constants.js';
import { log } from '../../logging/index.js';
import {
  dayBoundsMs, foldDayBlocks, foldDaySlices, foldOutsideApps, getIndex, hydrate, isOutsideCollectorRunning,
  localDateKey, outsideDayRows, readDayRecords, recentDateKeys,
  outsideHelperReason, recordTime, resetOutsideStore, resetTimeStore, sanitizeSamples, startAgentTimeCollector,
  startOutsideCollector, stopAgentTimeCollector, stopOutsideCollector, summarize, walnutHostsFromConfig,
  withLedgerBackfill, TIME_KINDS,
  type DayBlocks, type HelperUnavailable, type OutsideApp, type RollupIndex, type TimeKind, type TimeRecord,
  type TimeSummary,
} from '../../core/time-tracking/index.js';

export const timeRouter = Router();

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
/** Budget for the whole summary (hydrate + focus tiers + ledger backfill). */
const SUMMARY_DEADLINE_MS = 2_000;
/** Budget for one day of blocks (one file read + one title join). */
const BLOCKS_DEADLINE_MS = 2_000;
/** Distinct tasks whose titles one day's answer will join. */
const MAX_TITLE_LOOKUPS = 200;

/** Start the collectors. Idempotent; safe to call on every server boot. */
export function startTimeTracking(): void {
  if (CLOUD_MODE) return; // a replica has no local sessions and no local store
  startAgentTimeCollector();
  // Warm the rollup off the request path so the first /summary is already hot.
  void hydrate();
  // Opt-in and self-gating: returns immediately unless config enables it, and a
  // first run's swiftc compile happens off the boot path.
  void startOutsideCollector().catch(() => undefined);
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
  // The helper child must die with the server: an orphan would keep sampling
  // into a store nobody reads (it also exits on its own once stdout closes).
  stopOutsideCollector();
  resetOutsideStore();
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

// ── GET /api/time/blocks?date=YYYY-MM-DD&kinds=session,chat ──
// ONE day as intervals: what the day timeline draws. The fold (merge, threshold,
// midnight clipping) lives in core/time-tracking/blocks.ts and is unit tested
// there; this route only reads the day file and joins task titles.

export interface DayBlocksResponse extends DayBlocks {
  /** taskId → title, for every task in this answer. Missing = unknown/deleted. */
  titles: Record<string, string>;
  /** True when the answer had to be given up on before it was complete. */
  degraded?: boolean;
  /** Echoes the mode, so a client can never mistake merged blocks for a ribbon. */
  raw?: boolean;
}

timeRouter.get('/blocks', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'time tracking lives on the primary box only' });
    return;
  }
  const raw = typeof req.query.date === 'string' && req.query.date ? req.query.date : localDateKey(new Date());
  // A bad date is rejected, NOT quietly answered for today: silently drawing a
  // different day than the one asked for is worse than an error. dayBoundsMs also
  // rejects a well-formed-but-unreal date, which keeps the store's `${date}.jsonl`
  // path from ever seeing anything but a real calendar day.
  if (!dayBoundsMs(raw)) {
    res.status(400).json({ error: 'invalid_date', message: 'date must be a real YYYY-MM-DD' });
    return;
  }
  const date = raw;
  const kinds = parseKinds(req.query.kinds);
  // Serial ribbon vs per-task blocks. Anything truthy but the string 'false'/'0'
  // counts, so `?raw` alone works from a URL bar.
  const serial = isTruthy(req.query.raw);

  const empty = (): DayBlocksResponse => ({
    date, blocks: [], titles: {}, shortMs: 0, foldedMs: 0, totals: [], agentTotalMs: 0, degraded: true,
    ...(serial ? { raw: true } : {}),
  });
  const bail = deadline(BLOCKS_DEADLINE_MS);
  // The loser of the race keeps running, so absorb its failure here rather than
  // letting it become an unhandled rejection after the response is sent.
  const build = buildBlocks(date, kinds, serial).catch((err: unknown) => {
    log.web.warn('time blocks failed', { date, error: err instanceof Error ? err.message : String(err) });
    return empty();
  });

  try {
    res.json(await Promise.race([build, bail.promise.then(empty)]));
  } finally {
    bail.cancel();
  }
});

/** `kinds=session,chat` → the valid subset; absent/junk → undefined (all kinds). */
function parseKinds(raw: unknown): TimeKind[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const wanted = raw.split(',').map((s) => s.trim());
  const kinds = TIME_KINDS.filter((k) => wanted.includes(k));
  return kinds.length > 0 ? [...kinds] : undefined;
}

/** `?raw=1` / `?raw` / `?raw=true` — but not `raw=0` or `raw=false`. */
function isTruthy(value: unknown): boolean {
  if (value === undefined) return false;
  const s = String(value).trim().toLowerCase();
  return s !== '0' && s !== 'false' && s !== 'no';
}

async function buildBlocks(
  date: string,
  kinds: TimeKind[] | undefined,
  serial: boolean,
): Promise<DayBlocksResponse> {
  const records = await readDayRecords(date);
  const fold = serial ? foldDaySlices : foldDayBlocks;
  const day = fold(records, { date, ...(kinds ? { kinds } : {}) });
  // Titles cover the RANKING as well as the drawn slices: a task whose whole day
  // was sub-floor touches never appears in `blocks` but is still a named row.
  const ids = [...new Set([
    ...day.blocks.map((b) => b.taskId),
    ...day.totals.map((t) => t.taskId),
  ].filter(Boolean))];
  return { ...day, titles: await readTaskTitles(ids), ...(serial ? { raw: true } : {}) };
}

/** Join titles so the timeline can label a task the client's list never loaded. */
async function readTaskTitles(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  try {
    const { listTasksByIds } = await import('../../core/task-manager.js');
    const tasks = await listTasksByIds(ids.slice(0, MAX_TITLE_LOOKUPS));
    const out: Record<string, string> = {};
    for (const task of tasks) if (task.id && task.title) out[task.id] = task.title;
    return out;
  } catch {
    return {}; // an unlabelled block still shows WHEN the time went
  }
}

// ── GET /api/time/apps?date=YYYY-MM-DD ──
// ONE day of OUTSIDE activity. The fold and the inside-Walnut rule live in
// core/time-tracking/outside-view.ts and are unit tested there; this route only
// reads config (for the toggle + the companion hostname) and one day of buckets.

/** Budget for one day of apps (one config read + one day read). */
const APPS_DEADLINE_MS = 2_000;
/** A first enable pays a one-time swiftc compile — never hold the toggle for it. */
const TOGGLE_START_DEADLINE_MS = 1_500;

export interface DayAppsResponse {
  date: string;
  /** config.time.outside.enabled — sampling is opt-in and off by default. */
  enabled: boolean;
  /** A helper process is attached and streaming right now. */
  running: boolean;
  totalMs: number;
  /** Of totalMs, how much was the Walnut desktop app or a Walnut-hosted page. */
  walnutMs: number;
  /** False only when a browser WAS used and no sample carried a host (the UI
   *  turns that into the Automation-permission hint). */
  browserHostsSeen: boolean;
  apps: OutsideApp[];
  /** Why sampling cannot run here, when it cannot: no macOS, no Xcode command
   *  line tools for the one-time compile, or the compile itself failed. Absent
   *  means nothing is wrong (or nothing has been attempted yet). */
  reason?: HelperUnavailable;
  /** True when the answer had to be given up on before it was complete. */
  degraded?: boolean;
}

/** Whichever failure the UI should explain: platform first, then the compile. */
function helperReason(): HelperUnavailable | undefined {
  if (process.platform !== 'darwin') return 'not_macos';
  return outsideHelperReason() ?? undefined;
}

/** Last successfully read toggle state, so a degraded answer reports what we
 *  last knew instead of asserting 'off' — which would read as "you turned it off". */
let lastKnownOutsideEnabled = false;

timeRouter.get('/apps', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'outside activity is sampled on the primary box only' });
    return;
  }
  const raw = typeof req.query.date === 'string' && req.query.date ? req.query.date : localDateKey(new Date());
  // Same rule as /blocks: a bad date is rejected, never quietly answered for
  // today, and it keeps the store's `${date}.jsonl` path to real calendar days.
  if (!dayBoundsMs(raw)) {
    res.status(400).json({ error: 'invalid_date', message: 'date must be a real YYYY-MM-DD' });
    return;
  }
  const date = raw;
  const reason = helperReason();
  const empty = (): DayAppsResponse => ({
    date,
    enabled: lastKnownOutsideEnabled,
    running: isOutsideCollectorRunning(),
    totalMs: 0,
    walnutMs: 0,
    browserHostsSeen: true,
    apps: [],
    ...(reason ? { reason } : {}),
    degraded: true,
  });
  const bail = deadline(APPS_DEADLINE_MS);
  // The loser of the race keeps running, so absorb its failure here rather than
  // letting it become an unhandled rejection after the response is sent.
  const build = buildApps(date).catch((err: unknown) => {
    log.web.warn('time apps failed', { date, error: err instanceof Error ? err.message : String(err) });
    return empty();
  });

  try {
    res.json(await Promise.race([build, bail.promise.then(empty)]));
  } finally {
    bail.cancel();
  }
});

async function buildApps(date: string): Promise<DayAppsResponse> {
  const { getConfig } = await import('../../core/config-manager.js');
  const config = await getConfig().catch(() => undefined);
  if (config) lastKnownOutsideEnabled = config.time?.outside?.enabled === true;
  const rows = await outsideDayRows(date);
  const fold = foldOutsideApps(rows, { walnutHosts: walnutHostsFromConfig(config) });
  const reason = helperReason();
  return {
    date,
    enabled: lastKnownOutsideEnabled,
    running: isOutsideCollectorRunning(),
    totalMs: fold.totalMs,
    walnutMs: fold.walnutMs,
    browserHostsSeen: fold.browserHostsSeen,
    apps: fold.apps,
    ...(reason ? { reason } : {}),
  };
}

// POST /api/time/apps/toggle — flips config.time.outside.enabled and applies it
// immediately. An explicit { enabled } in the body wins, so a UI that fires twice
// cannot flip twice.
timeRouter.post('/apps/toggle', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'outside activity is sampled on the primary box only' });
    return;
  }
  // Persisting `enabled: true` on a box that can never sample would leave the UI
  // showing a toggle that is on while nothing ever runs. Refuse instead of lying.
  if (process.platform !== 'darwin') {
    res.status(501).json({ error: 'not_supported_platform', message: 'outside activity sampling needs macOS' });
    return;
  }
  try {
    const { getConfig, updateConfig } = await import('../../core/config-manager.js');
    const config = await getConfig();
    const current = config.time?.outside?.enabled === true;
    const body = (req.body ?? {}) as { enabled?: unknown };
    const next = typeof body.enabled === 'boolean' ? body.enabled : !current;
    if (next !== current) {
      // updateConfig replaces the whole `time` key, so its siblings ride along.
      await updateConfig({ time: { ...config.time, outside: { ...config.time?.outside, enabled: next } } });
    }
    lastKnownOutsideEnabled = next;
    if (next) {
      const bail = deadline(TOGGLE_START_DEADLINE_MS);
      try {
        await Promise.race([startOutsideCollector().catch(() => undefined), bail.promise]);
      } finally {
        bail.cancel();
      }
    } else {
      stopOutsideCollector();
    }
    res.json({ enabled: next, running: isOutsideCollectorRunning() });
  } catch (err) {
    log.web.warn('time apps toggle failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'toggle_failed', message: 'could not persist the outside-activity setting' });
  }
});
