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
 *   GET  /api/time/screentime?date= — ONE day of APPLE Screen Time, per device
 *        (the iPhone, and this Mac when the user asks for it), from Walnut's own
 *        permanent copy. Never reads Apple's store on the request path.
 *   POST /api/time/screentime/toggle — the master switch and the "show this Mac"
 *        switch (both opt-in, persisted).
 *   POST /api/time/screentime/refresh — snapshot Apple's store now.
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
  attachTaskIdsBounded,
  dayBoundsMs, foldDayBlocks, foldDaySlices, foldOutsideApps, foldOutsideTimeline, getIndex, hydrate,
  isOutsideCollectorRunning,
  localDateKey, outsideDayRecords, outsideDayRows, readDayRecords, recentDateKeys,
  outsideHelperReason, recordTime, resetHeartbeatDedupe, resetOutsideStore, resetTimeStore,
  sanitizeSamples, startAgentTimeCollector,
  startOutsideCollector, stopAgentTimeCollector, stopOutsideCollector, summarize, walnutHostsFromConfig,
  withLedgerBackfill, TIME_KINDS,
  SCREEN_TIME_BLOCK_GRANULARITY,
  startScreenTimeSnapshots, stopScreenTimeSnapshots,
  type DayBlocks, type HelperUnavailable, type OutsideApp, type OutsideAppTimeline, type RollupIndex,
  type ScreenTimeDeviceFold,
  type TimeKind, type TimeRecord,
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
  // Same shape: the hourly Screen Time snapshot checks the config on each tick, so
  // arming it costs nothing when the feature is off, and enabling it later does not
  // need a restart. Apple purges its own history, so a missed window is lost data.
  startScreenTimeSnapshots();
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
  // The dedupe ledger describes what THIS rollup already holds, so it has to die
  // with the rollup: a remembered id against a fresh (empty) store would skip a
  // sample nobody has banked.
  resetHeartbeatDedupe();
  // The helper child must die with the server: an orphan would keep sampling
  // into a store nobody reads (it also exits on its own once stdout closes).
  stopOutsideCollector();
  resetOutsideStore();
  // The snapshot timer must not outlive the server: a tick against a torn-down
  // store would spawn a helper for nobody.
  stopScreenTimeSnapshots();
  resetScreenTimeAccessCache();
}

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
    // must not be the authority on it). Shared with the v1 (phone) path so the
    // two endpoints can never disagree about attribution.
    await attachTaskIdsBounded(records);
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

export interface DayAppsBlocksResponse {
  date: string;
  enabled: boolean;
  /** A helper process is attached and streaming right now. */
  running: boolean;
  totalMs: number;
  /** Time that counts but cannot be placed on the axis: ts-less records from an
   *  old fold, or timestamps outside the day's local bounds. */
  unplacedMs: number;
  apps: OutsideAppTimeline[];
  /** Apps beyond the row cap: counted in totalMs, but without a row of their own. */
  droppedApps: number;
  droppedMs: number;
  /** Why sampling cannot run here, when it cannot (mirrors /apps). */
  reason?: HelperUnavailable;
  degraded?: boolean;
}

// GET /api/time/apps/blocks — WHEN each outside app was in front, as per-app
// intervals for the timeline. Walnut's own time is excluded (the attention lanes
// already draw it); a browser is one row, its sites stay the Apps tab's detail.
timeRouter.get('/apps/blocks', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'outside activity is sampled on the primary box only' });
    return;
  }
  const raw = typeof req.query.date === 'string' && req.query.date ? req.query.date : localDateKey(new Date());
  if (!dayBoundsMs(raw)) {
    res.status(400).json({ error: 'invalid_date', message: 'date must be a real YYYY-MM-DD' });
    return;
  }
  const date = raw;
  const reason = helperReason();
  const empty = (): DayAppsBlocksResponse => ({
    date, enabled: lastKnownOutsideEnabled, running: isOutsideCollectorRunning(),
    totalMs: 0, unplacedMs: 0, apps: [], droppedApps: 0, droppedMs: 0,
    ...(reason ? { reason } : {}), degraded: true,
  });
  const bail = deadline(APPS_DEADLINE_MS);
  const build = buildAppsBlocks(date).catch((err: unknown) => {
    log.web.warn('time apps blocks failed', { date, error: err instanceof Error ? err.message : String(err) });
    return empty();
  });
  try {
    res.json(await Promise.race([build, bail.promise.then(empty)]));
  } finally {
    bail.cancel();
  }
});

