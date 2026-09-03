import path from 'node:path';
import fs from 'node:fs/promises';
import { SESSIONS_DIR } from '../constants.js';
import { ensureDir } from '../utils/fs.js';
import { isSessionProcessAlive } from '../utils/session-liveness.js';
import { log } from '../logging/index.js';
import type {
  AcpSessionCapabilities,
  SessionSummary,
  SessionRecord,
  SessionMode,
  SessionType,
  TaskPhase,
  ProcessStatus,
  StatusTransition,
  SessionStatusSnapshot,
} from './types.js';
import { getDb, rowToSession, sessionToRow, SESSION_COLUMNS, transaction as sessionDbTx } from './session-db.js';
import { runSessionMigrationIfNeeded } from './session-db-migration.js';
import { bus, EventNames, type EmitOptions } from './event-bus.js';
import type { SessionStatusChangedEvent } from './event-types.js';
// Snapshot enforce-mode legacy-writer gate. session-snapshot-gate has ZERO
// imports (deliberately — this file is imported by nearly everything, so the
// gate lives in a leaf module to avoid a tracker ↔ snapshot-apply cycle).
import {
  getSnapshotStatusMode,
  isSnapshotCovered,
  isLegacyGatedStatusWrite,
  isUnstampedStatusWrite,
  noteSuppressedStatusWrite,
  noteSuppressedErrorReason,
} from './session-snapshot-gate.js';
// Also a zero-import leaf — see the file header for why classification cannot
// live in a prose match.
import { classifyStatusReasonKind } from './session-error-kind.js';
import { isAcpEngine, resolveEngine } from './agents/engine-registry.js';

let sessionInitialized = false;

async function ensureSessionInit(): Promise<void> {
  if (sessionInitialized) return;
  sessionInitialized = true;
  getDb();
  await runSessionMigrationIfNeeded();
}

// ── Whole-store read cache ────────────────────────────────────────────────
// readStore() runs `SELECT * FROM sessions` + rows.map(rowToSession) over the
// WHOLE table (5000+ rows) on EVERY call. The single scan is ~30-45ms, but it
// is re-run uncached on every concurrent request AND multiple times per page
// render (e.g. /api/tasks calls listSessions() a second time to enrich). On a
// single event loop each scan is an uninterruptible synchronous span, so N
// concurrent reads serialize head-of-line — the root cause of the simultaneous
// 15s HTTP timeouts under load.
//
// Fix: cache the mapped SessionRecord[] and serve it until the next write.
// Invalidation is a single hook in withWriteLock's finally (below) — EVERY
// mutation funnels through that lock, so we never enumerate writers. This is a
// cache of the LOCAL sqlite (in-process source of truth), NOT remote daemon
// state, so it does not reintroduce the "cache remote truth" anti-pattern;
// live PID/daemon liveness is computed OUTSIDE this cache by callers
// (enrichWithLiveStatus) and stays fresh. Env-gated for instant prod revert.
const STORE_CACHE_ENABLED = process.env.WALNUT_STORE_CACHE !== '0';
let sessionStoreCache: SessionRecord[] | null = null;
let sessionStoreCacheDataVersion: number | null = null;

/** Drop the cached whole-store snapshot. Called from withWriteLock.finally. */
function invalidateSessionStoreCache(): void {
  sessionStoreCache = null;
  sessionStoreCacheDataVersion = null;
}

/** Reset module-level state for test isolation. */
export function _resetSessionTrackerForTesting(): void {
  sessionInitialized = false;
  sessionStoreCache = null;
  sessionStoreCacheDataVersion = null;
}

const MAX_STATUS_HISTORY = 10;

type SessionRecordUpdates = Partial<
  Omit<SessionRecord, 'claudeSessionId' | 'statusRevision' | 'statusUpdatedAt'>
>;

type CanonicalStatusProjection = Omit<
  SessionStatusSnapshot,
  'sessionId' | 'statusRevision' | 'statusUpdatedAt'
>;

function searchContentProjection(record: SessionRecord): string {
  // Keep this list aligned with the session serializer in
  // src/core/search/serializers.ts. Status, activity, PID, usage, and transport
  // fields deliberately do not reindex.
  return JSON.stringify([
    record.title,
    record.description,
    record.summary,
    record.planContent,
    record.project,
    record.cwd,
    record.host,
    record.taskId,
    record.outputFile,
  ]);
}

function canonicalStatusProjection(
  record: Pick<
    SessionRecord,
    | 'process_status'
    | 'activity'
    | 'mode'
    | 'planCompleted'
    | 'archived'
    | 'errorMessage'
    | 'provider'
    | 'engine'
    | 'taskId'
    | 'pendingPermission'
  >,
): CanonicalStatusProjection {
  return {
    process_status: record.process_status ?? 'stopped',
    activity: record.activity ?? null,
    mode: record.mode ?? 'default',
    planCompleted: record.planCompleted ?? false,
    archived: record.archived ?? false,
    errorMessage: record.errorMessage ?? null,
    // Rides every status snapshot so LIST surfaces (task pills, iOS) can show
    // the red Waiting state — previously only the session panel saw it.
    pendingPermissionTool: record.pendingPermission
      ? (record.pendingPermission.toolName ?? 'unknown') : null,
    provider: record.provider ?? 'cli',
    engine: resolveEngine(record.engine),
    taskId: record.taskId || null,
  };
}

function normalizedStatusRevision(record: Pick<SessionRecord, 'statusRevision'>): number {
  return Number.isInteger(record.statusRevision) && record.statusRevision! > 0
    ? record.statusRevision!
    : 1;
}

function normalizedStatusUpdatedAt(
  record: Pick<
    SessionRecord,
    'statusUpdatedAt' | 'last_status_change' | 'lastActiveAt' | 'startedAt'
  >,
): string {
  return record.statusUpdatedAt
    || record.last_status_change
    || record.lastActiveAt
    || record.startedAt
    || new Date().toISOString();
}

function statusProjectionEquals(
  left: CanonicalStatusProjection,
  right: CanonicalStatusProjection,
): boolean {
  return left.process_status === right.process_status
    && left.activity === right.activity
    && left.mode === right.mode
    && left.planCompleted === right.planCompleted
    && left.archived === right.archived
    && left.errorMessage === right.errorMessage
    && left.provider === right.provider
    && left.engine === right.engine
    && left.taskId === right.taskId
    // A pendingPermission set/clear must bump statusRevision — it is what
    // flips the list pills red; without this the revision stays flat and
    // versioned consumers drop the change as a duplicate.
    && left.pendingPermissionTool === right.pendingPermissionTool;
}

function initializeStatusVersion(record: SessionRecord, now?: string): void {
  record.statusRevision = normalizedStatusRevision(record);
  record.statusUpdatedAt = record.statusUpdatedAt
    || now
    || normalizedStatusUpdatedAt(record);
}

function withoutStatusVersionOverrides(
  updates: SessionRecordUpdates,
): SessionRecordUpdates {
  if (!('statusRevision' in updates) && !('statusUpdatedAt' in updates)) {
    return updates;
  }
  const sanitized = { ...updates } as Partial<SessionRecord>;
  delete sanitized.statusRevision;
  delete sanitized.statusUpdatedAt;
  return sanitized;
}

function commitStatusVersion(
  record: SessionRecord,
  before: CanonicalStatusProjection,
  now: string,
): void {
  const currentRevision = normalizedStatusRevision(record);
  if (statusProjectionEquals(before, canonicalStatusProjection(record))) {
    record.statusRevision = currentRevision;
    record.statusUpdatedAt = normalizedStatusUpdatedAt(record);
    return;
  }
  record.statusRevision = currentRevision + 1;
  record.statusUpdatedAt = now;
}

/** Convert a durable record into the complete public status contract. */
export function toSessionStatusSnapshot(record: SessionRecord): SessionStatusSnapshot {
  return {
    sessionId: record.claudeSessionId,
    ...canonicalStatusProjection(record),
    statusRevision: normalizedStatusRevision(record),
    statusUpdatedAt: normalizedStatusUpdatedAt(record),
  };
}

/**
 * Publish one complete committed snapshot while retaining additive legacy data.
 * Callers must pass the SessionRecord returned by the successful write.
 */
export function emitSessionStatusChanged(
  record: SessionRecord,
  legacyFields: Partial<SessionStatusChangedEvent> = {},
  _destinations: string[] = ['*'],
  options: EmitOptions = {},
): void {
  const status = toSessionStatusSnapshot(record);
  const data: SessionStatusChangedEvent = {
    ...legacyFields,
    ...(record.fromPlanSessionId
      ? { fromPlanSessionId: record.fromPlanSessionId }
      : {}),
    ...(record.forkedFromSessionId
      ? { forkedFromSessionId: record.forkedFromSessionId }
      : {}),
    ...status,
    status,
  };
  // Status is a global convergence signal consumed by the web UI, health
  // monitor, hooks, and projections. Keep routing centralized so a caller
  // cannot accidentally publish a revision to only one subscriber.
  bus.emit(EventNames.SESSION_STATUS_CHANGED, data, ['*'], options);
}

// ── Triage detection ──

/** Agent IDs that are high-volume triage housekeeping — hidden from session UI. */
export const TRIAGE_AGENTS = new Set(['turn-complete-triage', 'message-send-triage']);

/**
 * Known triage agent display names (the `name` field from AgentDefinition).
 * Embedded session titles use format "{agentDef.name}: {task.slice(0,80)}",
 * so we match the prefix before the first colon against these patterns.
 */
const TRIAGE_NAME_PATTERNS = new Set([
  'Turn Complete Triage (onTurnComplete)',
  'Message Send Triage (onMessageSend)',
  // Legacy names from earlier agent definitions
  'Session Triage',
  'Turn Complete Triage',
  'Message Send Triage',
]);

/**
 * Returns true if a session record represents a triage subagent run (auto-triggered,
 * high-frequency). These should be hidden from the user-facing session list.
 *
 * Uses the `type` field (set at creation or by migration). Falls back to title-prefix
 * heuristic only for records that haven't been through migration yet (shouldn't happen
 * in normal operation — migration runs on DB open).
 */
export function isTriageSession(s: SessionRecord): boolean {
  if (s.type) return s.type === 'triage';
  if (s.provider !== 'embedded') return false;
  const prefix = s.title?.split(':')[0]?.trim() ?? '';
  return TRIAGE_AGENTS.has(prefix) || TRIAGE_NAME_PATTERNS.has(prefix);
}

/**
 * Environment sessions: system-created background sessions that never occupy a
 * user session slot. Includes triage, hook, cron, and embedded subagent runs.
 * CLI/SDK subagent sessions (user-created) are NOT environment sessions.
 */
export function isEnvironmentSession(s: SessionRecord): boolean {
  if (s.type === 'triage' || s.type === 'hook' || s.type === 'cron') return true;
  if (s.type === 'subagent' && s.provider === 'embedded') return true;
  return isTriageSession(s); // legacy fallback for untyped records
}

/**
 * Lane sessions back a persistent UI conversation surface rather than being a
 * user-launched "session", so the default session lists hide them (a caller that
 * genuinely wants them opts in). Deliberately SEPARATE from
 * isEnvironmentSession: the retention reaper purges environment records after 30
 * days and a lane session must outlive that — that's why `lane` is its own
 * field instead of a SessionType value.
 */
