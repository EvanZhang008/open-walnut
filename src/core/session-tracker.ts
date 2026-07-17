import path from 'node:path';
import fs from 'node:fs/promises';
import { SESSIONS_DIR } from '../constants.js';
import { ensureDir } from '../utils/fs.js';
import { isSessionProcessAlive } from '../utils/session-liveness.js';
import { log } from '../logging/index.js';
import type { SessionSummary, SessionRecord, SessionMode, SessionType, TaskPhase, ProcessStatus, StatusTransition } from './types.js';
import { getDb, rowToSession, sessionToRow, SESSION_COLUMNS, transaction as sessionDbTx } from './session-db.js';
import { runSessionMigrationIfNeeded } from './session-db-migration.js';

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

/** Drop the cached whole-store snapshot. Called from withWriteLock.finally. */
function invalidateSessionStoreCache(): void {
  sessionStoreCache = null;
}

/** Reset module-level state for test isolation. */
export function _resetSessionTrackerForTesting(): void {
  sessionInitialized = false;
  sessionStoreCache = null;
}

const MAX_STATUS_HISTORY = 10;

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
  if (sessionStoreCache === null) {
    const db = getDb();
    if (!db) {
      throw new Error('readStore: SQLite handle is null');
    }
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, any>[];
    sessionStoreCache = rows.map(rowToSession);
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
  extra?: { pid?: number; outputFile?: string; title?: string; description?: string; mode?: SessionMode; planFile?: string; planCompleted?: boolean; host?: string; provider?: import('./types.js').SessionProvider; type?: SessionType; fromPlanSessionId?: string; forkedFromSessionId?: string; cliModel?: string; effort?: import('./types.js').SessionEffort; initialProcessStatus?: SessionRecord['process_status'] },
): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('createSessionRecord: SQLite handle is null');
    }
    const now = new Date().toISOString();
    const row = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
      | Record<string, any>
      | undefined;

    if (row) {
      const existing = rowToSession(row);
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

      writeSessionRowSqlite(db, existing);
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
      last_status_change: now,
      startedAt: now,
      lastActiveAt: now,
      messageCount: 1,
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
      ...(extra?.cliModel ? { cliModel: extra.cliModel } : {}),
      ...(extra?.effort ? { effort: extra.effort } : {}),
    };

    writeSessionRowSqlite(db, record);
    log.session.info('session record created', { sessionId: claudeSessionId, taskId, project, mode: extra?.mode, host: extra?.host });
    return record;
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
  sessionDbTx((handle) => {
    handle.prepare(insertSql).run(bound);
  });
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
}): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('importSessionRecord: SQLite handle is null');
    }
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
    };

    const row = db.prepare('SELECT task_id FROM sessions WHERE claude_session_id = ?')
      .get(opts.claudeSessionId) as { task_id?: string } | undefined;
    if (row) {
      throw new Error(
        `Session ${opts.claudeSessionId} is already tracked (task: ${row.task_id ?? ''}). ` +
        `Use session_send to interact with it.`,
      );
    }
    writeSessionRowSqlite(db, record);

    log.session.info('imported external session', {
      sessionId: opts.claudeSessionId,
      taskId: opts.taskId,
      project: opts.project,
      host: opts.host,
    });
    return record;
  });
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
  updates: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
  logLabel: string,
): boolean {
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
    const regression = typeof session.consumedOffset === 'number' && !invalid
      && next <= session.consumedOffset;
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
  Object.assign(session, updates);

  if (updates.process_status && updates.process_status !== prevStatus) {
    const transition: StatusTransition = {
      timestamp: new Date().toISOString(),
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
  session.lastActiveAt = new Date().toISOString();
  return true;
}

/**
 * Update an existing session's fields.
 */
export async function updateSessionRecord(
  claudeSessionId: string,
  updates: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('updateSessionRecord: SQLite handle is null');
    }

    const row = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
      | Record<string, any>
      | undefined;
    if (!row) {
      throw new Error(`Session not found: ${claudeSessionId}`);
    }
    const session = rowToSession(row);

    // No-op guard BEFORE any UPDATE SQL — critical to avoid write-lock storms
    // when the daemon replays identical init/model/pid updates.
    if (!applyUpdateToSession(session, updates, 'clearing stale PID on terminal transition')) {
      return session;
    }

    writeSessionRowSqlite(db, session);
    log.session.info('session record updated', { sessionId: claudeSessionId, fields: Object.keys(updates) });
    return session;
  });
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
  updates: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
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
  updates: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
  shouldUpdate: (current: SessionRecord) => boolean,
): Promise<SessionRecord | null> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('updateSessionRecordConditionally: SQLite handle is null');
    }

    const row = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
      | Record<string, any>
      | undefined;
    if (!row) return null;
    const session = rowToSession(row);

    if (!shouldUpdate(session)) return null;

    if (!applyUpdateToSession(session, updates, 'clearing stale PID on terminal transition (conditional)')) {
      return session;
    }
    writeSessionRowSqlite(db, session);
    log.session.info('session record updated (conditional)', { sessionId: claudeSessionId, fields: Object.keys(updates) });
    return session;
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
  updates?: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
): Promise<SessionRecord | null> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('renameSessionId: SQLite handle is null');
    }
    const oldRow = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(oldClaudeSessionId) as
      | Record<string, any> | undefined;
    if (!oldRow) return null;

    const conflict = db.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?').get(newClaudeSessionId);
    if (conflict) {
      log.session.warn('renameSessionId: new ID already exists, skipping rename to avoid collision', {
        oldId: oldClaudeSessionId, newId: newClaudeSessionId,
      });
      return null;
    }

    const session = rowToSession(oldRow);
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
    if (updates) Object.assign(session, updates);
    session.lastActiveAt = new Date().toISOString();

    // Delete old PK + insert under new PK in one transaction so a crash mid-rename
    // can't leave both rows orphaned. INSERT OR REPLACE with the new PK won't
    // clean up the old row on its own.
    sessionDbTx((handle) => {
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
    });
    log.session.info('session ID renamed', { oldId: oldClaudeSessionId, newId: newClaudeSessionId });
    return session;
  });
}