async function buildAppsBlocks(date: string): Promise<DayAppsBlocksResponse> {
  const { getConfig } = await import('../../core/config-manager.js');
  const config = await getConfig().catch(() => undefined);
  if (config) lastKnownOutsideEnabled = config.time?.outside?.enabled === true;
  const records = await outsideDayRecords(date);
  const fold = foldOutsideTimeline(records, {
    walnutHosts: walnutHostsFromConfig(config),
    // The day's LOCAL bounds: a ts outside them (old midnight-UTC folds) must
    // count without being drawn at a fictional hour.
    bounds: dayBoundsMs(date),
  });
  const reason = helperReason();
  return {
    date,
    enabled: lastKnownOutsideEnabled,
    running: isOutsideCollectorRunning(),
    totalMs: fold.totalMs,
    unplacedMs: fold.unplacedMs,
    apps: fold.apps,
    droppedApps: fold.droppedApps,
    droppedMs: fold.droppedMs,
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
      // Drop the in-memory rollup too, so a disable really forgets: the next read
      // re-hydrates from disk. Without this, buckets banked by a misbehaving helper
      // survive in memory until the server restarts, and no amount of repairing the
      // JSONL changes what /apps answers (learned repairing a stale-frontmost day).
      resetOutsideStore();
    }
    res.json({ enabled: next, running: isOutsideCollectorRunning() });
  } catch (err) {
    log.web.warn('time apps toggle failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'toggle_failed', message: 'could not persist the outside-activity setting' });
  }
});

// ── GET /api/time/screentime?date=YYYY-MM-DD ──
// ONE day of Apple Screen Time, per device, out of Walnut's own permanent copy.
//
// The request path NEVER touches Apple's store: that read costs three file copies
// through an FDA helper plus five SQL queries, which is a background job's work,
// not a route's. Snapshots run hourly (screentime-snapshot.ts) and this endpoint
// serves what they banked. `?refresh=1` is available for the "I just granted the
// permission" moment, and even then only kicks the snapshot off and answers with
// whatever is stored.

/** Budget for one day of Screen Time (one config read + one day file + a probe). */
const SCREENTIME_DEADLINE_MS = 2_000;
/** How long a permission probe answer is reused. A probe is a helper spawn, and
 *  the tab polls; the grant does not change second to second. */
const ACCESS_TTL_MS = 15_000;

/** What is standing between the user and their numbers, if anything. */
export type ScreenTimeAccess =
  /** Reading works (or there is simply no Screen Time database on this Mac). */
  | 'ok'
  /** The helper needs Full Disk Access and has never had it. */
  | 'needs_grant'
  /** The helper is in the FDA list but the entry is stale (remove and re-add). */
  | 'stale_grant'
  /** Screen Time has never written a store here. */
  | 'no_store'
  /** No macOS, or the helper cannot be built on this box. */
  | 'unavailable'
  /** Not asked, because the feature is switched off. */
  | 'off'
  /** The probe itself failed; do NOT send the user to System Settings for it. */
  | 'unknown';

export interface ScreenTimeResponse {
  date: string;
  /** config.time.screentime.enabled — off by default; this reads a whole other
   *  app's data, so it never starts without being asked for. */
  enabled: boolean;
  /** config.time.screentime.include_this_mac — Apple's row for THIS Mac is stored
   *  either way, but hidden unless asked for (Walnut measures this Mac itself at
   *  five-second resolution, so two numbers for it would just be confusing). */
  includeThisMac: boolean;
  access: ScreenTimeAccess;
  /** The exact path the user must add in System Settings, when that is the fix. */
  helperPath?: string;
  devices: ScreenTimeDeviceFold[];
  /** This Mac's own Apple rows: always sent when includeThisMac, else omitted. */
  localDevices?: ScreenTimeDeviceFold[];
  totalMs: number;
  pickups: number;
  notifications: number;
  /** Apple's number for this Mac, whether or not it is being shown. */
  localTotalMs: number;
  /** These blocks are HOUR-resolution, unlike the Mac's own 5-second samples. A
   *  client must label them differently or it is implying a precision we lack. */
  blockGranularity: typeof SCREEN_TIME_BLOCK_GRANULARITY;
  /** Ms-since-epoch of the last snapshot attempt, and whether it worked. */
  lastSnapshotAt?: number;
  lastSnapshotOk?: boolean;
  /** Dates the permanent store holds, newest first. Lets the UI offer only days
   *  that exist instead of an empty view for a day never captured. */
  storedDates?: string[];
  degraded?: boolean;
}

/** Cached probe: { at, access, helperPath }. Absent until the first probe. */
let accessCache: { at: number; access: ScreenTimeAccess; helperPath?: string } | null = null;