export function isLaneSession(s: SessionRecord): boolean {
  return typeof s.lane === 'string' && s.lane.length > 0;
}

/** The default session-list visibility rule: neither an environment session nor
 *  a lane-bound one. One predicate so every surface filters identically. */
export function isListableSession(s: SessionRecord): boolean {
  return !isEnvironmentSession(s) && !isLaneSession(s);
}

/**
 * Read the whole session store. Served from an in-process cache that survives
 * until the next write (invalidated in withWriteLock.finally).
 *
 * Returns per-call ISOLATED shallow clones, never the canonical cached objects.
 * This is deliberate and systemic rather than per-caller: several readers either
 * sort the array in place (getRecentSessions) or mutate record fields in place
 * (the /api/sessions route's enrichWithLiveStatus flips process_status), and
 * handing out shared references would poison the cache for every later reader.
 * Cloning the whole table is ~0.5-1ms — it still skips the expensive part the
 * cache exists to avoid: the `SELECT *` + rowToSession per-row JSON.parse of
 * spill columns (~30-45ms). One clone site = zero per-caller mutation audits.
 *
 * ⚠️ DESIGN DEBT — `SELECT *` over the WHOLE table is itself the wrong shape.
 * It's a leftover from when this store was a sessions.json file (read whole
 * file → JSON.parse → filter in JS). After the SQLite migration the access
 * pattern was kept verbatim, so callers still pull all ~5000+ rows and filter
 * in JS — e.g. getActiveSessionsByHost() scans the full table to return the
 * ~4 'running' rows (99.9% of the work is thrown away). The CORRECT fix is to
 * push predicates into SQL with indexes (`WHERE process_status='running'`,
 * `WHERE task_id=?`, GROUP BY host) per call site instead of materializing the
 * whole table. This cache is a deliberate, low-risk STOPGAP: it kills the
 * acute pain (every concurrent request re-running the scan and head-of-line
 * blocking the event loop) without touching dozens of JS-filter call sites on
 * a live, multi-agent-edited server. The residual cold-miss cost (~45ms first
 * scan, ~189ms for tasks) is the unfixed root design showing through. Tracked
 * for a proper storage-access rewrite — see the approved SQLite-migration plan
 * in project memory (task_storage_root_cause_and_sqlite_plan).
 */
async function readStore(): Promise<{ sessions: SessionRecord[] }> {
  await ensureSessionInit();
  if (!STORE_CACHE_ENABLED) {
    const db = getDb();
    if (!db) {
      throw new Error('readStore: SQLite handle is null');
    }
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, any>[];
    return { sessions: rows.map(rowToSession) };
  }
  const db = getDb();
  if (!db) {
    throw new Error('readStore: SQLite handle is null');
  }
  const dataVersion = () =>
    db.pragma('data_version', { simple: true }) as number;
  const currentDataVersion = dataVersion();
  if (sessionStoreCache === null
    || sessionStoreCacheDataVersion !== currentDataVersion) {
    // An on-stop hook writes through a separate SQLite connection. Retry if
    // that external commit races this SELECT so the cached rows and version
    // always describe the same database state.
    let before = currentDataVersion;
    let rows: Record<string, any>[];
    let after: number;
    do {
      before = dataVersion();
      rows = db.prepare('SELECT * FROM sessions').all() as Record<string, any>[];
      after = dataVersion();
    } while (before !== after);
    sessionStoreCache = rows.map(rowToSession);
    sessionStoreCacheDataVersion = after;
  }
  return { sessions: sessionStoreCache.map((s) => ({ ...s })) };
}

// ── Write lock: serializes read-modify-write operations in-process ────────
// Prevents concurrent callers (session runner, health monitor, reconciler,
// hooks, REST) from overwriting each other's changes via stale snapshots.
// SQLite's own WAL + busy_timeout handles cross-process serialization.
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  // Invalidate the whole-store read cache after EVERY locked mutation. Every
  // writer (create/update/batch/conditional/rename/complete/delete/link)
  // funnels through this lock, so this single hook keeps the cache correct
  // without enumerating writers. Drop BEFORE releasing the lock so the next
  // reader rebuilds from fresh rows.
  return prev
    .then(fn)
    .finally(() => {
      invalidateSessionStoreCache();
      resolve!();
    });
}

/**
 * Returns true when every field in `updates` already equals the current value on `session`.
 * Scalars compared with ===; `status_history` compared by JSON (array). Unknown field
 * types fall back to JSON equality. Used by updateSessionRecord* to skip redundant writes.
 *
 * No-op guard. Originally added after a daemon/remote-session bug where the
 * CLI replayed identical init/model/pid updates ~9 times per resume. Each
 * replay took the in-process + cross-process lock, starving /api/sessions/:id
 * readers (60s+ timeouts observed). Skipping identical updates entirely cuts
 * this to zero churn on the happy path.
 */
function isNoOpUpdate(
  session: SessionRecord,
  updates: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
): boolean {
  for (const key of Object.keys(updates) as (keyof typeof updates)[]) {
    const next = updates[key];
    const curr = (session as unknown as Record<string, unknown>)[key as string];
    if (next === curr) continue;
    if (next == null && curr == null) continue;
    if (typeof next === 'object' || typeof curr === 'object') {
      if (JSON.stringify(next) !== JSON.stringify(curr)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * List all tracked sessions. readStore() already returns isolated shallow
 * clones, so callers may freely sort/mutate the result.
 */
export async function listSessions(): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions;
}

/**
 * Bounded, index-backed most-recent-first read (`sessions_updated_at` index on
 * last_active_at). For request-path callers that only need a recent candidate
 * window (e.g. the sessions `?q=` search on every debounced keystroke) — a
 * keystroke must never materialize the whole table (the browser-pool-saturation
 * class fixed in c0320af). Isolated rows (rowToSession builds fresh objects).
 */
export async function listRecentSessionRecords(limit: number): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const bounded = Math.max(1, Math.min(Math.floor(limit), 10_000));
  const rows = db.prepare(
    'SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?',
  ).all(bounded) as Record<string, any>[];
  return rows.map(rowToSession);
}

export interface SessionQueryOptions {
  query?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface SessionQueryResult {
  sessions: SessionRecord[];
  total: number;
  limit: number;
  hasMore: boolean;
}

const DEFAULT_SESSION_QUERY_LIMIT = 100;
const MAX_SESSION_QUERY_LIMIT = 500;

/**
 * Bounded recent-session query with full-store text matching. The result is
 * always newest-first except that an exact session ID is deterministically
 * rank 1, including when it falls outside the recent prefix.
 */
export async function querySessions(options: SessionQueryOptions = {}): Promise<SessionQueryResult> {
  const store = await readStore();
  const limit = Math.max(1, Math.min(
    Number.isFinite(options.limit) ? Math.floor(options.limit!) : DEFAULT_SESSION_QUERY_LIMIT,
    MAX_SESSION_QUERY_LIMIT,
  ));
  const query = options.query?.trim().toLowerCase() ?? '';
  const matching = store.sessions.filter((session) => {
    if (!options.includeArchived && session.archived) return false;
    if (!query) return true;
    return [
      session.claudeSessionId,
      session.acpRuntimeId,
      session.taskId,
      session.project,
      session.title,
      session.description,
      session.summary,
      session.recap,
    ].some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
  });
  matching.sort((a, b) => {
    const aExact = query && a.claudeSessionId.toLowerCase() === query ? 1 : 0;
    const bExact = query && b.claudeSessionId.toLowerCase() === query ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const active = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
    return active || a.claudeSessionId.localeCompare(b.claudeSessionId);
  });
  return {
    sessions: matching.slice(0, limit),
    total: matching.length,
    limit,
    hasMore: matching.length > limit,
  };
}

/** A session is terminal if process_status is 'error' OR the task's phase is 'COMPLETE'. */
export function isTerminalSession(s: { process_status?: string }, taskPhase?: TaskPhase): boolean {
  return s.process_status === 'error' || taskPhase === 'COMPLETE';
}

/**
 * List sessions that are not in a terminal state (for health monitor).
 */
export async function listNonTerminalSessions(): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions.filter(
    (s) => !isTerminalSession(s) && !s.archived,
  );
}

/** Default session limits: local=7, any remote host=20. */
const DEFAULT_LOCAL_LIMIT = 7;
const DEFAULT_REMOTE_LIMIT = 20;

/** Default idle session limits per host (Layer 2). */
const DEFAULT_LOCAL_IDLE_LIMIT = 30;
const DEFAULT_REMOTE_IDLE_LIMIT = 40;

/**
 * Get actively-processing sessions grouped by host.
 * Only counts sessions with process_status='running' (actively processing a turn).
 * Idle sessions (turn complete, waiting for input) are NOT included.
 * These are the sessions actually consuming API/compute resources.
 *
 * Side-effect: any stale records (process alive in DB but PID dead)
 * are asynchronously corrected to prevent future ghost-slot accumulation.
 */
export async function getActiveSessionsByHost(): Promise<Record<string, SessionRecord[]>> {
  // ⚠️ DESIGN DEBT (see readStore): this materializes ALL ~5000+ rows then keeps
  // only the ~4 'running' ones — 99.9% wasted. Correct shape is
  // `SELECT * FROM sessions WHERE process_status='running'` (indexed) + a
  // narrowed liveness check. Left as a full scan for now; the readStore cache
  // makes the repetition cheap but not free.
  const store = await readStore();
  const result: Record<string, SessionRecord[]> = {};
  const staleIds: string[] = [];
  for (const s of store.sessions) {
    if (s.archived) continue;
    if (s.process_status !== 'running') continue;
    // Embedded/SDK sessions have no OS process — don't count toward host limits
    if (s.provider === 'embedded' || s.provider === 'sdk') continue;
    // Side threads are hidden asides of another session: they must not occupy a
    // capacity slot, and they must not be the reason a host is kept awake.
    // Prefix literal = SIDE_LANE_PREFIX (side-thread-fork.ts, which imports
    // this module — importing back would be circular).
    if (s.lane?.startsWith('side:')) continue;
    if (!await isSessionProcessAlive(s)) {
      staleIds.push(s.claudeSessionId);
      continue;
    }
    const key = s.host || 'local';
    (result[key] ??= []).push(s);
  }
  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }
  return result;
}

/**
 * Get all alive sessions grouped by host (both running and idle).
 * Includes idle sessions (turn complete, waiting for input).
 * Used for idle limit enforcement and diagnostics.
 *
 * Side-effect: any stale records (process alive in DB but PID dead)
 * are asynchronously corrected.
 */
export async function getAllAliveSessionsByHost(): Promise<Record<string, SessionRecord[]>> {
  const store = await readStore();
  const result: Record<string, SessionRecord[]> = {};
  const staleIds: string[] = [];
  for (const s of store.sessions) {
    if (s.archived) continue;
    if (s.process_status === 'stopped' || s.process_status === 'error') continue;
    // Embedded/SDK sessions have no OS process — don't count toward host limits
    if (s.provider === 'embedded' || s.provider === 'sdk') continue;
    if (!await isSessionProcessAlive(s)) {
      staleIds.push(s.claudeSessionId);
      continue;
    }
    const key = s.host || 'local';
    (result[key] ??= []).push(s);
  }
  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }
  return result;
}