/**
 * Link a session to a task ID.
 */
export async function linkSessionToTask(claudeSessionId: string, taskId: string): Promise<void> {
  await updateSessionRecord(claudeSessionId, { taskId });
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
    const pidsToKill: number[] = [];
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
        if (isTerminalSession(session)) continue;
        // Already-converged record: stopped with no PID — rewriting it is pure
        // churn. 'stopped' is not terminal per isTerminalSession (only 'error'
        // is), so without this skip every server boot re-wrote the same ~1000
        // rows in one synchronous transaction (~6s event-loop stall right after
        // listen, queueing the browser's first requests behind it).
        if (session.process_status === 'stopped' && session.pid == null) continue;
        if (session.pid != null && session.provider !== 'embedded' && session.provider !== 'sdk') {
          pidsToKill.push(session.pid);
        }
        toReap.push({ claudeSessionId: session.claudeSessionId, host: session.host });
        session.process_status = 'stopped';
        if (session.pid != null) {
          log.session.info('clearing stale PID on task completion', { sessionId: sid, pid: session.pid });
        }
        session.pid = undefined;
        session.last_status_change = now;
        session.lastActiveAt = now;
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
      for (const pid of pidsToKill) {
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
 */
export async function deleteSessionRecords(ids: Set<string>): Promise<number> {
  if (ids.size === 0) return 0;
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('deleteSessionRecords: SQLite handle is null');
    }
    let removed = 0;
    sessionDbTx((handle) => {
      const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
      for (const id of ids) {
        const res = del.run(id);
        removed += res.changes;
      }
    });
    return removed;
  });
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
 */
export async function getRecentSessions(limit = 10): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions
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