/**
 * Forget the cached permission answer. Called from stopTimeTracking(), because a
 * remembered 'ok' describes a grant on the machine the LAST server saw: it must not
 * outlive that server and answer for the next one, whose WALNUT_HOME (and therefore
 * whose helper binary, and therefore whose TCC identity) may be a different one
 * entirely.
 */
export function resetScreenTimeAccessCache(): void {
  accessCache = null;
  lastKnownScreenTime = { enabled: false, includeThisMac: false };
}

/** Last read config values, so a degraded answer reports what we last knew rather
 *  than asserting 'off' — which reads as "you turned it off". */
let lastKnownScreenTime = { enabled: false, includeThisMac: false };

async function screenTimeAccess(enabled: boolean): Promise<{ access: ScreenTimeAccess; helperPath?: string }> {
  if (!enabled) return { access: 'off' };
  if (accessCache && Date.now() - accessCache.at < ACCESS_TTL_MS) {
    return { access: accessCache.access, ...(accessCache.helperPath ? { helperPath: accessCache.helperPath } : {}) };
  }
  const { probeScreenTimeAccess } = await import('../../core/time-tracking/screentime-reader.js');
  const result = await probeScreenTimeAccess();
  const mapped: { access: ScreenTimeAccess; helperPath?: string } = !('kind' in result)
    ? { access: 'ok', helperPath: result.helperPath }
    : result.kind === 'denied'
      ? { access: result.denied, helperPath: result.helperPath }
      : result.kind === 'no_store'
        ? { access: 'no_store', helperPath: result.helperPath }
        : result.kind === 'unavailable'
          ? { access: 'unavailable' }
          : { access: 'unknown' };
  accessCache = { at: Date.now(), ...mapped };
  return mapped;
}

timeRouter.get('/screentime', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'Screen Time is read on the primary box only' });
    return;
  }
  const raw = typeof req.query.date === 'string' && req.query.date ? req.query.date : localDateKey(new Date());
  if (!dayBoundsMs(raw)) {
    res.status(400).json({ error: 'invalid_date', message: 'date must be a real YYYY-MM-DD' });
    return;
  }
  const date = raw;
  const empty = (): ScreenTimeResponse => ({
    date,
    enabled: lastKnownScreenTime.enabled,
    includeThisMac: lastKnownScreenTime.includeThisMac,
    access: 'unknown',
    devices: [],
    totalMs: 0,
    pickups: 0,
    notifications: 0,
    localTotalMs: 0,
    blockGranularity: SCREEN_TIME_BLOCK_GRANULARITY,
    degraded: true,
  });
  const bail = deadline(SCREENTIME_DEADLINE_MS);
  const build = buildScreenTime(date, isTruthy(req.query.refresh)).catch((err: unknown) => {
    log.web.warn('screen time day failed', { date, error: err instanceof Error ? err.message : String(err) });
    return empty();
  });
  try {
    res.json(await Promise.race([build, bail.promise.then(empty)]));
  } finally {
    bail.cancel();
  }
});

async function buildScreenTime(date: string, refresh: boolean): Promise<ScreenTimeResponse> {
  const { getConfig } = await import('../../core/config-manager.js');
  const config = await getConfig().catch(() => undefined);
  if (config) {
    lastKnownScreenTime = {
      enabled: config.time?.screentime?.enabled === true,
      includeThisMac: config.time?.screentime?.include_this_mac === true,
    };
  }
  const { enabled, includeThisMac } = lastKnownScreenTime;

  const [{ readScreenTimeDay, listScreenTimeDates }, { foldScreenTimeDay }, snapshot] = await Promise.all([
    import('../../core/time-tracking/screentime-store.js'),
    import('../../core/time-tracking/screentime-view.js'),
    import('../../core/time-tracking/screentime-snapshot.js'),
  ]);

  // Fire-and-forget: a refresh must not make the user wait for three file copies
  // and five queries. The next poll picks up whatever it banked.
  if (refresh && enabled) void snapshot.snapshotScreenTime().catch(() => undefined);

  const [file, storedDates, access] = await Promise.all([
    readScreenTimeDay(date),
    listScreenTimeDates().catch(() => [] as string[]),
    screenTimeAccess(enabled),
  ]);

  // Which device was this Mac is recorded per row at capture time, so a day
  // captured before a machine swap keeps the labelling it was stored with.
  const localDeviceIds = file.records
    .filter((rec) => rec.kind === 'device' && rec.local === true)
    .map((rec) => rec.deviceId);
  const fold = foldScreenTimeDay(file.records, { date, localDeviceIds });
  const last = snapshot.lastSnapshotOutcome();

  return {
    date,
    enabled,
    includeThisMac,
    access: access.access,
    ...(access.helperPath ? { helperPath: access.helperPath } : {}),
    devices: fold.devices,
    ...(includeThisMac ? { localDevices: fold.localDevices } : {}),
    totalMs: fold.totalMs,
    pickups: fold.pickups,
    notifications: fold.notifications,
    localTotalMs: fold.localTotalMs,
    blockGranularity: SCREEN_TIME_BLOCK_GRANULARITY,
    ...(last ? { lastSnapshotAt: last.at, lastSnapshotOk: last.ok } : {}),
    storedDates: storedDates.slice(-90).reverse(),
  };
}