/**
 * Asynchronously correct stale session records whose process has exited
 * but process_status is still 'running'. Fire-and-forget — callers
 * don't need to wait for this; the returned results already exclude
 * these sessions.
 */
function fixStaleRecords(sessionIds: string[]): void {
  log.session.warn('fixing stale records', { count: sessionIds.length, ids: sessionIds });
  const now = new Date().toISOString();
  for (const id of sessionIds) {
    updateSessionRecord(id, {
      process_status: 'stopped',
      last_status_change: now,
      status_reason: 'liveness_check_failed',
      status_changed_by: 'system',
    } as any).catch((err) => {
      log.session.warn('failed to fix stale record', { sessionId: id, error: String(err) });
    });
  }
}

export interface SessionLimitResult {
  allowed: boolean;
  /** Current active (running) count for this host */
  running: number;
  /** Configured active limit for this host */
  limit: number;
  /** The active sessions on this host (for diagnostics) */
  runningSessions: SessionRecord[];
  /** Total alive processes on this host (running + idle) */
  totalAlive?: number;
  /** Current idle count for this host */
  idleCount?: number;
  /** Configured idle limit for this host */
  maxIdle?: number;
  /** Sessions that were auto-evicted to stay under the idle limit */
  evicted?: SessionRecord[];
}

/**
 * Check whether a new session can be started on the given host.
 *
 * Two-tier limit:
 *   1. Processing limit (per-host, default local=7): only running sessions count.
 *      Idle sessions do NOT block new work.
 *   2. Idle limit (per-host, default local=30, remote=40): cap on idle processes.
 *      When exceeded, the oldest idle session is gracefully stopped (SIGINT)
 *      to make room. Does NOT block new sessions.
 *
 * @param host — host alias from config.hosts, or undefined/null for local.
 * @param sessionLimits — the config.session_limits object (may be undefined).
 * @param sessionConfig — the config.session object (may be undefined).
 */
export async function checkSessionLimit(
  host: string | undefined | null,
  sessionLimits?: Record<string, number>,
  sessionConfig?: { idle_timeout_minutes?: number; max_idle?: number },
): Promise<SessionLimitResult> {
  const key = host || 'local';
  const rawLimit = sessionLimits?.[key]
    ?? (key === 'local' ? DEFAULT_LOCAL_LIMIT : DEFAULT_REMOTE_LIMIT);
  const limit = Math.max(1, rawLimit); // Floor at 1 to prevent zero/negative blocking all sessions

  // Idle limit: from config.session.max_idle, or per-host defaults
  const maxIdle = sessionConfig?.max_idle
    ?? (key === 'local' ? DEFAULT_LOCAL_IDLE_LIMIT : DEFAULT_REMOTE_IDLE_LIMIT);

  // Single store read — avoids double-read race and double PID-liveness scan.
  const store = await readStore();
  const runningSessions: SessionRecord[] = [];
  const idleSessions: SessionRecord[] = [];
  const staleIds: string[] = [];

  for (const s of store.sessions) {
    if (s.archived) continue;
    if (s.process_status === 'stopped') continue;
    if (s.process_status === 'error') continue;
    // Embedded/SDK sessions have no OS process — don't count toward host limits
    if (s.provider === 'embedded' || s.provider === 'sdk') continue;
    if (!await isSessionProcessAlive(s)) {
      staleIds.push(s.claudeSessionId);
      continue;
    }
    // Lane sessions back a persistent UI surface (a conversation lane), not a
    // user-launched unit of work: they never occupy a capacity slot and are never
    // a CAPACITY-eviction victim here. (The health monitor's idle TIMEOUT still
    // reaps an idle lane CLI by design — the record survives and the next message
    // cold-resumes it with its profile re-applied.) Placed AFTER the liveness
    // check so a dead lane CLI still gets its record repaired by fixStaleRecords.
    if (s.lane) continue;
    const sKey = s.host || 'local';
    if (sKey !== key) continue;
    if (s.process_status === 'running') {
      runningSessions.push(s);
    } else if (s.process_status === 'idle') {
      idleSessions.push(s);
    }
  }

  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }

  // Tier 2: idle limit — auto-evict oldest idle CLI sessions if exceeded
  const evicted: SessionRecord[] = [];

  if (maxIdle > 0 && idleSessions.length >= maxIdle) {
    // Only evict CLI sessions (they have PIDs we can SIGINT).
    // SDK/embedded sessions have no PID — evicting them has no effect on actual resources.
    const evictable = idleSessions
      .filter(s => s.provider !== 'sdk' && s.provider !== 'embedded')
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt));

    const needToEvict = idleSessions.length - maxIdle + 1; // +1 to make room for one more
    for (let i = 0; i < needToEvict && i < evictable.length; i++) {
      const victim = evictable[i];
      log.session.warn('evicting idle session for capacity', { sessionId: victim.claudeSessionId, pid: victim.pid });
      if (victim.pid != null) {
        // Mark first — an unmarked kill surfaces as a spurious "init failed" error toast.
        try {
          const { sessionRunner } = await import('../providers/claude-code-session.js');
          sessionRunner.markExpectedTeardown(victim.claudeSessionId, 'capacity_eviction');
        } catch { /* runner unavailable — the kill is still correct */ }
        try { process.kill(victim.pid, 'SIGINT') } catch (err) { log.session.warn('SIGINT failed during eviction', { pid: victim.pid, error: String(err) }); }
      }
      await updateSessionRecord(victim.claudeSessionId, {
        process_status: 'stopped',
        activity: undefined,
        last_status_change: new Date().toISOString(),
        status_reason: 'idle_eviction',
        status_changed_by: 'system',
      } as any);
      evicted.push(victim);
    }
  }

  const allowed = runningSessions.length < limit;
  const totalAlive = runningSessions.length + idleSessions.length - evicted.length;
  log.session.info('session limit check', { host: key, running: runningSessions.length, limit, idle: idleSessions.length, maxIdle, allowed, totalAlive });

  return {
    allowed,
    running: runningSessions.length,
    limit,
    runningSessions,
    totalAlive,
    idleCount: idleSessions.length - evicted.length,
    maxIdle,
    evicted: evicted.length > 0 ? evicted : undefined,
  };
}

/**
 * Get a single session by Claude session ID.
 */
export async function getSessionByClaudeId(claudeSessionId: string): Promise<SessionRecord | null> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
    | Record<string, any>
    | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * Every tracked session id, as a Set. Deliberately id-ONLY (not rowToSession):
 * the external-session importer needs "does Walnut already know this id?" for
 * thousands of host transcripts, and the answer must not cost a whole-table
 * materialization. One indexed column scan, no payload JSON.parse.
 */
export async function listAllSessionIds(): Promise<Set<string>> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return new Set();
  const rows = db.prepare('SELECT claude_session_id FROM sessions').all() as
    Array<{ claude_session_id: string }>;
  return new Set(rows.map((r) => r.claude_session_id));
}

/**
 * The session bound to `lane`, or null. Newest-first so a lane that somehow holds
 * two records (a crash between mint and spawn) resolves to the live one rather
 * than a stale corpse.
 *
 * `lane` has no dedicated column — it spills into `payload` (see session-db.ts
 * FIELD_TO_COLUMN) — so this queries with `json_extract`. `json_valid` guard is
 * load-bearing: SQLite RAISES on malformed JSON rather than returning NULL, so a
 * single corrupt payload row would make every lane lookup throw (i.e. the Personal AI
 * could never find its own lane). Rows with NULL/empty payload can't match a
 * lane, so skipping them is free.
 */
export async function getSessionByLane(lane: string): Promise<SessionRecord | null> {
  if (!lane) return null;
  await ensureSessionInit();
  const db = getDb();
  if (!db) return null;
  // Archived rows are excluded: when a lane session dies unresumably its record
  // gets auto-archived (conversationLost), and matching it here would pin the
  // conversation to a permanently-dead session — skipping it lets the lane mint
  // a fresh one instead. started_at DESC (not last_active_at) so a corpse that
  // background writers keep touching can't out-rank a genuinely newer session.
  const row = db.prepare(`
    SELECT * FROM sessions
    WHERE payload IS NOT NULL AND payload != '' AND json_valid(payload)
      AND json_extract(payload, '$.lane') = ?
      AND (archived IS NULL OR archived = 0)
    ORDER BY started_at DESC
    LIMIT 1
  `).get(lane) as Record<string, any> | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * Minimum prefix length accepted by {@link resolveSessionByIdOrPrefix}. 8 hex
 * chars (32 bits) is what the UI renders in its session-id chips and in
 * "Session <id> finished" notifications, so it is the shortest string a user can
 * plausibly have in hand. Shorter is refused rather than guessed at.
 */
export const SESSION_ID_MIN_PREFIX = 8;

export type SessionIdResolution =
  | { status: 'found'; session: SessionRecord; resolvedByPrefix: boolean }
  | { status: 'not-found' }
  | { status: 'ambiguous' };

/**
 * Resolve a session by exact id, or by a unique id PREFIX.
 *
 * Why prefixes are accepted at all: the UI displays only the first 8 chars of a
 * session id (chips, notification titles), so that truncated string inevitably
 * ends up in URLs and deep links — and an exact-match-only lookup answers 404
 * for an id the app itself put on screen. Same contract as a short git SHA:
 * unique prefix resolves, ambiguous prefix is an error rather than a guess.
 *
 * Callers MUST use `session.claudeSessionId` (the canonical id) for any
 * follow-up lookup — live-session maps are keyed by the full id, so passing the
 * prefix through would miss.
 */
export async function resolveSessionByIdOrPrefix(idOrPrefix: string): Promise<SessionIdResolution> {
  const exact = await getSessionByClaudeId(idOrPrefix);
  if (exact) return { status: 'found', session: exact, resolvedByPrefix: false };

  // Only hex + dashes, at least SESSION_ID_MIN_PREFIX chars, and shorter than a
  // full id (a full-length miss is a genuine 404, not a prefix). The charset
  // check also keeps LIKE wildcards ('%', '_') out of the pattern.
  const looksLikePrefix =
    idOrPrefix.length >= SESSION_ID_MIN_PREFIX &&
    idOrPrefix.length < 36 &&
    /^[0-9a-f-]+$/i.test(idOrPrefix);
  if (!looksLikePrefix) return { status: 'not-found' };

  const db = getDb();
  if (!db) return { status: 'not-found' };
  // LIMIT 2 — we only need to know "exactly one" vs "more than one".
  const rows = db.prepare(
    'SELECT * FROM sessions WHERE claude_session_id LIKE ? ESCAPE \'\\\' LIMIT 2',
  ).all(`${idOrPrefix}%`) as Array<Record<string, any>>;

  if (rows.length === 0) return { status: 'not-found' };
  if (rows.length > 1) return { status: 'ambiguous' };
  return { status: 'found', session: rowToSession(rows[0]), resolvedByPrefix: true };
}

/** Bounded callers can hydrate full status snapshots without loading history rows. */
export async function getSessionStatusSnapshots(
  providerSessionIds: string[],
): Promise<Record<string, SessionStatusSnapshot>> {
  if (providerSessionIds.length === 0) return {};
  await ensureSessionInit();
  const db = getDb();
  if (!db) return {};
  const ids = [...new Set(providerSessionIds)];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE claude_session_id IN (${placeholders})
  `).all(...ids) as Record<string, any>[];
  const byId = new Map(
    rows.map((row) => {
      const record = rowToSession(row);
      return [record.claudeSessionId, toSessionStatusSnapshot(record)] as const;
    }),
  );
  const statuses = Object.create(null) as Record<string, SessionStatusSnapshot>;
  for (const id of ids) {
    const status = byId.get(id);
    if (status) statuses[id] = status;
  }
  return statuses;
}

/**
 * Get all sessions linked to a task.
 */
export async function getSessionsForTask(taskId: string): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM sessions WHERE task_id = ?').all(taskId) as Record<string, any>[];
  return rows.map(rowToSession);
}

// ── Health-scan active-set queries (I1: periodic work = O(active), never O(history)) ──
// The health monitor used to consume listSessions() (whole table, ~6000 rows) every
// 30s tick; 99%+ of that was terminal records that can never change state on their
// own. These queries push the predicate into SQL so the tick's working set is the
// handful of rows that actually need watching. Predicate rationale:
//   - running/idle: ALWAYS included, no age window — a wedged record from weeks ago
//     is exactly what the reconcile safety net exists for.
//   - stopped/error within the recency window: needed by connection-lost recovery
//     and the orphan sweeps; a real orphan only appears near its death window.
const HEALTH_SCAN_RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * Active session set for the health monitor's periodic tick.
 * Isolated rows (rowToSession builds fresh objects) — safe to mutate.
 */
export async function listSessionsForHealthScan(): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const cutoff = new Date(Date.now() - HEALTH_SCAN_RECENT_MS).toISOString();
  // archived IS NOT 1 (not `= 0`): rows created before the archived column
  // default — or via sessionToRow, which skips undefined fields — hold NULL.
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE archived IS NOT 1 AND (
      process_status IN ('running', 'idle')
      OR (process_status IN ('stopped', 'error') AND last_status_change >= ?)
    )
  `).all(cutoff) as Record<string, any>[];
  return rows.map(rowToSession);
}

/**
 * One-shot startup heal (incident a172ce49): clear pendingPermission left on
 * TERMINAL records. A permission request dies with its CLI process — the CLI
 * withdraws it (control_cancel_request) or it simply can't be answered once the
 * process is gone — but before the cancel handler existed nothing ever cleared
 * the persisted copy, so dead sessions kept a permanent amber "Waiting" badge
 * and an unanswerable card (28 such rows accumulated since June). Live
 * (running/idle) records are NOT touched here: their truth is the daemon's
 * pendingCtrl, reconciled on attach. Uses json_extract on the payload column
 * (pendingPermission lives in payload, not its own column).
 */
export async function healStalePendingPermissions(): Promise<number> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return 0;
  // remote_unreachable carve-out: that "error" is connectivity loss, not death —
  // the remote CLI may be alive and genuinely waiting on this prompt. Same
  // exception as the terminal-transition clear in applyUpdateToSession.
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE process_status IN ('stopped', 'error')
      AND COALESCE(status_reason, '') != 'remote_unreachable'
      AND payload IS NOT NULL
      AND json_extract(payload, '$.pendingPermission') IS NOT NULL
  `).all() as Record<string, any>[];
  let healed = 0;
  for (const row of rows) {
    const record = rowToSession(row);
    const requestId = record.pendingPermission?.requestId;
    try {
      await updateSessionRecord(record.claudeSessionId, { pendingPermission: undefined });
      // Expire the notification half too. NO bus emit at boot: this runs before
      // any browser has connected (and a reload fetches GET /api/notifications
      // anyway), so an event would fan out to zero subscribers. The startup
      // reconcile in server.ts covers the inverse case — a notification whose
      // record was ALREADY healed by an earlier boot.
      expirePermissionNotificationOnDeath(
        record.claudeSessionId, record.taskId, requestId, { emitBusEvent: false },
      );
      healed++;
      log.session.info('healed stale pendingPermission on terminal session', {
        sessionId: record.claudeSessionId,
        requestId: record.pendingPermission?.requestId,
        toolName: record.pendingPermission?.toolName,
        process_status: record.process_status,
        receivedAt: record.pendingPermission?.receivedAt,
      });
    } catch (err) {
      log.session.warn('failed to heal stale pendingPermission', {
        sessionId: record.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return healed;
}

/**
 * Terminal-but-with-pid records — candidates for the orphan process sweep.
 * Only recent ones: a genuinely leaked process is discovered within its death
 * window; anything older either was already handled or its PID was recycled.
 */
export async function listOrphanCandidates(): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const cutoff = new Date(Date.now() - HEALTH_SCAN_RECENT_MS).toISOString();
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE pid IS NOT NULL
      AND process_status IN ('stopped', 'error')
      AND last_status_change >= ?
  `).all(cutoff) as Record<string, any>[];
  return rows.map(rowToSession);
}

/**
 * Create a new session record.
 */
export async function createSessionRecord(
  claudeSessionId: string,
  taskId: string,
  project: string,
  cwd?: string,
  extra?: {
    pid?: number;
    outputFile?: string;
    title?: string;
    description?: string;
    mode?: SessionMode;
    planFile?: string;
    planCompleted?: boolean;
    host?: string;
    provider?: import('./types.js').SessionProvider;
    type?: SessionType;
    fromPlanSessionId?: string;
    forkedFromSessionId?: string;
    /** Rewind bookkeeping: the parent message uuid this session resumed at. */
    rewoundAtMessageUuid?: string;
    cliModel?: string;
    effort?: import('./types.js').SessionEffort;
    /** Launch-config bundle re-applied on every cold resume (see SessionProfile). */
    profile?: import('./types.js').SessionProfile;
    /** Marks the session as lane-bound: skipped by capacity + default lists. */
    lane?: string;
    /** Spawn-time `--append-system-prompt` ('' = launched without one). Seeded
     *  on creation only; later changes go through updateSessionRecord. */
    appliedAppendSystemPrompt?: string;
    initialProcessStatus?: SessionRecord['process_status'];
    /** Why the row starts in `initialProcessStatus` (e.g. 'awaiting_spawn' for a
     *  record seeded before its CLI process exists). */
    initialStatusReason?: import('./types.js').StatusReason;
    messageCount?: number;
    engine?: import('./types.js').SessionEngine;
    acpRuntimeId?: string;
    acpJournalPath?: string;
    acpCapabilities?: AcpSessionCapabilities;
  },
): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('createSessionRecord: SQLite handle is null');
    }
    return sessionDbTx((handle) => {
      const now = new Date().toISOString();
      const row = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
        | Record<string, any>
        | undefined;

      if (row) {
        const existing = rowToSession(row);
        initializeStatusVersion(existing);
        const beforeStatus = canonicalStatusProjection(existing);
        // Detect whether anything material would actually change. Remote daemon replays
        // and resume paths can re-invoke persistSessionRecord() 9× with identical values;
        // skipping the write avoids starving readers on the write lock.
        let materialChange = false;
        if (cwd && existing.cwd !== cwd) materialChange = true;
        if (extra?.pid != null && existing.pid !== extra.pid) materialChange = true;
        if (extra?.outputFile && existing.outputFile !== extra.outputFile) materialChange = true;
        if (extra?.mode && existing.mode !== extra.mode) materialChange = true;
        if (extra?.planFile && existing.planFile !== extra.planFile) materialChange = true;
        if (extra?.planCompleted != null && existing.planCompleted !== extra.planCompleted) materialChange = true;
        if (extra?.host && existing.host !== extra.host) materialChange = true;
        if (extra?.fromPlanSessionId && existing.fromPlanSessionId !== extra.fromPlanSessionId) materialChange = true;
        if (extra?.forkedFromSessionId && existing.forkedFromSessionId !== extra.forkedFromSessionId) materialChange = true;
        if (extra?.cliModel && existing.cliModel !== extra.cliModel) materialChange = true;
        if (extra?.effort && existing.effort !== extra.effort) materialChange = true;
        // Lane: NEVER written from this path. The runner echoes its spawn-time
        // _lane through here on EVERY turn result, which is stale the moment a
        // side-thread standby is consumed (lane rename) or a thread is promoted
        // (lane cleared) — and "fill if missing" would resurrect a promoted
        // session's cleared lane. Every lane record is seeded with its lane at
        // creation; changes go through updateSessionRecord + sessionRunner.syncLane.
        // Profile: the RECORD is the source of truth for spawn-time config (the
        // resume path rebuilds args from record.profile). The runner echoes its
        // in-memory _profile through here at result time, which is stale the
        // moment personal-ai-lane's drift repair refreshes the record — so an
        // existing profile is write-once from this path: only fill a missing
        // one; changes go through updateSessionRecord.
        if (extra?.profile && existing.profile === undefined) materialChange = true;

        if (!materialChange) {
          return existing;
        }

        existing.lastActiveAt = now;
        existing.messageCount++;
        if (cwd) existing.cwd = cwd;
        if (extra?.pid != null) {
          // persistSessionRecord is called from the result handler to persist metadata
          // (title, mode, cliModel) that only becomes available at result time, not at spawn.
          // Only reset status when the PID actually CHANGES (new process started).
          // persistSessionRecord() is called from both the transport callback (new PID)
          // AND the result handler (same PID). Without this guard, the result handler's
          // call races with the session-runner's updateSessionRecord('agent_complete'),
          // and the createSessionRecord overwrites agent_complete → in_progress.
          const pidChanged = extra.pid !== existing.pid;
          existing.pid = extra.pid;
          if (pidChanged) {
            if (existing.process_status !== 'running') {
              existing.process_status = 'running';
              existing.last_status_change = now;
            }
          }
        }
        if (extra?.outputFile) existing.outputFile = extra.outputFile;
        if (extra?.mode) existing.mode = extra.mode;
        if (extra?.planFile) existing.planFile = extra.planFile;
        if (extra?.planCompleted != null) existing.planCompleted = extra.planCompleted;
        if (extra?.host) existing.host = extra.host;
        if (extra?.fromPlanSessionId) existing.fromPlanSessionId = extra.fromPlanSessionId;
        if (extra?.forkedFromSessionId) existing.forkedFromSessionId = extra.forkedFromSessionId;
        if (extra?.cliModel) existing.cliModel = extra.cliModel;
        if (extra?.effort) existing.effort = extra.effort;
        // Write-once (see materialChange above): never clobber a record profile
        // with the runner's stale in-memory copy.
        if (extra?.profile && existing.profile === undefined) existing.profile = extra.profile;

        commitStatusVersion(existing, beforeStatus, now);
        writeSessionRowSqlite(handle, existing);
        return existing;
      }

      const record: SessionRecord = {
        claudeSessionId,
        taskId,
        project,
        // init-only spawns pass 'idle': the CLI initialized then parked on its
        // FIFO — no turn is running, and defaulting to 'running' left a
        // permanent Running badge until the first real turn ended.
        process_status: extra?.initialProcessStatus ?? 'running',
        mode: extra?.mode ?? 'default',
        ...(extra?.initialStatusReason ? { status_reason: extra.initialStatusReason } : {}),
        last_status_change: now,
        startedAt: now,
        lastActiveAt: now,
        messageCount: extra?.messageCount ?? 1,
        ...(cwd ? { cwd } : {}),
        ...(extra?.pid != null ? { pid: extra.pid } : {}),
        ...(extra?.outputFile ? { outputFile: extra.outputFile } : {}),
        ...(extra?.title ? { title: extra.title } : {}),
        ...(extra?.description ? { description: extra.description } : {}),
        ...(extra?.planFile ? { planFile: extra.planFile } : {}),
        ...(extra?.planCompleted != null ? { planCompleted: extra.planCompleted } : {}),
        ...(extra?.host ? { host: extra.host } : {}),
        ...(extra?.provider ? { provider: extra.provider } : {}),
        type: extra?.type ?? 'interactive',
        ...(extra?.fromPlanSessionId ? { fromPlanSessionId: extra.fromPlanSessionId } : {}),
        ...(extra?.forkedFromSessionId ? { forkedFromSessionId: extra.forkedFromSessionId } : {}),
        ...(extra?.rewoundAtMessageUuid ? { rewoundAtMessageUuid: extra.rewoundAtMessageUuid } : {}),
        ...(extra?.cliModel ? { cliModel: extra.cliModel } : {}),
        ...(extra?.effort ? { effort: extra.effort } : {}),
        ...(extra?.profile ? { profile: extra.profile } : {}),
        ...(extra?.lane ? { lane: extra.lane } : {}),
        ...(extra?.appliedAppendSystemPrompt !== undefined
          ? { appliedAppendSystemPrompt: extra.appliedAppendSystemPrompt } : {}),
        ...(extra?.engine ? { engine: extra.engine } : {}),
        ...(extra?.acpRuntimeId ? { acpRuntimeId: extra.acpRuntimeId } : {}),
        ...(extra?.acpJournalPath ? { acpJournalPath: extra.acpJournalPath } : {}),
        ...(extra?.acpCapabilities ? { acpCapabilities: extra.acpCapabilities } : {}),
        statusRevision: 1,
        statusUpdatedAt: now,
      };

      writeSessionRowSqlite(handle, record);
      log.session.info('session record created', { sessionId: claudeSessionId, taskId, project, mode: extra?.mode, host: extra?.host });
      return record;
    });
  });
}