// POST /api/time/screentime/toggle — { enabled?, includeThisMac? }
// Either switch, or both. An explicit boolean wins so a double-fired UI cannot
// flip twice; omitting both flips `enabled`, which is what a plain switch sends.
timeRouter.post('/screentime/toggle', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'Screen Time is read on the primary box only' });
    return;
  }
  // Persisting `enabled: true` where nothing can ever read the store would show a
  // switch that is on while nothing happens. Refuse rather than lie.
  if (process.platform !== 'darwin') {
    res.status(501).json({ error: 'not_supported_platform', message: 'Apple Screen Time needs macOS' });
    return;
  }
  try {
    const { getConfig, updateConfig } = await import('../../core/config-manager.js');
    const config = await getConfig();
    const current = {
      enabled: config.time?.screentime?.enabled === true,
      includeThisMac: config.time?.screentime?.include_this_mac === true,
    };
    const body = (req.body ?? {}) as { enabled?: unknown; includeThisMac?: unknown };
    const next = {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : (
        typeof body.includeThisMac === 'boolean' ? current.enabled : !current.enabled
      ),
      includeThisMac: typeof body.includeThisMac === 'boolean' ? body.includeThisMac : current.includeThisMac,
    };
    if (next.enabled !== current.enabled || next.includeThisMac !== current.includeThisMac) {
      // updateConfig replaces the whole `time` key, so its siblings ride along.
      await updateConfig({
        time: {
          ...config.time,
          screentime: {
            ...config.time?.screentime,
            enabled: next.enabled,
            include_this_mac: next.includeThisMac,
          },
        },
      });
    }
    lastKnownScreenTime = next;
    // A fresh probe next read: enabling is exactly when the cached 'off' is wrong.
    accessCache = null;
    const snapshot = await import('../../core/time-tracking/screentime-snapshot.js');
    if (next.enabled) {
      snapshot.startScreenTimeSnapshots();
      // Do not wait: a first enable pays a swiftc compile plus the copies, and the
      // switch has to answer now. The UI's next poll reports what happened.
      void snapshot.snapshotScreenTime().catch(() => undefined);
    } else {
      // Stop reading Apple's store. Everything already snapshotted stays: turning
      // this off is "stop collecting", never "delete my history".
      snapshot.stopScreenTimeSnapshots();
    }
    const access = await screenTimeAccess(next.enabled);
    res.json({ ...next, access: access.access, ...(access.helperPath ? { helperPath: access.helperPath } : {}) });
  } catch (err) {
    log.web.warn('screen time toggle failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'toggle_failed', message: 'could not persist the Screen Time setting' });
  }
});

// POST /api/time/screentime/refresh — snapshot Apple's store now, and WAIT for it.
// The one place waiting is right: the user just granted the permission and wants
// to see whether it worked. Bounded, and it answers with the outcome either way.
timeRouter.post('/screentime/refresh', async (_req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'Screen Time is read on the primary box only' });
    return;
  }
  const snapshot = await import('../../core/time-tracking/screentime-snapshot.js');
  accessCache = null; // the point of a manual refresh is that something changed
  const bail = deadline(REFRESH_DEADLINE_MS);
  try {
    const outcome = await Promise.race([
      snapshot.snapshotScreenTime(),
      bail.promise.then(() => null),
    ]);
    // A null outcome means it is STILL RUNNING, not that it failed. Saying
    // "failed" here would send the user to fix a permission that is fine.
    res.json(outcome ? { ...outcome, running: false } : { ok: true, running: true, days: 0, devices: 0 });
  } finally {
    bail.cancel();
  }
});

/** A snapshot is three file copies plus five aggregate queries. Long for a route,
 *  but this one is a button press whose whole purpose is the answer. */
const REFRESH_DEADLINE_MS = 20_000;