export interface AcpPromptAcceptanceResult {
  accepted: boolean;
  record: SessionRecord;
}

/**
 * Atomically commit one durable ACP prompt acceptance. Duplicate command IDs
 * are no-ops, so a lost ACK/retry cannot increment the user-turn count twice.
 */
export async function acceptAcpPrompt(
  claudeSessionId: string,
  commandId: string,
  options?: { preserveTerminalState?: boolean },
): Promise<AcpPromptAcceptanceResult> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) throw new Error('acceptAcpPrompt: SQLite handle is null');
    return sessionDbTx((handle) => {
      const row = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?')
        .get(claudeSessionId) as Record<string, any> | undefined;
      if (!row) throw new Error(`Session not found: ${claudeSessionId}`);
      const record = rowToSession(row);
      if (record.lastAcceptedAcpCommandId === commandId) {
        return { accepted: false, record };
      }

      const now = new Date().toISOString();
      applyUpdateToSession(record, {
        lastAcceptedAcpCommandId: commandId,
        messageCount: record.messageCount + 1,
        ...(options?.preserveTerminalState
          ? {}
          : {
              process_status: 'running' as const,
              activity: 'processing' as const,
              last_status_change: now,
              status_reason: 'message_sent',
              status_changed_by: 'session-runner',
              errorMessage: undefined,
            }),
      }, 'ACP prompt acceptance');
      writeSessionRowSqlite(handle, record);
      log.session.info('ACP prompt accepted', {
        sessionId: claudeSessionId,
        commandId,
        messageCount: record.messageCount,
      });
      return { accepted: true, record };
    });
  });
}

/**
 * Single-row INSERT OR REPLACE for a SessionRecord. Used by the SQLite fast
 * paths — mapping via sessionToRow, spill-field preservation, one transaction.
 */
function writeSessionRowSqlite(db: import('better-sqlite3').Database, session: SessionRecord): void {
  const insertCols = [...SESSION_COLUMNS, 'payload'];
  const insertSql =
    'INSERT OR REPLACE INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
    insertCols.map((c) => '@' + c).join(', ') + ')';
  const partial = sessionToRow(session);
  const bound: Record<string, unknown> = {};
  for (const col of insertCols) {
    bound[col] = partial[col] === undefined ? null : partial[col];
  }
  db.prepare(insertSql).run(bound);
}

/**
 * Import an external session record (e.g. a `claude -p` session started outside Walnut).
 * Created directly as stopped — no running process to track.
 * Throws if a record with the same Claude session ID already exists.
 */
export async function importSessionRecord(opts: {
  claudeSessionId: string;
  taskId: string;
  project: string;
  cwd?: string;
  host?: string;
  title?: string;
  startedAt?: string;
  lastActiveAt?: string;
  messageCount?: number;
  /** Which coding-agent CLI produced the transcript. Undefined = 'claude'.
   *  MUST be set at import time, not patched afterwards: updateSessionRecord
   *  bumps lastActiveAt on every write (correct for a live session), which
   *  would overwrite the imported history timestamp with "now" and make every
   *  imported session sort as if it were just active. */
  engine?: SessionRecord['engine'];
  provider?: SessionRecord['provider'];
  human_note?: string;
}): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('importSessionRecord: SQLite handle is null');
    }
    return sessionDbTx((handle) => {
      const now = new Date().toISOString();
      const record: SessionRecord = {
        claudeSessionId: opts.claudeSessionId,
        taskId: opts.taskId,
        project: opts.project,
        process_status: 'stopped',
        mode: 'default',
        last_status_change: now,
        startedAt: opts.startedAt ?? now,
        lastActiveAt: opts.lastActiveAt ?? now,
        messageCount: opts.messageCount ?? 0,
        type: 'interactive',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.engine ? { engine: opts.engine } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.human_note ? { human_note: opts.human_note } : {}),
        statusRevision: 1,
        statusUpdatedAt: now,
      };

      const row = handle.prepare('SELECT task_id FROM sessions WHERE claude_session_id = ?')
        .get(opts.claudeSessionId) as { task_id?: string } | undefined;
      if (row) {
        throw new Error(
          `Session ${opts.claudeSessionId} is already tracked (task: ${row.task_id ?? ''}). ` +
          `Use session_send to interact with it.`,
        );
      }
      writeSessionRowSqlite(handle, record);

      log.session.info('imported external session', {
        sessionId: opts.claudeSessionId,
        taskId: opts.taskId,
        project: opts.project,
        host: opts.host,
      });
      return record;
    });
  });
}

/**
 * Expire the FEED half of a permission the session record just lost.
 *
 * The record's pendingPermission and the notification (`perm:<requestId>`) are
 * two copies of the same question, and only the record's copy was ever cleared
 * on death — so the notification stayed `resolved: undefined`, which the panel
 * reads as still-pending: a permanent phantom in the Needs Action rail offering
 * Approve/Deny buttons that 404.
 *
 * Fire-and-forget on purpose: the caller is a SYNCHRONOUS in-transaction mutator
 * (applyUpdateToSession) and the session write must never wait on — or fail
 * because of — a notifications.json read-modify-write.
 *
 * Import-cycle safety: core/notifications/store.ts imports only constants,
 * utils/fs, and logging (all leaves) — it never reaches back into session code —
 * so a static import here would be acyclic. It stays dynamic anyway to keep the
 * store off the import path of every module that pulls in the tracker.
 */
function expirePermissionNotificationOnDeath(
  sessionId: string,
  taskId: string | undefined,
  requestId: string | undefined,
  options: { emitBusEvent?: boolean } = {},
): void {
  if (!requestId) return;
  import('./notifications/store.js')
    .then(({ resolvePermissionNotification }) => resolvePermissionNotification(requestId, 'expired'))
    .catch(err => log.session.warn('failed to expire permission notification', {
      sessionId, requestId, error: err instanceof Error ? err.message : String(err),
    }));
  if (options.emitBusEvent === false) return;
  // Settle any LIVE tab: the frontend's existing session:permission-resolved
  // handler dismisses the toast and stamps the feed entry, so a tab that is open
  // right now converges without a refresh. `allowed: false` keeps the event's
  // required field honest for old consumers; `expired: true` is what tells the
  // new ones this was nobody's decision.
  //
  // setImmediate, not a direct emit: the caller runs INSIDE the session
  // SQLite transaction, and bus.emit invokes every subscriber synchronously —
  // so a direct emit would let a subscriber observe (or read around) a session
  // row that hasn't committed yet.
  setImmediate(() => {
    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId,
      ...(taskId ? { taskId } : {}),
      requestId,
      allowed: false,
      expired: true,
    }, ['*'], { source: 'session-tracker' });
  });
}

/**
 * Expire the ERROR notifications a dead session can never recover.
 *
 * A session's error cards ('Session Error', 'Session Delivery Failed', plus
 * everything the session/obs subsystems log with a sessionId) carry recoveryKey
 * `session:<sid>` and are retired by that session's next clean result. Death
 * removes that possibility, so the card must be stamped instead of left looking
 * live — 'expired' (nothing can settle it) rather than 'recovered' (which would
 * claim the failure was fixed by a session dying).
 *
 * Fire-and-forget for the same reason as expirePermissionNotificationOnDeath: the
 * caller is a synchronous in-transaction mutator and the session write must never
 * wait on, or fail because of, a notifications.json read-modify-write. No bus
 * emit: unlike a pending permission there is no live interactive widget to settle,
 * and the panel picks the stamp up on its next fetch.
 *
 * Cost on the common path (a session that never errored) is ONE unlocked read of
 * notifications.json: expireErrorNotifications pre-checks for a matching record
 * before it takes the write lock, so a mass reap doesn't serialize dozens of
 * read-modify-write cycles behind each other to change nothing.
 */
function expireErrorNotificationsOnDeath(sessionId: string): void {
  import('./notifications/store.js')
    .then(({ expireErrorNotifications }) => expireErrorNotifications([`session:${sessionId}`]))
    .then(({ expired }) => {
      if (expired.length === 0) return;
      log.session.info('expired session error notifications on death', {
        sessionId, count: expired.length,
      });
    })
    .catch(err => log.session.warn('failed to expire session error notifications', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    }));
}

/**
 * Apply the patch to `session` in-place and produce the `lastActiveAt`-bumped
 * final state. Shared by updateSessionRecord + updateSessionRecordConditionally
 * so status_history ring-buffer + terminal PID clear + lastActiveAt bump behave
 * identically everywhere.
 *
 * Returns `false` when the patch is a no-op (caller should skip write entirely).
 */
function applyUpdateToSession(
  session: SessionRecord,
  updates: SessionRecordUpdates,
  logLabel: string,
): boolean {
  updates = withoutStatusVersionOverrides(updates);

  // ── C2 enforce-mode legacy-writer gate (contract §5) ──────────────────────
  // When the snapshot projection is the sole status writer for a session
  // (enforce mode + session snapshot-covered), stream-event-driven legacy
  // writers must not race it. TWO shapes are gated, with deliberately
  // different blast radius:
  //
  //  (a) category-① pairs (the table in session-snapshot-gate.ts) → the WHOLE
  //      patch is dropped. These writers exist ONLY to publish a status verdict
  //      (`{process_status, status_reason, status_changed_by, activity: undefined,
  //      last_status_change, consumedOffset?, pid: undefined?}`); stripping just
  //      the status trio used to let `pid: undefined` / `consumedOffset` /
  //      `activity` / `last_status_change` land, producing a half-applied state
  //      no writer ever intended (e.g. a PID cleared on a session the snapshot
  //      still reports running, or a turn-END watermark adopted with no
  //      matching status). All-or-nothing is the only coherent choice.
  //
  //  (b) UN-STAMPED status writes (neither changed_by nor reason) → strip ONLY
  //      the status fields, keep the rest. This shape is the session runner's
  //      stream projector (emitStatusChanged + the spawn/turn-start persists) —
  //      the highest-volume status writer in the system, and previously
  //      un-gateable because it carries no pair to match (C30). Its patches DO
  //      carry load-bearing non-status facts (pid, host, outputFile, mode,
  //      activity, planCompleted) that other subsystems depend on, so dropping
  //      the whole patch here would regress the orphan-dead-pool fix and live
  //      mode persistence.
  //
  // Category-② writers (user intent, spawn seeds, migrations) and any other
  // stamped-but-unlisted pair PASS THROUGH — contract §5's explicit tiebreak.
  if (
    updates.process_status !== undefined
    && getSnapshotStatusMode() === 'enforce'
    && isSnapshotCovered(session.claudeSessionId)
  ) {
    const changedBy = (updates as Record<string, unknown>).status_changed_by;
    const reason = (updates as Record<string, unknown>).status_reason;
    const gatedPair = isLegacyGatedStatusWrite(changedBy, reason);
    const unstamped = !gatedPair && isUnstampedStatusWrite(changedBy, reason);
    if (gatedPair || unstamped) {
      // Log churn control: a suppressed writer keeps refiring (the health
      // monitor retries every 30s for as long as the divergence lasts). Info on
      // the first suppression per sid, debug after that, always with the count.
      const count = noteSuppressedStatusWrite(session.claudeSessionId);
      const payload = {
        sessionId: session.claudeSessionId,
        suppressedStatus: updates.process_status,
        statusReason: reason ?? null,
        changedBy: changedBy ?? null,
        currentStatus: session.process_status,
        shape: gatedPair ? 'category-1-pair' : 'unstamped-runner-projection',
        suppressedCount: count,
      };
      if (count === 1) log.session.info('legacy status write suppressed', payload);
      else log.session.debug('legacy status write suppressed', payload);

      // The STATUS verdict is the projection's, but the dropped writer is often
      // the only one that knows WHY (health-monitor/remote_unreachable carries
      // the diagnosis; the snapshot carries none and declines to invent one).
      // Hand the explanation over so the projection can label its own 'error'
      // — without it the record lands `errorMessage: null`, which reads as
      // "unexplained user-visible error" and disqualifies the session from BOTH
      // recovery paths forever (2026-08-22, inc-1787439819342).
      // 'stopped' needs the same hand-off, and for the same reason. The idle
      // reaper writes ('health-monitor','idle_timeout') + "No output for N min",
      // which is category-① and therefore dropped WHOLE; the projection then
      // lands a cause-less stop. Stashing only on 'error' silently destroyed the
      // one sentence that made the calm "Auto-stopped after N min idle" banner
      // possible, so a routine 2h reclamation surfaced as a bare red row
      // (2026-09-03, a LOCAL session).
      if (updates.process_status === 'error' || updates.process_status === 'stopped') {
        noteSuppressedErrorReason(session.claudeSessionId, {
          reason: typeof reason === 'string' ? reason : 'unknown',
          message: typeof (updates as Record<string, unknown>).errorMessage === 'string'
            ? (updates as Record<string, unknown>).errorMessage as string
            : undefined,
          kind: classifyStatusReasonKind(reason),
          at: Date.now(),
        });
      }

      // (a) drop the entire patch — nothing in it was meant to apply alone.
      if (gatedPair) return false;

      // (b) strip the status labeling, let the transport facts through.
      updates = { ...updates } as Partial<SessionRecord>;
      delete (updates as Partial<SessionRecord>).process_status;
      delete (updates as Partial<SessionRecord>).status_reason;
      delete (updates as Partial<SessionRecord>).status_changed_by;
      delete (updates as Partial<SessionRecord>).errorMessage;
      if (Object.keys(updates).length === 0) return false;
    }
  }

  initializeStatusVersion(session);
  const beforeStatus = canonicalStatusProjection(session);
  // ── consumedOffset monotonic arbitration (single write choke point) ──
  // The watermark is a byte position in the session's append-only stream file:
  // it only ever moves forward. A stale writer (older event, concurrent
  // reconcile, replayed persistence) loses silently — the higher offset already
  // in place wins. Sentinels/garbage are rejected here so no caller can poison
  // the guard: a MAX_SAFE_INTEGER watermark would suppress every future result.
  // EXCEPTION: renameSessionId() does NOT go through here — it Object.assigns
  // its `updates` directly, bypassing this arbitration entirely. That's safe
  // TODAY only because its one caller always passes consumedOffset: undefined
  // (the rename-reset convention, not an enforced invariant) — see the comment
  // at the Object.assign call site in renameSessionId.
  if ('consumedOffset' in updates && updates.consumedOffset !== undefined) {
    const next = updates.consumedOffset;
    const invalid = typeof next !== 'number' || !Number.isInteger(next)
      || next < 0 || next >= Number.MAX_SAFE_INTEGER;
    // Monotonicity holds WITHIN one stream-file incarnation. A patch that also
    // changes `streamEpoch` is the sanctioned epoch-reset (the file was
    // recreated, offsets restarted at 0 — incident 019a7fe5): the regression
    // check must yield or the stale watermark from the dead file is permanent.
    // Validity still applies — an epoch change never excuses NaN/negative/
    // MAX_SAFE_INTEGER.
    const epochReset = typeof updates.streamEpoch === 'string'
      && updates.streamEpoch !== session.streamEpoch;
    const regression = typeof session.consumedOffset === 'number' && !invalid
      && !epochReset && next <= session.consumedOffset;
    if (epochReset && !invalid) {
      log.session.warn('consumedOffset epoch reset accepted', {
        sessionId: session.claudeSessionId,
        prevOffset: session.consumedOffset, nextOffset: next,
        prevEpoch: session.streamEpoch ?? null, nextEpoch: updates.streamEpoch,
      });
    }
    if (invalid || regression) {
      if (invalid) {
        log.session.warn('rejecting invalid consumedOffset write', {
          sessionId: session.claudeSessionId, attempted: String(next),
        });
      }
      updates = { ...updates };
      delete updates.consumedOffset;
      if (Object.keys(updates).length === 0) return false;
    }
  }

  if (isNoOpUpdate(session, updates)) return false;

  const prevStatus = session.process_status;
  const now = new Date().toISOString();
  Object.assign(session, updates);

  if (updates.process_status && updates.process_status !== prevStatus) {
    const transition: StatusTransition = {
      timestamp: now,
      process_status: updates.process_status as ProcessStatus,
      reason: (updates as any).status_reason ?? 'unknown',
      changed_by: (updates as any).status_changed_by ?? 'unknown',
      message: (updates as any).errorMessage ?? null,
    };
    session.status_history = [
      transition,
      ...(session.status_history ?? []),
    ].slice(0, MAX_STATUS_HISTORY);
  }

  // Terminal-state PID clear. Prevents stale PID orphan kills when OS recycles PIDs.
  if (isTerminalSession(session) && session.pid != null) {
    log.session.info(logLabel, {
      sessionId: session.claudeSessionId, pid: session.pid,
      process_status: session.process_status,
    });
    session.pid = undefined;
  }

  // Terminal-TRANSITION pendingPermission clear (incident d9df1a86, 2026-08-15).
  // Invariant: a permission prompt cannot outlive its CLI, and the CLI never
  // sends control_cancel_request when it dies — death IS the cancel. The
  // startup heal (healStalePendingPermissions) only covers records that were
  // ALREADY terminal at boot; a session dying MID-FLIGHT kept its prompt, and
  // the attach-time Layer-2 recovery then resurrected it from the record 2s
  // after death — a red "Waiting" pinned forever on a dead session.
  // Scoped to the status TRANSITION (not any write touching a terminal
  // record): the death event is the enforcement point. A prompt written to an
  // already-terminal record is left for the boot heal — making that state
  // unrepresentable here would turn the heal into untestable dead code while
  // external raw-SQL writers (markSessionStoppedInSqlite) can still create it.
  // EXCEPTION: 'remote_unreachable' is connectivity loss, not death — the CLI
  // is likely still alive and genuinely waiting; clearing would lose a real
  // question on every SSH flap (same liveness-unknown carve-out as the
  // reconciler's phase guard). The notification EXPIRY below inherits that
  // carve-out for free: it only runs where the clear runs, so an SSH flap
  // leaves both copies of the question intact.
  if (
    updates.process_status
    && updates.process_status !== prevStatus
    && isTerminalSession(session)
    && session.pendingPermission
    && session.status_reason !== 'remote_unreachable'
  ) {
    log.session.info('clearing pendingPermission on terminal transition', {
      sessionId: session.claudeSessionId,
      requestId: session.pendingPermission.requestId,
      toolName: session.pendingPermission.toolName,
      process_status: session.process_status,
      status_reason: session.status_reason ?? null,
    });
    const expiredRequestId = session.pendingPermission.requestId;
    session.pendingPermission = undefined;
    expirePermissionNotificationOnDeath(session.claudeSessionId, session.taskId, expiredRequestId);
  }

  // Terminal-transition ERROR-notification expiry — the same lesson one field
  // over. A session's error cards are keyed `session:<sid>` and recover on that
  // session's next clean result; death means that signal will never arrive, so
  // without this the card sits red in the Errors rail forever with nothing that
  // could ever retire it. Runs on the death EDGE only (not on every write to a
  // terminal record), and inherits the same 'remote_unreachable' carve-out as the
  // permission clear above: a dropped tunnel is not death, and the remote CLI may
  // still produce the clean result that legitimately recovers these.
  if (
    updates.process_status
    && updates.process_status !== prevStatus
    && isTerminalSession(session)
    && session.status_reason !== 'remote_unreachable'
  ) {
    expireErrorNotificationsOnDeath(session.claudeSessionId);
  }
  session.lastActiveAt = now;
  commitStatusVersion(session, beforeStatus, now);
  return true;
}

/**
 * Update an existing session's fields.
 */
export async function updateSessionRecord(
  claudeSessionId: string,
  updates: SessionRecordUpdates,
): Promise<SessionRecord> {
  await ensureSessionInit();
  let searchContentChanged = false;
  const updated = await withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('updateSessionRecord: SQLite handle is null');
    }

    return sessionDbTx((handle) => {
      const row = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
        | Record<string, any>
        | undefined;
      if (!row) {
        throw new Error(`Session not found: ${claudeSessionId}`);
      }
      const session = rowToSession(row);
      const searchContentBefore = searchContentProjection(session);

      // No-op guard BEFORE any UPDATE SQL — critical to avoid write-lock storms
      // when the daemon replays identical init/model/pid updates.
      if (!applyUpdateToSession(session, updates, 'clearing stale PID on terminal transition')) {
        return session;
      }

      writeSessionRowSqlite(handle, session);
      searchContentChanged =
        searchContentBefore !== searchContentProjection(session);
      log.session.info('session record updated', { sessionId: claudeSessionId, fields: Object.keys(updates) });
      return session;
    });
  });
  if (searchContentChanged) {
    bus.emit(
      EventNames.SESSION_CONTENT_UPDATED,
      { sessionId: claudeSessionId },
      ['*'],
      { source: 'session-tracker' },
    );
  }
  return updated;
}

/**
 * Apply the SAME `updates` patch to many sessions in ONE write-lock + ONE
 * SQLite transaction. This is the primitive that collapses the health monitor's
 * ~293 serial `updateSessionRecord` calls per 30s tick (each its own
 * BEGIN/COMMIT behind the in-process write lock — the confirmed event-loop
 * starvation source) into a single transaction.
 *
 * Per-row work reuses the exact same helpers as updateSessionRecord
 * (rowToSession → applyUpdateToSession no-op guard + status_history ring buffer
 * → sessionToRow), so behaviour is identical; only the lock/transaction
 * batching differs. Per-row errors and no-ops are caught and skipped INSIDE the
 * loop so one bad/missing row never rolls back the rest of the batch.
 *
 * Returns the claudeSessionIds that were actually written (no-ops/missing rows
 * are excluded).
 */
export async function batchUpdateSessionRecords(
  claudeSessionIds: string[],
  updates: SessionRecordUpdates,
): Promise<string[]> {
  if (claudeSessionIds.length === 0) return [];
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('batchUpdateSessionRecords: SQLite handle is null');
    }
    const selectStmt = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
    const insertCols = [...SESSION_COLUMNS, 'payload'];
    const insertSql =
      'INSERT OR REPLACE INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    const written: string[] = [];
    // Single transaction for the whole batch — one BEGIN/COMMIT instead of N.
    sessionDbTx((handle) => {
      const insertStmt = handle.prepare(insertSql);
      for (const id of claudeSessionIds) {
        try {
          const row = selectStmt.get(id) as Record<string, any> | undefined;
          if (!row) continue; // missing row — skip, don't abort the batch
          const session = rowToSession(row);
          // Reuse the shared no-op guard + status_history + terminal PID clear.
          if (!applyUpdateToSession(session, updates, 'clearing stale PID on batch terminal transition')) {
            continue; // no material change — skip write
          }
          const partial = sessionToRow(session);
          const bound: Record<string, unknown> = {};
          for (const col of insertCols) bound[col] = partial[col] === undefined ? null : partial[col];
          insertStmt.run(bound);
          written.push(id);
        } catch (err) {
          // One poisoned row must not roll back the other ~292.
          log.session.warn('batchUpdateSessionRecords: row failed (skipped)', {
            sessionId: id, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    if (written.length > 0) {
      log.session.info('session records batch-updated', { count: written.length, fields: Object.keys(updates) });
    }
    return written;
  });
}

/**
 * Conditionally update an existing session's fields.
 * Re-reads the record inside the write lock and calls `shouldUpdate(current)` before writing.
 * Returns the updated record, or null if the predicate returned false (update skipped).
 */
export async function updateSessionRecordConditionally(
  claudeSessionId: string,
  updates: SessionRecordUpdates,
  shouldUpdate: (current: SessionRecord) => boolean,
): Promise<SessionRecord | null> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('updateSessionRecordConditionally: SQLite handle is null');
    }

    return sessionDbTx((handle) => {
      const row = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
        | Record<string, any>
        | undefined;
      if (!row) return null;
      const session = rowToSession(row);

      if (!shouldUpdate(session)) return null;

      if (!applyUpdateToSession(session, updates, 'clearing stale PID on terminal transition (conditional)')) {
        return session;
      }
      writeSessionRowSqlite(handle, session);
      log.session.info('session record updated (conditional)', { sessionId: claudeSessionId, fields: Object.keys(updates) });
      return session;
    });
  });
}

/**
 * Rename a session's claudeSessionId — used when a --resume produces a different ID
 * than expected (resume failure). Updates the existing record in-place so history/UI
 * continuity is preserved. Returns the updated record, or null if not found.
 */
export async function renameSessionId(
  oldClaudeSessionId: string,
  newClaudeSessionId: string,
  updates?: SessionRecordUpdates,
): Promise<SessionRecord | null> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('renameSessionId: SQLite handle is null');
    }
    return sessionDbTx((handle) => {
      const oldRow = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(oldClaudeSessionId) as
        | Record<string, any> | undefined;
      if (!oldRow) return null;

      const conflict = handle.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?').get(newClaudeSessionId);
      if (conflict) {
        log.session.warn('renameSessionId: new ID already exists, skipping rename to avoid collision', {
          oldId: oldClaudeSessionId, newId: newClaudeSessionId,
        });
        return null;
      }

      const session = rowToSession(oldRow);
      initializeStatusVersion(session);
      const beforeStatus = canonicalStatusProjection(session);
      session.claudeSessionId = newClaudeSessionId;
      // NOTE: this bypasses the consumedOffset monotonic arbitration that
      // applyUpdateToSession() enforces (NaN/negative/regression/MAX_SAFE_INTEGER
      // rejection) — `updates` is applied directly via Object.assign, with no
      // sanitization at all. The ONLY safe value for `updates.consumedOffset`
      // here is `undefined` — the rename-reset semantic: a new claudeSessionId
      // means a new stream file with its own byte-offset coordinate space, so
      // there is no watermark to carry over. A future caller passing a concrete
      // number through here would skip every sanitization check and could
      // poison the watermark (e.g. wedge it at a stale or bogus offset that
      // silently suppresses real future convergence writes).
      if (updates) Object.assign(session, withoutStatusVersionOverrides(updates));
      const now = new Date().toISOString();
      session.lastActiveAt = now;
      commitStatusVersion(session, beforeStatus, now);

      // Delete old PK + insert under new PK in one transaction so a crash mid-rename
      // can't leave both rows orphaned. INSERT OR REPLACE with the new PK won't
      // clean up the old row on its own.
      handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?').run(oldClaudeSessionId);
      const insertCols = [...SESSION_COLUMNS, 'payload'];
      const insertSql =
        'INSERT OR REPLACE INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
        insertCols.map((c) => '@' + c).join(', ') + ')';
      const partial = sessionToRow(session);
      const bound: Record<string, unknown> = {};
      for (const col of insertCols) {
        bound[col] = partial[col] === undefined ? null : partial[col];
      }
      handle.prepare(insertSql).run(bound);
      log.session.info('session ID renamed', { oldId: oldClaudeSessionId, newId: newClaudeSessionId });
      // Durable audit (inc-2026-08-10): the old ID stops resolving from this
      // moment — any deep link / queued message still holding it will 404.
      // Runtime logs rotate; this file is the permanent record of the rename.
      import('./session-audit.js').then(({ auditSessionRecord }) => auditSessionRecord({
        op: 'rename',
        sessionId: oldClaudeSessionId,
        renamedTo: newClaudeSessionId,
        reason: 'resume-id-changed',
        record: {
          taskId: session.taskId,
          title: session.title,
          host: session.host,
          process_status: session.process_status,
          startedAt: session.startedAt,
        },
      })).catch(() => { /* audit is best-effort */ });
      return session;
    });
  });
}

const ACP_IDENTITY_REPLACEMENT_PREFIX = 'acp_identity_replaced:';

/** Return the replacement provider ID recorded by an interrupted ACP migration. */
export function getAcpIdentityReplacementTarget(
  record: Pick<SessionRecord, 'archived' | 'archive_reason'>,
): string | null {
  if (!record.archived
    || !record.archive_reason?.startsWith(ACP_IDENTITY_REPLACEMENT_PREFIX)) {
    return null;
  }
  const target = record.archive_reason.slice(ACP_IDENTITY_REPLACEMENT_PREFIX.length);
  return target || null;
}

/**
 * Stage an ACP provider-ID replacement without creating a cross-store crash
 * window. The replacement row and archived redirect row commit in one SQLite
 * transaction; task links can then move before the redirect is deleted.
 */
export async function stageAcpSessionIdMigration(
  oldClaudeSessionId: string,
  newClaudeSessionId: string,
  updates?: SessionRecordUpdates,
): Promise<SessionRecord | null> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) throw new Error('stageAcpSessionIdMigration: SQLite handle is null');
    return sessionDbTx((handle) => {
      const oldRow = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?')
        .get(oldClaudeSessionId) as Record<string, any> | undefined;
      if (!oldRow) return null;
      const conflict = handle.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?')
        .get(newClaudeSessionId);
      if (conflict) return null;

      const oldRecord = rowToSession(oldRow);
      initializeStatusVersion(oldRecord);
      const now = new Date().toISOString();
      const replacement: SessionRecord = {
        ...oldRecord,
        ...withoutStatusVersionOverrides(updates ?? {}),
        claudeSessionId: newClaudeSessionId,
        archived: false,
        archive_reason: undefined,
        lastActiveAt: now,
      };
      const redirect: SessionRecord = {
        ...oldRecord,
        archived: true,
        archive_reason: ACP_IDENTITY_REPLACEMENT_PREFIX + newClaudeSessionId,
        lastActiveAt: now,
      };
      commitStatusVersion(
        redirect,
        canonicalStatusProjection(oldRecord),
        now,
      );
      // A client may hydrate the archived redirect before receiving the
      // replacement event. The replacement must therefore be newer than both
      // the original and redirect snapshots or alias promotion can retain the
      // archived state and reject the replacement as stale.
      replacement.statusRevision = normalizedStatusRevision(redirect) + 1;
      replacement.statusUpdatedAt = now;

      writeSessionRowSqlite(handle, redirect);
      writeSessionRowSqlite(handle, replacement);
      log.session.info('ACP session ID migration staged', {
        oldSessionId: oldClaudeSessionId,
        newSessionId: newClaudeSessionId,
        runtimeId: replacement.acpRuntimeId,
      });
      return replacement;
    });
  });
}

/** Roll back a staged ACP replacement after an ordinary task-link failure. */
export async function rollbackAcpSessionIdMigration(
  oldClaudeSessionId: string,
  newClaudeSessionId: string,
): Promise<boolean> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) throw new Error('rollbackAcpSessionIdMigration: SQLite handle is null');
    return sessionDbTx((handle) => {
      const oldRow = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?')
        .get(oldClaudeSessionId) as Record<string, any> | undefined;
      const newRow = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?')
        .get(newClaudeSessionId) as Record<string, any> | undefined;
      if (!oldRow || !newRow) return false;

      const oldRecord = rowToSession(oldRow);
      const replacement = rowToSession(newRow);
      if (getAcpIdentityReplacementTarget(oldRecord) !== newClaudeSessionId
        || !isAcpEngine(oldRecord.engine)
        || !isAcpEngine(replacement.engine)
        || oldRecord.acpRuntimeId !== replacement.acpRuntimeId
        || oldRecord.taskId !== replacement.taskId) {
        return false;
      }

      initializeStatusVersion(oldRecord);
      const beforeStatus = canonicalStatusProjection(oldRecord);
      oldRecord.archived = false;
      oldRecord.archive_reason = undefined;
      const now = new Date().toISOString();
      oldRecord.lastActiveAt = now;
      commitStatusVersion(oldRecord, beforeStatus, now);
      handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?')
        .run(newClaudeSessionId);
      writeSessionRowSqlite(handle, oldRecord);
      log.session.info('ACP session ID migration rolled back', {
        oldSessionId: oldClaudeSessionId,
        newSessionId: newClaudeSessionId,
        runtimeId: oldRecord.acpRuntimeId,
      });
      return true;
    });
  });
}

/**
 * Link a session to a task ID.
 */
export async function linkSessionToTask(claudeSessionId: string, taskId: string): Promise<void> {
  await updateSessionRecord(claudeSessionId, { taskId });
}

/**
 * Clear the task link on every session that points at one of the given task
 * ids. Called by task deletion (deleteTask / deleteTasksByIds / deleteTasksBulk)
 * so a removed task never leaves dangling session.task_id pointers — a sweep on
 * 2026-08-20 found 275 sessions orphaned this way, each invisible on its
 * task's session list forever after.
 *
 * Raw column UPDATE is safe here: task_id is an explicit column (never spilled
 * into `payload` by sessionToRow), and it is not part of the status projection,
 * so the snapshot gate does not apply. Cache invalidation rides on
 * withWriteLock's finally.
 */
export async function unlinkSessionsFromTasks(taskIds: string[]): Promise<number> {
  if (!taskIds.length) return 0;
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) return 0;
    const placeholders = taskIds.map(() => '?').join(', ');
    const result = db.prepare(
      `UPDATE sessions SET task_id = NULL WHERE task_id IN (${placeholders})`,
    ).run(...taskIds);
    if (result.changes > 0) {
      log.session.info('cleared task links for deleted tasks', {
        taskIds, sessionsUnlinked: result.changes,
      });
    }
    return result.changes;
  });
}

/**
 * Re-point every session linked to `fromTaskId` at `toTaskId`. The merge-side
 * sibling of unlinkSessionsFromTasks: when duplicate tasks are merged, the
 * victims' sessions must FOLLOW the surviving task, never be dropped — dedup
 * cleanups that deleted the copy holding the links are how sessions went
 * invisible (35 tasks lost their links before 2026-08-20). Same raw-column
 * UPDATE rationale as unlinkSessionsFromTasks.
 */
export async function relinkSessionsToTask(fromTaskId: string, toTaskId: string): Promise<number> {
  if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return 0;
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) return 0;
    const result = db.prepare(
      'UPDATE sessions SET task_id = ? WHERE task_id = ?',
    ).run(toTaskId, fromTaskId);
    if (result.changes > 0) {
      log.session.info('re-pointed session task links to merge survivor', {
        fromTaskId, toTaskId, sessionsRelinked: result.changes,
      });
    }
    return result.changes;
  });
}

/**
 * Mark all sessions in the given list as completed.
 * Skips sessions that are already in a terminal state (completed/error).
 * Also kills any orphaned OS processes (best-effort, fire-and-forget).
 * Returns the number of sessions actually updated.
 */
export async function completeTaskSessions(sessionIds: string[]): Promise<number> {
  if (!sessionIds.length) return 0;
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('completeTaskSessions: SQLite handle is null');
    }
    const now = new Date().toISOString();
    let updated = 0;
    // sid rides along with the pid: the in-memory session must be told the kill is
    // intentional BEFORE the signal lands, or its liveness monitor reports the exit
    // as "session init failed" (a red toast on every task you mark done, 2026-08-10).
    const pidsToKill: { pid: number; sid: string }[] = [];
    const toReap: { claudeSessionId: string; host?: string }[] = [];

    const insertCols = [...SESSION_COLUMNS, 'payload'];
    const insertSql =
      'INSERT OR REPLACE INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    sessionDbTx((handle) => {
      const sel = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
      const ins = handle.prepare(insertSql);
      for (const sid of sessionIds) {
        const row = sel.get(sid) as Record<string, any> | undefined;
        if (!row) continue;
        const session = rowToSession(row);
        initializeStatusVersion(session);
        const beforeStatus = canonicalStatusProjection(session);
        if (isTerminalSession(session)) continue;
        // Already-converged record: stopped with no PID — rewriting it is pure
        // churn. 'stopped' is not terminal per isTerminalSession (only 'error'
        // is), so without this skip every server boot re-wrote the same ~1000
        // rows in one synchronous transaction (~6s event-loop stall right after
        // listen, queueing the browser's first requests behind it).
        if (session.process_status === 'stopped' && session.pid == null) continue;
        if (session.pid != null && session.provider !== 'embedded' && session.provider !== 'sdk') {
          pidsToKill.push({ pid: session.pid, sid: session.claudeSessionId });
        }
        toReap.push({ claudeSessionId: session.claudeSessionId, host: session.host });
        session.process_status = 'stopped';
        // Stamp the INTENT before the SIGINT below lands: the death snapshot the
        // daemon folds after our kill has no clean result tail (the CLI can die
        // mid-turn — e.g. the session completing its OWN task via the gateway is
        // killed while its Bash tool is still running) and projects 'error'. The
        // snapshot applier honors a durable intentional-teardown reason and keeps
        // the label 'stopped' (2026-08-23: compare-task session showed red Error
        // after finishing its work and completing its task).
        session.status_reason = 'expected_teardown';
        session.status_changed_by = 'system';
        if (session.pid != null) {
          log.session.info('clearing stale PID on task completion', { sessionId: sid, pid: session.pid });
        }
        session.pid = undefined;
        session.last_status_change = now;
        session.lastActiveAt = now;
        commitStatusVersion(session, beforeStatus, now);
        const partial = sessionToRow(session);
        const bound: Record<string, unknown> = {};
        for (const col of insertCols) {
          bound[col] = partial[col] === undefined ? null : partial[col];
        }
        ins.run(bound);
        updated++;
      }
    });
    if (updated > 0) {
      log.session.info('completing task sessions', { sessionIds: sessionIds.join(','), count: updated });
      // Mark BEFORE signalling (see pidsToKill). Dynamic import avoids the
      // session-tracker ↔ claude-code-session cycle; it's module-cached.
      if (pidsToKill.length > 0) {
        try {
          const { sessionRunner } = await import('../providers/claude-code-session.js');
          for (const { sid } of pidsToKill) {
            sessionRunner.markExpectedTeardown(sid, 'task_completed');
          }
        } catch (err) {
          log.session.debug('markExpectedTeardown unavailable on task completion', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      for (const { pid } of pidsToKill) {
        try { process.kill(pid, 'SIGINT'); } catch { /* already dead */ }
      }
      // Conditionally reap each session's persistent terminal (dtach): a session
      // still running a foreground build/test is kept; an idle shell is killed.
      // Best-effort, fire-and-forget — terminal feature may be disabled.
      import('../web/terminal/dtach-lifecycle.js')
        .then(({ conditionalReap }) =>
          Promise.all(toReap.map((r) => conditionalReap(r).catch(() => { /* per-session best-effort */ }))),
        )
        .catch(() => { /* terminal feature disabled */ });
    }
    return updated;
  });
}

/**
 * Remove session records by ID. Used by Session Reaper for cleanup.
 * Returns the number of records removed.
 * `reason` names the caller in the durable audit trail (inc-2026-08-10:
 * a vanished record could not be attributed because runtime logs had rotated).
 */
export async function deleteSessionRecords(ids: Set<string>, reason = 'unspecified'): Promise<number> {
  if (ids.size === 0) return 0;
  await ensureSessionInit();
  const removedIds: string[] = [];
  const removedSnapshots: {
    sessionId: string; taskId?: string; title?: string; host?: string;
    process_status?: string; startedAt?: string;
  }[] = [];
  const removed = await withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('deleteSessionRecords: SQLite handle is null');
    }
    let removed = 0;
    sessionDbTx((handle) => {
      const sel = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
      const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
      for (const id of ids) {
        const row = sel.get(id) as Record<string, any> | undefined;
        const res = del.run(id);
        removed += res.changes;
        if (res.changes > 0) {
          removedIds.push(id);
          if (row) {
            const rec = rowToSession(row);
            removedSnapshots.push({
              sessionId: id, taskId: rec.taskId, title: rec.title, host: rec.host,
              process_status: rec.process_status, startedAt: rec.startedAt,
            });
          }
        }
      }
    });
    return removed;
  });
  if (removedIds.length > 0) {
    import('./session-audit.js').then(({ auditSessionRecord }) => {
      for (const snap of removedSnapshots) {
        const { sessionId, ...record } = snap;
        auditSessionRecord({ op: 'delete', sessionId, reason, record });
      }
    }).catch(() => { /* audit is best-effort */ });
    bus.emit(
      EventNames.SESSION_DELETED,
      { sessionIds: removedIds },
      ['*'],
      { source: 'session-tracker', urgency: 'normal' },
    );
  }
  return removed;
}

/**
 * Get session summaries from markdown files in the sessions directory.
 */
export async function getSessionSummaries(limit = 10): Promise<SessionSummary[]> {
  await ensureDir(SESSIONS_DIR);

  let files: string[];
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const mdFiles = files
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);

  const summaries: SessionSummary[] = [];
  for (const file of mdFiles) {
    try {
      const content = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8');
      const parsed = parseSessionMarkdown(content, file);
      if (parsed) summaries.push(parsed);
    } catch {
      // Skip unreadable files
    }
  }

  return summaries;
}

/**
 * Get recent tracked sessions, sorted by last active time.
 *
 * Lane-bound sessions (records with `lane` set) are EXCLUDED by default — they
 * back a persistent UI conversation surface, not a listed session. Pass
 * `{ includeLanes: true }` when a caller legitimately needs them (e.g. lane
 * bookkeeping). The filter runs before the limit so excluded lanes don't eat
 * slots in the returned window.
 */
export async function getRecentSessions(
  limit = 10,
  opts?: { includeLanes?: boolean },
): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions
    .filter((s) => (opts?.includeLanes ? true : !isLaneSession(s)))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, limit);
}

/**
 * Parse a session summary markdown file into a SessionSummary object.
 */
function parseSessionMarkdown(content: string, filename: string): SessionSummary | null {
  const lines = content.split('\n');
  const titleLine = lines.find((l) => l.startsWith('# Session:'));
  const dateLine = lines.find((l) => l.startsWith('Date:'));
  const projectLine = lines.find((l) => l.startsWith('Project:'));
  const statusLine = lines.find((l) => l.startsWith('Status:'));

  // Extract summary section
  const summaryIdx = lines.findIndex((l) => l.trim() === '## Summary');
  let summary = '';
  if (summaryIdx !== -1) {
    const nextSectionIdx = lines.findIndex(
      (l, i) => i > summaryIdx && l.startsWith('## '),
    );
    const end = nextSectionIdx === -1 ? lines.length : nextSectionIdx;
    summary = lines
      .slice(summaryIdx + 1, end)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
  }

  const slug = filename.replace(/\.md$/, '');

  return {
    id: slug,
    project: projectLine?.replace('Project:', '').trim() ?? 'unknown',
    slug,
    summary: summary || titleLine?.replace('# Session:', '').trim() || slug,
    status: statusLine?.replace('Status:', '').trim() ?? 'completed',
    date: dateLine?.replace('Date:', '').trim() ?? '',
    task_ids: [],
  };
}
