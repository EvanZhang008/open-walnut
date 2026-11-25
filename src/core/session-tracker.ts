import path from 'node:path';
import fs from 'node:fs/promises';
import { SESSIONS_DIR, WALNUT_HOME } from '../constants.js';
import { isSessionProcessAlive } from '../utils/session-liveness.js';
import { mapLimit } from '../utils/map-limit.js';
import { LIVENESS_PROBE_CONCURRENCY } from './sessions/liveness-concurrency.js';
import { log } from '../logging/index.js';
import { isQuietTurn } from './sessions/quiet-turn.js';
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
import { dbGeneration, getDb, rowToSession, sessionToRow, sessionWriteHandle, ownRowHostKey, SESSION_COLUMNS, transactionWhenFree, readChannelCursor, writeChannelCursor, sessionRowWrites } from './session-db.js';
import { runSessionMigrationIfNeeded } from './session-db-migration.js';
import { isFollower, isHostReplica } from './server-role.js';
import { processActionsRefused, refuseProcessAction } from './sessions/replica-process-guard.js';
import { bus, EventNames, type EmitOptions } from './event-bus.js';
import type { SessionStatusChangedEvent } from './event-types.js';
import { projectOrInbox } from './inbox-project.js';
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
  putBoundedEntry,
} from './session-snapshot-gate.js';
// Also a zero-import leaf — see the file header for why classification cannot
// live in a prose match.
import { classifyStatusReasonKind } from './session-error-kind.js';
import { SELF_COMPLETE_STOP_MAX_MS, stopWhenTurnEnds } from './sessions/self-complete-stop.js';
import { completionAskPending, hostCompleteStopState, stopHostRunForCompletion, type HostCompletionStop } from './sessions/host-judged-complete.js';
import { liveAcpSessionIds, noteStopUndelivered, recheckUndeliveredHosts, undeliveredHolds, unreachableOwnerHosts } from './sessions/task-complete-stop.js';
import { assertTaskSessionFree, otherTaskSessionId } from './sessions/one-session-per-task.js';
import { isAcpEngine, resolveEngine } from './agents/engine-registry.js';
import { CLOUD_BOX_DEFAULT_IDLE_LIMIT, CLOUD_BOX_DEFAULT_LIMIT, CLOUD_BOX_HOST_ALIAS } from './hosts/cloud-box-host.js';
import { NeedsLeaderError } from './replication/needs-leader.js';
import { foldTurnSpeed } from './sessions/speed-totals.js';
import { cliHostOf, execHostOf, isWritingAsHost, judgedByHost, mergeHostFacts, ownedPartOf, rowOwnedHere, thisHostKey, writingAsHost } from './sessions/session-row-owner.js';
import { FACT_INLINE_CAP } from './session-channel/fact-log.js';
import { leaderToldAtBoundary, toldIntoLeaderCopies } from './sessions/told-copies.js';
import { judgedHereRecords } from './sessions/judge-of.js';
import { clearLeaderDrops, leaderDroppedIn, noteLeaderDrop } from './session-channel/leader-drops.js';
import { noteTurnEndIn, type HostTurnEnd } from './session-channel/turn-ends.js';
import { clearHandOverMarkIn } from './session-channel/handover-marks.js';
import { handForNewSession, handedTo, hostOwns, mayRenameInto, settleHandsOf, useHand } from './session-channel/handed-sessions.js';
import { oneDaemonNow } from './session-channel/revoked-hosts.js';
import { noteRefusedSessions } from './session-channel/refused-sessions.js';
import { _resetRowsSnapshotForTesting, noteSnapshotApplied, orphanedRow, planSnapshot, snapshotIsStale } from './session-channel/rows-snapshot.js';
import { hasOwnRowListener, noteSessionRowWritten } from './session-channel/row-hook.js';
import { prepared } from '../lib/sqlite-prepared.js';
import { OrgError } from './org/org-store.js';
import { hasUnstoredRows, unstoredSessions } from './unstored-rows.js';
import { copyCallerCounter, registerBurstContext, registerMemoryHolder, registerSampleNote, sampledStringChars } from './observability/memory-ledger.js';
import {
  assertOutsideHistoryImport, assertSessionHistoryWrite, isHistoryRefusal, sessionHistoryWriteNeedsCheck,
  taskDbHandle, type SessionHistoryFields,
} from './router/history-write.js';

let sessionInitialized = false;

async function ensureSessionInit(): Promise<void> {
  if (sessionInitialized) return;
  getDb();
  // A host replica's session store is a copy (replica/copy-guard.ts): no migration writes it.
  if (!isHostReplica()) await runSessionMigrationIfNeeded();
  sessionInitialized = true;
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
let sessionStoreCacheDataVersion: string | null = null;
// Every session row (7.2k on the maintainer's board, 2026-11-20), so it grows with use.
registerMemoryHolder({
  name: 'session-tracker.store',
  budgetBytes: 160 * 1024 * 1024,
  read: () => ({ entries: sessionStoreCache?.length ?? 0, chars: sampledStringChars(sessionStoreCache) }),
});

/**
 * The version a snapshot is trusted at: which open of the database (a reopened
 * handle starts its own `data_version` count, so a match across opens means
 * nothing) and `PRAGMA data_version`, which moves when another connection commits.
 */
function storeVersion(db: NonNullable<ReturnType<typeof getDb>>): string {
  return `${dbGeneration()}:${db.pragma('data_version', { simple: true }) as number}`;
}

/** Drop the cached whole-store snapshot. Called from withWriteLock.finally. */
function invalidateSessionStoreCache(): void {
  sessionStoreCache = null;
  sessionStoreCacheDataVersion = null;
  sessionStoreGen += 1;
}

/** Moves on every change of the cached snapshot: a memo key over sessionRowsForReplica's rows. */
let sessionStoreGen = 0;
export function sessionStoreGeneration(): number { return sessionStoreGen; }

// ── Write-through: a row write patches the cache instead of dropping it ──
//
// Dropping the snapshot on every write meant the NEXT reader rebuilt it with a
// full `SELECT *` + rowToSession over the whole table: 5.6k rows (5.5k of them
// stopped for good), ~250ms idle and over 1s on a loaded machine, on the event
// loop. With ~30 live sessions each writing status every few seconds and
// /api/sessions/status polling in between, that rebuild ran several times a
// minute and was 12% of all main-thread CPU on the live server (2026-09-29).
//
// Every in-process writer goes through writeSessionRowSqlite (INSERT OR REPLACE
// by claude_session_id) or deleteSessionRowSqlite, so the lock knows exactly
// which rows a section touched. On a clean commit it re-reads those rows and
// swaps them into the snapshot; a section that threw (rolled back), a snapshot
// that is missing, or a foreign commit (`PRAGMA data_version` moved: the on-stop
// hook writes through its own connection) still takes the drop.
let touchedSessionIds: Set<string> | null = null;

function noteSessionRowTouched(claudeSessionId: string): void {
  touchedSessionIds?.add(claudeSessionId);
}

/** Rows of any table this connection has changed since it opened: SQLite's own counter. */
function totalChanges(db: NonNullable<ReturnType<typeof getDb>>): number {
  return prepared(db, 'SELECT total_changes() AS n', 'pluck').get() as number;
}

/**
 * Session rows this connection has changed since it opened (session-db.ts sessionRowWrites), else
 * every row it changed. The snapshot guard below compares this with the rows a section named.
 */
function sessionRowChanges(db: NonNullable<ReturnType<typeof getDb>>, total: number): number {
  return sessionRowWrites(db) ?? total;
}

// ── Heavy prompt fields stay in SQLite for sessions that are not live ─────
//
// Two fields are most of the cache: the system prompt a CLI was spawned with
// (`appliedAppendSystemPrompt`, ~22 KB) and a lane's persona (`profile.systemPrompt`,
// ~70 KB). On the maintainer's board (2026-11-20) 7,116 of 7,203 rows were stopped and
// those two fields of theirs were about 90 MB of the server's heap. Everything that needs
// them for a session reads its row straight from SQLite (resume, respawn, prompt refresh,
// notices, lanes, forks: getSessionByClaudeId), every writer re-reads its row inside the
// write transaction, and replication strips both fields anyway. A cached row of a stopped
// or errored session therefore leaves them out; the one list reader that needs them
// (host-slice's notice) takes the row through withHeavyFields. A row that comes back to
// life is re-read by the write-through patch and carries them again.
// Ratchet: tests/core/session-store-heavy-fields.test.ts.
const SLIM_STATUSES = new Set(['stopped', 'error']);

/** The cached copy of a row: without the heavy prompt fields when the session is not live. */
function slimForCache(record: SessionRecord): SessionRecord {
  if (!SLIM_STATUSES.has(record.process_status ?? '')) return record;
  const hasPrompt = record.appliedAppendSystemPrompt !== undefined;
  const hasPersona = record.profile?.systemPrompt !== undefined;
  if (!hasPrompt && !hasPersona) return record;
  const slim: SessionRecord = { ...record };
  if (hasPrompt) delete slim.appliedAppendSystemPrompt;
  if (hasPersona) {
    const { systemPrompt: _persona, ...rest } = record.profile!;
    slim.profile = rest as SessionRecord['profile'];
  }
  return slim;
}

/**
 * The record with its heavy prompt fields: itself when it has them, else its row from
 * SQLite. For a reader that got the record from a list (listSessions and the like) and
 * needs `appliedAppendSystemPrompt` or `profile.systemPrompt`.
 */
export function withHeavyFields(record: SessionRecord): SessionRecord {
  if (!SLIM_STATUSES.has(record.process_status ?? '')) return record;
  if (record.appliedAppendSystemPrompt !== undefined && (record.profile === undefined || record.profile.systemPrompt !== undefined)) return record;
  return getSessionByClaudeIdSync(record.claudeSessionId) ?? record;
}

/** Store-shape counters for tests and the daily loop check. */
const sessionStoreStats = { fullScans: 0, externalScans: 0, scanMs: 0, patchedRows: 0, cloneReads: 0, viewReads: 0, clonedRows: 0 };
// What the store's reads cost, on every `memory sample` and `memory burst` line: a full scan reads
// and parses every row (about 7.4k), and the CPU profiles of the 22 GB climb on 2026-11-23 had
// loadStoreRows at 9 s of a 30 s window. externalScans: another connection committed (a hook).
registerSampleNote('sessionStore', () => `scans=${sessionStoreStats.fullScans} external=${sessionStoreStats.externalScans} scanMs=${Math.round(sessionStoreStats.scanMs)} clonedRows=${sessionStoreStats.clonedRows}`);
registerBurstContext('sessionStore', () => ({ ...sessionStoreStats, scanMs: Math.round(sessionStoreStats.scanMs) }));
export function _sessionStoreStatsForTesting(): Readonly<typeof sessionStoreStats> { return { ...sessionStoreStats }; }
/** Forget the cached snapshot (the next reader scans), leaving init and the connection alone. */
export function _dropSessionStoreCacheForTesting(): void { invalidateSessionStoreCache(); }

function patchSessionCacheRows(ids: ReadonlySet<string>): void {
  const db = getDb();
  if (!db || !STORE_CACHE_ENABLED || sessionStoreCache === null) {
    invalidateSessionStoreCache();
    return;
  }
  if (ids.size === 0) return;
  if (storeVersion(db) !== sessionStoreCacheDataVersion) {
    invalidateSessionStoreCache();
    return;
  }
  const wanted = [...ids];
  const at = new Map(sessionStoreCache.map((s, i) => [s.claudeSessionId, i]));
  const removed = new Set<string>();
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT * FROM sessions WHERE claude_session_id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as Record<string, any>[];
    const present = new Map(rows.map((r) => [r.claude_session_id as string, r]));
    for (const id of chunk) {
      const row = present.get(id);
      if (!row) { removed.add(id); continue; }
      const record = slimForCache(rowToSession(row));
      const index = at.get(id);
      if (index === undefined) {
        at.set(id, sessionStoreCache.length);
        sessionStoreCache.push(record);
      } else {
        sessionStoreCache[index] = record;
      }
      sessionStoreStats.patchedRows += 1;
    }
  }
  if (removed.size > 0) sessionStoreCache = sessionStoreCache.filter((s) => !removed.has(s.claudeSessionId));
  sessionStoreGen += 1;
}

/**
 * The row hook (session-channel/row-hook.ts): every row a committed section wrote, as stored now,
 * read back only while something listens (a host that runs its sessions). A deleted row is not
 * announced. Every write statement of this store notes its row (noteSessionRowTouched), so this
 * is every write path; tests/core/session-channel/row-hook-ratchet.test.ts keeps it so.
 */
function announceWrittenRows(ids: ReadonlySet<string>): void {
  if (!hasOwnRowListener()) return;
  const db = getDb();
  if (!db) return;
  const wanted = [...ids];
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT * FROM sessions WHERE claude_session_id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as Record<string, any>[];
    for (const row of rows) noteSessionRowWritten(rowToSession(row));
  }
}

/** Reset module-level state for test isolation. */
export function _resetSessionTrackerForTesting(): void {
  sessionInitialized = false;
  sessionStoreCache = null;
  sessionStoreCacheDataVersion = null;
  sessionStoreGen += 1;
  touchedSessionIds = null;
  for (const key of Object.keys(sessionStoreStats) as (keyof typeof sessionStoreStats)[]) sessionStoreStats[key] = 0;
  _resetRowsSnapshotForTesting();
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

/** Who asks for a copy of the whole store (memory-ledger.ts copyCallerCounter). */
const noteSessionCopy = copyCallerCounter('sessionCopies');

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
  // Before the await: the frames above are the readers that asked.
  noteSessionCopy();
  const sessions = await loadStoreRows();
  if (!STORE_CACHE_ENABLED) return { sessions };
  sessionStoreStats.cloneReads += 1;
  sessionStoreStats.clonedRows += sessions.length;
  return { sessions: sessions.map((s) => ({ ...s })) };
}

/**
 * The canonical cached rows themselves, for helpers that filter before they
 * return. Never hand a record or the array to a caller: clone what you return
 * (cloneSession) and never sort or mutate in place. Collect what you need before
 * any await: a write patches this array in place. Every filtered helper used to
 * pay readStore()'s clone of all ~5.6k rows to keep a few dozen.
 */
async function readStoreView(): Promise<readonly SessionRecord[]> {
  sessionStoreStats.viewReads += 1;
  return loadStoreRows();
}

/** One isolated record copy, the same shape readStore's clone hands out. */
function cloneSession(s: SessionRecord): SessionRecord {
  sessionStoreStats.clonedRows += 1;
  return { ...s };
}

/** The cached snapshot while it is current, else a fresh scan that re-seeds it. */
async function loadStoreRows(): Promise<SessionRecord[]> {
  await ensureSessionInit();
  if (!STORE_CACHE_ENABLED) {
    const db = getDb();
    if (!db) {
      throw new Error('readStore: SQLite handle is null');
    }
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, any>[];
    // Uncached, every read is a new snapshot.
    sessionStoreGen += 1;
    return rows.map(rowToSession);
  }
  const db = getDb();
  if (!db) {
    throw new Error('readStore: SQLite handle is null');
  }
  const dataVersion = () => storeVersion(db);
  const currentDataVersion = dataVersion();
  if (sessionStoreCache === null
    || sessionStoreCacheDataVersion !== currentDataVersion) {
    // An on-stop hook writes through a separate SQLite connection. Retry if
    // that external commit races this SELECT so the cached rows and version
    // always describe the same database state.
    if (sessionStoreCache !== null) sessionStoreStats.externalScans += 1;
    const scanStart = performance.now();
    let before = currentDataVersion;
    let rows: Record<string, any>[];
    let after: string;
    do {
      before = dataVersion();
      rows = db.prepare('SELECT * FROM sessions').all() as Record<string, any>[];
      after = dataVersion();
    } while (before !== after);
    sessionStoreCache = rows.map((row) => slimForCache(rowToSession(row)));
    sessionStoreCacheDataVersion = after;
    sessionStoreGen += 1;
    sessionStoreStats.fullScans += 1;
    sessionStoreStats.scanMs += performance.now() - scanStart;
  }
  return sessionStoreCache;
}

// ── Write lock: serializes read-modify-write operations in-process ────────
// Prevents concurrent callers (session runner, health monitor, reconciler,
// hooks, REST) from overwriting each other's changes via stale snapshots.
// Across processes SQLite's write lock serializes: every section takes it with
// session-db's transactionWhenFree, which waits for it with the loop free. It
// answers a value when the lock was free and a promise only when it waited, so a
// section awaits it only then (`if (lockWait instanceof Promise) await lockWait`)
// and a free lock keeps the order of events callers had with a plain transaction.
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  // Bring the whole-store read cache up to date after EVERY locked mutation.
  // Every writer (create/update/batch/conditional/rename/complete/delete/link)
  // funnels through this lock and through writeSessionRowSqlite /
  // deleteSessionRowSqlite, so the lock knows which rows the section touched
  // and patches exactly those (see the write-through note at the cache decl).
  // A section that threw takes the old drop instead. Either happens BEFORE the
  // lock releases so the next reader sees the committed rows.
  // SQLite's change counter is the check on the notes: a section that changed
  // more rows than it named (a set-based `UPDATE ... WHERE task_id IN (...)`, a
  // writer that never called noteSessionRowTouched) gets the drop, so a missing
  // note can only cost a rescan, never a stale row.
  let touched: Set<string> | null = null;
  let changesBefore = 0;
  let rowChangesBefore = 0;
  return prev
    .then(() => {
      touched = new Set<string>();
      touchedSessionIds = touched;
      // The connection the section writes through (a host's own-row writer, else the shared one).
      const db = sessionWriteHandle();
      changesBefore = db ? totalChanges(db) : 0;
      rowChangesBefore = db ? sessionRowChanges(db, changesBefore) : 0;
      return fn();
    })
    .then(
      (value) => {
        const db = sessionWriteHandle();
        const total = db ? totalChanges(db) : 0;
        const changed = total - changesBefore;
        // Session rows only: the section's other tables (a channel position, turn ends) are no row
        // of this snapshot, and counting them dropped it at every host batch (2026-11-23).
        const rowsChanged = db ? sessionRowChanges(db, total) - rowChangesBefore : 0;
        if (touched === null || rowsChanged > touched.size) invalidateSessionStoreCache();
        else patchSessionCacheRows(touched);
        if (changed > 0) noteSessionStoreWrite();
        if (touched !== null && touched.size > 0) announceWrittenRows(touched);
        return value;
      },
      (err) => { invalidateSessionStoreCache(); throw err; },
    )
    .finally(() => {
      touchedSessionIds = null;
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

// --- Store writes, for the leader's sessions copy (replication/kinds/sessions.ts) ---
const storeWriteListeners = new Set<() => void>();

function noteSessionStoreWrite(): void {
  for (const cb of storeWriteListeners) {
    try { cb(); } catch { /* one listener never stops the others */ }
  }
}

/** Called after every committed write of this process's session store. Returns the stop. */
export function onSessionStoreWrite(cb: () => void): () => void {
  storeWriteListeners.add(cb);
  return () => { storeWriteListeners.delete(cb); };
}

/**
 * Every row of the store as the canonical cached objects (the sessions copy
 * hashes each one once and keeps the hash against the object, which a write
 * replaces). READ ONLY: never mutate a row or the array, and collect what you
 * need before any await (a write patches the array in place).
 */
export async function sessionRowsForReplica(): Promise<readonly SessionRecord[]> {
  return [...await readStoreView()];
}

/**
 * List all tracked sessions. readStore() already returns isolated shallow
 * clones, so callers may freely sort/mutate the result.
 */
// ── Sessions a host replica started while the Mac is away (WP12) ──
// Not in the sessions copy until the Mac adopts them and copies them back; the
// replica installs their rows (replica/ask-launch.ts). A copy row of the same id
// wins. Nothing installs this on the Mac or the companion.
let awaySessionRows: (() => SessionRecord[]) | null = null;
export function installAwaySessions(fn: (() => SessionRecord[]) | null): void {
  awaySessionRows = fn;
}
function awayRows(): SessionRecord[] {
  if (!awaySessionRows) return [];
  try { return awaySessionRows(); } catch { return []; }
}
// Sessions a host's Walnut service with no copy reads from its slice (core/unstored-rows.ts): its
// stored rows, as a sessions copy would hold them. Never an away start: awaySessionsOfTask and
// isAwaySession read only the rows above.
/** Rows beyond the store are installed: started here, or read from the slice. */
function extraInstalled(): boolean {
  return awaySessionRows !== null || hasUnstoredRows();
}
function extraRows(): SessionRecord[] {
  const away = awayRows();
  const slice = unstoredSessions();
  if (!slice.length) return away;
  const have = new Set(away.map((r) => r.claudeSessionId));
  return away.concat(slice.filter((r) => !have.has(r.claudeSessionId)));
}
function withAway(rows: SessionRecord[], keep: (s: SessionRecord) => boolean = () => true): SessionRecord[] {
  const extra = extraRows();
  if (!extra.length) return rows;
  const have = new Set(rows.map((r) => r.claudeSessionId));
  return rows.concat(extra.filter((r) => !have.has(r.claudeSessionId) && keep(r)).map((r) => ({ ...r })));
}

/**
 * The sessions a host replica started alone for `taskId` that its sessions copy does not hold
 * yet (copies, never the installed rows): what its reader fold links to the task
 * (offline-merge/task-row-fold.ts foldAwayStart). Empty on the Mac and the companion.
 */
export function awaySessionsOfTask(taskId: string): SessionRecord[] {
  if (!awaySessionRows || !taskId) return [];
  const mine = awayRows().filter((r) => r.taskId === taskId);
  if (!mine.length) return [];
  const db = getDb();
  const held = db ? db.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?') : null;
  return mine.filter((r) => !held?.get(r.claudeSessionId)).map((r) => ({ ...r }));
}

/** Whether `sid` is a session a host replica started alone that its sessions copy does not hold yet. */
export function isAwaySession(sid: string): boolean {
  if (!awaySessionRows || !sid) return false;
  if (!awayRows().some((r) => r.claudeSessionId === sid)) return false;
  return !getDb()?.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?').get(sid);
}

export async function listSessions(): Promise<SessionRecord[]> {
  const store = await readStore();
  return extraInstalled() ? withAway(store.sessions) : store.sessions;
}

/**
 * Every session, as the store holds it (with a host replica's sessions started alone), for a
 * reader that builds its own rows from them: never edit or keep a record, and go over it in one
 * synchronous pass (a write may patch the list while the reader awaits). 2026-11-24 on the Mac: the session
 * projection export copied all ~9.4k records every 10 s through listSessions, about 1M copies in
 * the ten minutes after a restart.
 */
export async function sessionStoreView(): Promise<readonly SessionRecord[]> {
  const view = await readStoreView();
  return extraInstalled() ? withAway(view as SessionRecord[]) : view;
}

/**
 * Copies of the sessions linked to one of `taskIds` through their taskId, plus
 * any session named in `sessionIds`, in store order. This is everything a task
 * list's session enrichment reads, so it never pays for the rest of the store.
 */
export async function listSessionsForTasks(
  taskIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string> = new Set(),
): Promise<SessionRecord[]> {
  const view = await readStoreView();
  const linked: SessionRecord[] = [];
  for (const s of view) {
    if ((s.taskId && taskIds.has(s.taskId)) || sessionIds.has(s.claudeSessionId)) linked.push(cloneSession(s));
  }
  return extraInstalled() ? withAway(linked, (s) => (!!s.taskId && taskIds.has(s.taskId)) || sessionIds.has(s.claudeSessionId)) : linked;
}

/** The sessions whose stop waits for its host's confirmation: on `host`, or on every host. */
export async function listPendingSessionStops(host?: string): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) throw new Error('Session database is unavailable');
  const rows = (host === undefined
    ? db.prepare(`SELECT * FROM sessions WHERE json_extract(payload, '$.stopRequest.state') = 'pending'`).all()
    : db.prepare(`SELECT * FROM sessions
    WHERE json_extract(payload, '$.stopRequest.state') = 'pending'
    AND COALESCE(host, '__local__') = ?`).all(host)) as Record<string, any>[];
  return rows.map(rowToSession);
}

/** The sessions whose completed task's stop has not reached them yet (sessions/task-complete-stop.ts). */
export async function listTaskCompleteStops(filter: { state: 'turn_end' | 'undelivered'; host?: string }): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) throw new Error('Session database is unavailable');
  const where = `payload IS NOT NULL AND json_valid(payload) AND json_extract(payload, '$.taskCompleteStop.state') = ?`;
  const rows = (filter.host === undefined
    ? db.prepare(`SELECT * FROM sessions WHERE ${where}`).all(filter.state)
    : db.prepare(`SELECT * FROM sessions WHERE ${where} AND COALESCE(NULLIF(host, ''), '__local__') = ?`).all(filter.state, filter.host)) as Record<string, any>[];
  return rows.map(rowToSession);
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

/**
 * The sessions on one host active since `sinceIso`, most recent first (`__local__` = this Mac's,
 * which carry no host). The ready-view refresher's reconnect pass reads it
 * (history-ready-refresh.ts); index-backed on last_active_at. Isolated rows.
 */
export async function listRecentSessionsOnHost(host: string, sinceIso: string): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const where = host === '__local__' ? "(host IS NULL OR host IN ('', '__local__'))" : 'host = @host';
  const rows = db.prepare(
    `SELECT * FROM sessions WHERE last_active_at >= @since AND ${where} ORDER BY last_active_at DESC`,
  ).all(host === '__local__' ? { since: sinceIso } : { since: sinceIso, host }) as Record<string, any>[];
  return rows.map(rowToSession);
}

/** A session that said what it did, as host learning reads it. */
export interface HostSessionLine { claudeSessionId: string; cwd: string; title: string; overview: string; lastActiveAt: string }

/**
 * The sessions on one host that reported an overview: how many there are and
 * the newest `limit` of them, a few columns each (host-learning.ts). Index-backed
 * on host; this Mac's rows carry no host.
 */
export async function hostSessionsWithOverview(host: string, limit: number): Promise<{ count: number; sessions: HostSessionLine[] }> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return { count: 0, sessions: [] };
  const where = host === '__local__' ? "(host IS NULL OR host IN ('', '__local__'))" : 'host = @host';
  // json_valid first: one malformed payload must not fail the whole read.
  const overview = "coalesce(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.overview') END, '')";
  const params = host === '__local__' ? {} : { host };
  const { n } = db.prepare(`SELECT count(*) AS n FROM sessions WHERE ${where} AND ${overview} <> ''`).get(params) as { n: number };
  const rows = db.prepare(
    `SELECT claude_session_id AS claudeSessionId, coalesce(cwd, '') AS cwd, coalesce(title, '') AS title,
            ${overview} AS overview, coalesce(last_active_at, '') AS lastActiveAt
       FROM sessions WHERE ${where} AND ${overview} <> '' ORDER BY last_active_at DESC LIMIT @limit`,
  ).all({ ...params, limit: Math.max(1, Math.min(Math.floor(limit), 200)) }) as HostSessionLine[];
  return { count: n, sessions: rows };
}

/** Every host that has a session with an overview (`__local__` for this Mac). */
export async function hostsWithSessionOverviews(): Promise<string[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare(
    "SELECT DISTINCT coalesce(nullif(host, ''), '__local__') AS host FROM sessions WHERE coalesce(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.overview') END, '') <> ''",
  ).all() as { host: string }[];
  return rows.map((r) => r.host);
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
  const view = await readStoreView();
  const limit = Math.max(1, Math.min(
    Number.isFinite(options.limit) ? Math.floor(options.limit!) : DEFAULT_SESSION_QUERY_LIMIT,
    MAX_SESSION_QUERY_LIMIT,
  ));
  const query = options.query?.trim().toLowerCase() ?? '';
  const matching = view.filter((session) => {
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
      session.overview,
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
    sessions: matching.slice(0, limit).map(cloneSession),
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
  const view = await readStoreView();
  return view.filter(
    (s) => !isTerminalSession(s) && !s.archived,
  ).map(cloneSession);
}

/** This machine's records whose process should be alive, by their status (sessions/live-sessions.ts). */
export async function listLocalLiveSessions(): Promise<SessionRecord[]> {
  const view = await readStoreView();
  return view.filter((s) => !execHostOf(s) && !s.archived && (s.process_status === 'running' || s.process_status === 'idle')).map(cloneSession);
}

/** Default session limits: local=7, any remote host=20. */
const DEFAULT_LOCAL_LIMIT = 7;
const DEFAULT_REMOTE_LIMIT = 20;

/** The running-session limit of a host ('local' or an alias): config first, then the defaults. */
export function activeSessionLimitFor(host: string | undefined | null, sessionLimits?: Record<string, number>): number {
  const key = host || 'local';
  return Math.max(1, sessionLimits?.[key]
    ?? (key === 'local' ? DEFAULT_LOCAL_LIMIT : key === CLOUD_BOX_HOST_ALIAS ? CLOUD_BOX_DEFAULT_LIMIT : DEFAULT_REMOTE_LIMIT));
}

/** How long one liveness scan may take (livenessOfAll): a host load's own probe waits as long. */
export const LIVENESS_SCAN_DEADLINE_MS = 4_000;

/** One running-session scan at a time per host filter: callers that ask meanwhile share it. */
const activeScans = new Map<string, Promise<Record<string, SessionRecord[]>>>();

/**
 * Each of `candidates` alive or not (isSessionProcessAlive), in order, LIVENESS_PROBE_CONCURRENCY
 * at once: every scan that judges many sessions' processes asks through here, never in a loop of
 * awaits (tests/core/session-liveness-scan-guard.test.ts). The whole scan answers within
 * `deadlineMs`: a session not answered by then reads alive, the state its record already says,
 * never a death, and no probe starts after it (on a link that answers in 3 s, 38 sessions in
 * waves of 8 took about 15 s, past a caller's own 10 s limit).
 */
export async function livenessOfAll(
  candidates: readonly SessionRecord[], deadlineMs = LIVENESS_SCAN_DEADLINE_MS,
): Promise<boolean[]> {
  const verdicts: Array<boolean | undefined> = new Array(candidates.length);
  let over = false;
  const work = mapLimit(candidates, LIVENESS_PROBE_CONCURRENCY, async (s, i) => {
    if (over) return;
    verdicts[i] = await isSessionProcessAlive(s);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([
    work.then(() => false),
    new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), deadlineMs); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (late) {
    over = true;
    work.catch(() => { /* a probe that fails after the deadline changes nothing here */ });
    log.session.info('liveness scan: past its deadline, the sessions not answered keep their state', {
      sessions: candidates.length, unanswered: verdicts.filter((v) => v === undefined).length, deadlineMs,
    });
  }
  return candidates.map((_, i) => verdicts[i] ?? true);
}


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
export async function getActiveSessionsByHost(opts: { hosts?: readonly string[] } = {}): Promise<Record<string, SessionRecord[]>> {
  // `hosts`: only these hosts' sessions ('local' or an alias), so a start's admission on one host
  // does not wait on another host's link. Concurrent callers of the same scan share it: k scans
  // at once would put k times the probes on one link.
  const only = opts.hosts ? new Set(opts.hosts) : null;
  const key = only ? [...only].sort().join('\n') : '*';
  let scan = activeScans.get(key);
  if (!scan) {
    scan = scanActiveSessions(only).finally(() => activeScans.delete(key));
    activeScans.set(key, scan);
  }
  const result = await scan;
  return Object.fromEntries(Object.entries(result).map(([k, list]) => [k, list.slice()]));
}

async function scanActiveSessions(only: ReadonlySet<string> | null): Promise<Record<string, SessionRecord[]>> {
  // ⚠️ DESIGN DEBT (see readStore): this materializes ALL ~5000+ rows then keeps
  // only the ~4 'running' ones — 99.9% wasted. Correct shape is
  // `SELECT * FROM sessions WHERE process_status='running'` (indexed) + a
  // narrowed liveness check. Left as a full scan for now; the readStore cache
  // makes the repetition cheap but not free.
  const candidates = (await readStoreView()).filter((s) => {
    if (s.archived) return false;
    if (s.process_status !== 'running') return false;
    // Embedded/SDK sessions have no OS process — don't count toward host limits
    if (s.provider === 'embedded' || s.provider === 'sdk') return false;
    // Side threads are hidden asides of another session: they must not occupy a
    // capacity slot, and they must not be the reason a host is kept awake.
    // Prefix literal = SIDE_LANE_PREFIX (side-thread-fork.ts, which imports
    // this module — importing back would be circular).
    if (s.lane?.startsWith('side:')) return false;
    return !only || only.has(s.host || 'local');
  }).map(cloneSession);
  const result: Record<string, SessionRecord[]> = {};
  const staleIds: SessionRecord[] = [];
  const alive = await livenessOfAll(candidates);
  candidates.forEach((s, i) => {
    if (!alive[i]) {
      staleIds.push(s);
      return;
    }
    const key = s.host || 'local';
    (result[key] ??= []).push(s);
  });
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
  const candidates = (await readStoreView()).filter((s) => {
    if (s.archived) return false;
    if (s.process_status === 'stopped' || (s.process_status === 'error' && s.pid == null)) return false;
    // Embedded/SDK sessions have no OS process: they don't count toward host limits
    if (s.provider === 'embedded' || s.provider === 'sdk') return false;
    return true;
  }).map(cloneSession);
  const result: Record<string, SessionRecord[]> = {};
  const staleIds: SessionRecord[] = [];
  const alive = await livenessOfAll(candidates);
  candidates.forEach((s, i) => {
    if (!alive[i]) {
      staleIds.push(s);
      return;
    }
    const key = s.host || 'local';
    (result[key] ??= []).push(s);
  });
  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }
  return result;
}

/**
 * When each stale record was last repaired (sid → ms). The callers run every few
 * seconds (the capacity check on every send, both alive-by-host reads), and a repair
 * does not always land at once: for a session the snapshot projection owns
 * (enforce mode), the gate drops this legacy write whole and only the host's own
 * snapshot can move the record. Without this map that drop repeated the repair, and
 * its warning, every 5 seconds until the projection caught up (157 lines in one
 * hour for one dead remote CLI, 2026-11-12).
 */
const staleRepairAt = new Map<string, { repairAt: number; warnAt: number; recheckAt: number }>();
/** Gap between repairs of one record: the cadence of the health monitor's pull. */
const STALE_REPAIR_GAP_MS = 30_000;
/** One warning per record this often: a new episode, or one that has not ended. */
const STALE_WARN_GAP_MS = 10 * 60_000;
/** Gap between host rechecks of one record. The first repair asks at once; after
 *  that the health monitor's own pull asks every 30s, and each recheck logs its
 *  outcome (a choked link logs a timeout warning), so a stale path asking on the
 *  repair cadence would bring the flood back in other words. */
const STALE_RECHECK_GAP_MS = 5 * 60_000;

/**
 * Asynchronously correct stale session records whose process has exited
 * but process_status is still 'running'. Fire-and-forget — callers
 * don't need to wait for this; the returned results already exclude
 * these sessions.
 *
 * At most one repair per record per 30s and one warning per 10 min; the rest is
 * debug. A record the snapshot projection owns is also re-checked against its host
 * (recheckSession: one getState over the pooled link, applied through
 * applySnapshot, the sanctioned writer), so it converges on the host's word
 * instead of waiting for the health monitor's next pull. The legacy write still
 * goes through the gate, which hands its reason to the projection.
 */
function fixStaleRecords(rows: SessionRecord[]): void {
  // A host replica repairs no copied row: its liveness is the Mac's label, and
  // its rows change only through the copy (sessions/replica-process-guard.ts).
  // The rows of sessions it runs itself are its own to repair.
  // Every caller funnels here (the limit check and both alive-by-host reads).
  // A session its host runs and judges is no row to repair here either: only its host writes it.
  const own = judgedHereRecords(rows.filter((r) => !processActionsRefused(r)));
  if (own.length < rows.length) refuseProcessAction('stale_repair');
  if (own.length === 0) return;
  const sessionIds = own.map((r) => r.claudeSessionId);
  const nowMs = Date.now();
  const ownedByProjection = getSnapshotStatusMode() === 'enforce';
  const warned: string[] = [];
  const quiet: string[] = [];
  const due: string[] = [];
  for (const id of sessionIds) {
    const last = staleRepairAt.get(id) ?? { repairAt: 0, warnAt: 0, recheckAt: 0 };
    if (nowMs - last.repairAt < STALE_REPAIR_GAP_MS) continue;
    const next = { ...last, repairAt: nowMs };
    if (nowMs - last.warnAt >= STALE_WARN_GAP_MS) { next.warnAt = nowMs; warned.push(id); } else quiet.push(id);
    if (ownedByProjection && isSnapshotCovered(id) && nowMs - last.recheckAt >= STALE_RECHECK_GAP_MS) {
      next.recheckAt = nowMs;
      recheckStaleRecord(id);
    }
    // Re-inserted so the cap evicts the record repaired longest ago, not the first seen.
    staleRepairAt.delete(id);
    putBoundedEntry(staleRepairAt, id, next, 500);
    due.push(id);
  }
  if (due.length === 0) return;
  if (warned.length > 0) log.session.warn('fixing stale records', { count: warned.length, ids: warned });
  if (quiet.length > 0) log.session.debug('fixing stale records again', { count: quiet.length, ids: quiet });
  const now = new Date(nowMs).toISOString();
  for (const id of due) {
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

function recheckStaleRecord(sessionId: string): void {
  import('./sessions/session-lifecycle.js')
    .then(({ recheckSession }) => recheckSession(sessionId))
    .catch((err) => log.session.debug('stale record: host recheck failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    }));
}

/** Test hook: forget the repair cadence. */
export function _resetStaleRepairForTests(): void {
  staleRepairAt.clear();
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
 *      When exceeded, the oldest idle session is stopped through its daemon
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
  // The cloud box is a small instance shared with the companion itself: its
  // defaults are the cloud-exec ones, not a dev box's (session_limits wins).
  const cloudBox = key === CLOUD_BOX_HOST_ALIAS;
  const rawLimit = sessionLimits?.[key]
    ?? (key === 'local' ? DEFAULT_LOCAL_LIMIT : cloudBox ? CLOUD_BOX_DEFAULT_LIMIT : DEFAULT_REMOTE_LIMIT);
  const limit = Math.max(1, rawLimit); // Floor at 1 to prevent zero/negative blocking all sessions

  // Idle limit: from config.session.max_idle, or per-host defaults
  const maxIdle = sessionConfig?.max_idle
    ?? (key === 'local' ? DEFAULT_LOCAL_IDLE_LIMIT : cloudBox ? CLOUD_BOX_DEFAULT_IDLE_LIMIT : DEFAULT_REMOTE_IDLE_LIMIT);

  // Single store read — avoids double-read race and double PID-liveness scan.
  const candidates = (await readStoreView()).filter((s) => {
    if (s.archived) return false;
    if (s.process_status === 'stopped') return false;
    if (s.process_status === 'error' && s.pid == null) return false;
    // Embedded/SDK sessions have no OS process: they don't count toward host limits
    if (s.provider === 'embedded' || s.provider === 'sdk') return false;
    // This host's sessions only: another host's are not probed for this host's limit.
    return (s.host || 'local') === key;
  }).map(cloneSession);
  const runningSessions: SessionRecord[] = [];
  const idleSessions: SessionRecord[] = [];
  const staleIds: SessionRecord[] = [];

  const alive = await livenessOfAll(candidates);
  for (const [i, s] of candidates.entries()) {
    if (!alive[i]) {
      staleIds.push(s);
      continue;
    }
    // Lane sessions back a persistent UI surface (a conversation lane), not a
    // user-launched unit of work: they never occupy a capacity slot and are never
    // a CAPACITY-eviction victim here. (The health monitor's idle TIMEOUT still
    // reaps an idle lane CLI by design — the record survives and the next message
    // cold-resumes it with its profile re-applied.) Placed AFTER the liveness
    // check so a dead lane CLI still gets its record repaired by fixStaleRecords.
    if (s.lane) continue;
    if (s.process_status === 'running') {
      runningSessions.push(s);
    } else if (s.process_status === 'idle' || s.process_status === 'error') {
      idleSessions.push(s);
    }
  }

  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }

  // Tier 2: idle limit — auto-evict oldest idle CLI sessions if exceeded
  const evicted: SessionRecord[] = [];

  // A host replica evicts no session: its idle rows are copies, their processes the Mac's
  // (sessions/replica-process-guard.ts). Refused here, before a victim is marked or a stop asked.
  if (maxIdle > 0 && idleSessions.length >= maxIdle && !refuseProcessAction('capacity_eviction')) {
    // Only evict CLI sessions (a daemon holds their process and can stop it).
    // SDK/embedded sessions have no process: evicting them frees nothing.
    // A session its host runs and judges counts toward its machine's limit, but only its host evicts it.
    const evictable = judgedHereRecords(idleSessions)
      .filter(s => s.provider !== 'sdk' && s.provider !== 'embedded')
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt));

    const needToEvict = idleSessions.length - maxIdle + 1; // +1 to make room for one more
    const { stopThroughOwner } = await import('./sessions/owner-stop.js');
    for (const victim of evictable) {
      if (evicted.length >= needToEvict) break;
      log.session.warn('evicting idle session for capacity', { sessionId: victim.claudeSessionId, pid: victim.pid });
      // Mark first: an unmarked kill surfaces as a spurious "init failed" error toast.
      let undoTeardown: (() => void) | undefined;
      try {
        const { sessionRunner } = await import('../providers/claude-code-session.js');
        undoTeardown = sessionRunner.markExpectedTeardown(victim.claudeSessionId, 'capacity_eviction');
      } catch { /* runner unavailable: the stop is still correct */ }
      // The daemon that owns the CLI stops it, by sid; this server never signals
      // a pid it read from a record (it used to SIGINT victim.pid, on every host,
      // from the LOCAL machine). See sessions/owner-stop.ts. A refusal comes back
      // at once (cron supervision, another Walnut's session): keep that session
      // and try the next one. An accepted stop answers once the process has
      // exited, so after a short wait it counts as under way.
      const outcome = await firstAnswer(stopThroughOwner(victim, 'idle', 'capacity_eviction'), EVICTION_ANSWER_WAIT_MS);
      if (outcome === 'refused') {
        undoTeardown?.();
        log.session.info('idle eviction: the owning daemon kept the session', { sessionId: victim.claudeSessionId, host: victim.host });
        continue;
      }
      // 'stopped', 'pending' (being stopped), or 'unreachable'/'unknown': this
      // server can do nothing more now. A CLI left running is a bounded leak: the
      // row keeps its pid, so the orphan sweep asks its daemon again once it is
      // reachable, and the daemon's own idle reaper ends it regardless.
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
  return getSessionByClaudeIdSync(claudeSessionId);
}

export function getSessionByClaudeIdSync(claudeSessionId: string): SessionRecord | null {
  const db = getDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
    | Record<string, any>
    | undefined;
  if (row) return rowToSession(row);
  const away = extraInstalled() ? extraRows().find((r) => r.claudeSessionId === claudeSessionId) : undefined;
  return away ? { ...away } : null;
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
 * EVERY session ever bound to `lane`, archived included, OLDEST FIRST.
 *
 * The companion to {@link getSessionByLane}, which deliberately answers "the one
 * live session to send to" and therefore hides archived rows. A reader of the
 * conversation's HISTORY needs the opposite: when a `--resume` fails with "No
 * conversation found" the record is auto-archived (claude-code-session.ts,
 * `remote_conversation_lost`) and the next turn mints a fresh lane, so the live
 * row holds only the turns since that break — everything the user said before it
 * lives in the archived session's transcript.
 *
 * started_at ASC is the ordering that makes an append-only assembly possible:
 * each lane's transcript is a closed segment, and a new segment can only ever be
 * appended after the ones before it.
 */
export async function listSessionsByLane(lane: string): Promise<SessionRecord[]> {
  if (!lane) return [];
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  // Same json_valid guard as getSessionByLane: SQLite RAISES on malformed JSON,
  // so one corrupt payload row would break every lane lookup.
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE payload IS NOT NULL AND payload != '' AND json_valid(payload)
      AND json_extract(payload, '$.lane') = ?
    ORDER BY started_at ASC
  `).all(lane) as Array<Record<string, any>>;
  return rows.map(rowToSession);
}

/**
 * Every session bound to a Personal AI chat lane (`chat:<agent>:<conversation>`),
 * archived included, oldest first: ONE scan for a pass over all chats, where a
 * listSessionsByLane per conversation would scan the table once each.
 */
export async function listChatLaneSessions(): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE payload IS NOT NULL AND payload != '' AND json_valid(payload)
      AND json_extract(payload, '$.lane') LIKE 'chat:%'
    ORDER BY started_at ASC
  `).all() as Array<Record<string, any>>;
  return rows.map(rowToSession);
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
  return getSessionsForTaskSync(taskId);
}

/**
 * Sessions whose working folder is `dir` or inside it, whatever task they belong to
 * now (a deleted task's sessions are unlinked from it first). Matched on the folder's
 * last two path parts, so a host's other spelling of the same path (/local/home vs
 * /home) still matches.
 */
export async function getSessionsInFolder(dir: string): Promise<SessionRecord[]> {
  await ensureSessionInit();
  const db = getDb();
  const tail = dir.replace(/\/+$/, '').split('/').filter(Boolean).slice(-2).join('/');
  if (!db || !tail.includes('/')) return [];
  const esc = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = db.prepare("SELECT * FROM sessions WHERE cwd LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\'")
    .all(`%/${esc(tail)}`, `%/${esc(tail)}/%`) as Record<string, any>[];
  return rows.map(rowToSession);
}

export function getSessionsForTaskSync(taskId: string): SessionRecord[] {
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM sessions WHERE task_id = ?').all(taskId) as Record<string, any>[];
  const found = rows.map(rowToSession);
  return extraInstalled() ? withAway(found, (r) => r.taskId === taskId) : found;
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

export async function listSessionsForTaskHandback(taskIds: string[]): Promise<SessionRecord[]> {
  if (!taskIds.length) return [];
  await ensureSessionInit();
  const db = getDb();
  if (!db) return [];
  const sessions: SessionRecord[] = [];
  const ids = [...new Set(taskIds)];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const rows = db.prepare(`
      SELECT * FROM sessions INDEXED BY sessions_task_id
      WHERE task_id IN (${batch.map(() => '?').join(',')})
        AND archived IS NOT 1 AND process_status IN ('stopped', 'error')
    `).all(...batch) as Record<string, any>[];
    sessions.push(...rows.map(rowToSession));
  }
  return sessions;
}

/**
 * Sessions open on each host by Walnut's own records (`local` for this Mac): a process
 * that is running or idle, not an embedded/SDK session, not a side thread. One indexed
 * read, no liveness probe: the fleet Overview's count when the host's own reading is old
 * (core/hosts/fleet.ts), so it is never a bare "?".
 */
export async function countOpenSessionsByHost(): Promise<Record<string, number>> {
  await ensureSessionInit();
  const db = getDb();
  if (!db) return {};
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(host, ''), 'local') AS host, COUNT(*) AS n FROM sessions
    WHERE archived IS NOT 1 AND process_status IN ('running', 'idle')
      AND (provider IS NULL OR provider NOT IN ('embedded', 'sdk'))
      AND (payload IS NULL OR json_valid(payload) = 0 OR COALESCE(json_extract(payload, '$.lane'), '') NOT LIKE 'side:%')
    GROUP BY 1
  `).all() as Array<{ host: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.host] = Number(r.n) || 0;
  return out;
}

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
  // A session its host runs and judges is its host's to sweep (sessions/session-command-gate.ts).
  return judgedHereRecords(rows.map(rowToSession));
}

/** How long an idle eviction waits for the owning daemon's answer before counting the stop as under way. */
const EVICTION_ANSWER_WAIT_MS = 2_000;

/** `work`'s result, or 'pending' when it has not settled within `ms` (it keeps running). */
async function firstAnswer<T>(work: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Existence probe (signal 0 delivers nothing). EPERM still means the pid exists. */
function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  // A host replica probes nothing: a pid in its copy is a process on the Mac.
  if (refuseProcessAction('pid_probe')) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * EPHEMERAL SERVERS ONLY: clear every pid in the sessions store, before any
 * subsystem reads one. An ephemeral server runs over a snapshot of another
 * Walnut's data, so every pid in it names a process some other daemon spawned,
 * never one this server started. On 2026-09-26 a hand-copied production
 * sessions.sqlite gave an ephemeral server the pids of the user's live CLIs and
 * its orphan sweep killed them.
 *
 * Clear rather than refuse to start: a copied store is a legitimate way to get
 * realistic data into a UI test, and the rows (titles, history, statuses) stay
 * useful; only the pids are wrong for this server, and a null pid says exactly
 * "not a process this server started". `alive` counts the pids that still
 * answered, for the startup warning.
 *
 * The pid is cleared from the column AND from the row's payload JSON: rowToSession
 * starts from the payload and a NULL column does not override it, so a pid left
 * in the payload (a hand-edited or legacy row) would come straight back.
 *
 * Refuses to run on the production data dir (sessions/ephemeral-guard.ts): this
 * rewrites the store, which only an ephemeral server's own copy may take.
 */
export async function scrubInheritedSessionPids(
  isAlive: (pid: number) => boolean = pidExists,
  guard: { home?: string; productionHomes?: readonly string[] } = {},
): Promise<{ scrubbed: number; alive: number }> {
  const { assertEphemeralHomeIsNotProduction } = await import('./sessions/ephemeral-guard.js');
  assertEphemeralHomeIsNotProduction(guard.home ?? WALNUT_HOME, guard.productionHomes);
  await ensureSessionInit();
  const db = getDb();
  if (!db) return { scrubbed: 0, alive: 0 };
  // CASE, not AND: SQLite does not promise short-circuit evaluation, and
  // json_extract on a malformed payload throws.
  const payloadPid = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.pid') END";
  const holdsPid = `pid IS NOT NULL OR ${payloadPid} IS NOT NULL`;
  return withWriteLock(async () => {
    const rows = db.prepare(`SELECT claude_session_id, pid, ${payloadPid} AS payload_pid FROM sessions WHERE ${holdsPid}`)
      .all() as Array<{ claude_session_id: string; pid: unknown; payload_pid: unknown }>;
    let alive = 0;
    for (const row of rows) {
      const pid = typeof row.pid === 'number' ? row.pid : row.payload_pid;
      if (typeof pid === 'number' && isAlive(pid)) alive++;
    }
    if (rows.length > 0) {
      const lockWait = transactionWhenFree((handle) => handle.prepare(
        `UPDATE sessions SET pid = NULL, payload = CASE WHEN ${payloadPid} IS NOT NULL THEN json_remove(payload, '$.pid') ELSE payload END WHERE ${holdsPid}`,
      ).run());
      for (const row of rows) noteSessionRowTouched(row.claude_session_id);
      if (lockWait instanceof Promise) await lockWait;
    }
    return { scrubbed: rows.length, alive };
  });
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
    modeChosen?: boolean;
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
    /** Started with no message: no transcript until its first one (SessionRecord.startedIdle). */
    startedIdle?: boolean;
    engine?: import('./types.js').SessionEngine;
    acpRuntimeId?: string;
    acpJournalPath?: string;
    acpCapabilities?: AcpSessionCapabilities;
    /** Run and judged by its host's own service (sessions/session-row-owner.ts). */
    judge?: 'host';
  },
): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('createSessionRecord: SQLite handle is null');
    }
    return transactionWhenFree((handle) => {
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
        const spawnConfirmed = existing.status_reason === 'awaiting_spawn'
          && extra?.pid != null && !existing.archived && !existing.stopRequest
          && (existing.process_status === 'idle' || existing.process_status === 'running');
        let materialChange = spawnConfirmed;
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
        if (extra?.modeChosen && !existing.modeChosen) materialChange = true;
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
          if (spawnConfirmed) {
            // Snapshot intake excludes reservations until the confirmed PID releases them.
            existing.status_reason = 'session_started';
            existing.status_changed_by = 'session-runner';
            const status = existing.pendingPermission ? 'running' : extra.initialProcessStatus ?? 'running';
            if (existing.process_status !== status) {
              existing.process_status = status;
              existing.last_status_change = now;
            }
          } else if (pidChanged && existing.status_reason !== 'awaiting_spawn') {
            if (existing.process_status !== 'running') {
              existing.process_status = 'running';
              existing.last_status_change = now;
            }
          }
        }
        if (extra?.outputFile) existing.outputFile = extra.outputFile;
        if (extra?.mode) existing.mode = extra.mode;
        if (extra?.modeChosen) existing.modeChosen = true;
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

      // One session per task, for the task's whole life (sessions/one-session-per-task.ts).
      if (taskId) assertTaskSessionFree(handle, taskId, claudeSessionId);
      const record: SessionRecord = {
        claudeSessionId,
        taskId,
        // A task's session says its task's project: the Inbox by name, as the task does.
        project: taskId ? projectOrInbox(project) : project,
        // init-only spawns pass 'idle': the CLI initialized then parked on its
        // FIFO — no turn is running, and defaulting to 'running' left a
        // permanent Running badge until the first real turn ended.
        process_status: extra?.initialProcessStatus ?? 'running',
        mode: extra?.mode ?? 'default',
        ...(extra?.initialStatusReason ? { status_reason: extra.initialStatusReason } : {}),
        ...(extra?.startedIdle ? { startedIdle: true } : {}),
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
        // A row a host that runs its sessions makes on itself is its own from birth (session-db.ts
        // own-row writer): it is never written as a plain row first.
        ...(extra?.judge === 'host' || (extra?.host && extra.host === ownRowHostKey()) ? { judge: 'host' as const } : {}),
        ...(extra?.provider ? { provider: extra.provider } : {}),
        type: extra?.type ?? 'interactive',
        ...(extra?.fromPlanSessionId ? { fromPlanSessionId: extra.fromPlanSessionId } : {}),
        ...(extra?.forkedFromSessionId ? { forkedFromSessionId: extra.forkedFromSessionId } : {}),
        ...(extra?.rewoundAtMessageUuid ? { rewoundAtMessageUuid: extra.rewoundAtMessageUuid } : {}),
        ...(extra?.cliModel ? { cliModel: extra.cliModel } : {}),
        ...(extra?.modeChosen ? { modeChosen: true } : {}),
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
    return transactionWhenFree((handle) => {
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
function writeSessionRowSqlite(
  db: import('../lib/sqlite.js').Database,
  session: SessionRecord,
  // A writer moving an existing record to a new id names the old one, so its history is never read as fresh.
  opts?: { before: SessionHistoryFields },
): void {
  const before = opts ? opts.before : storedHistoryFields(db, session.claudeSessionId);
  if (sessionHistoryWriteNeedsCheck(before, session)) assertSessionHistoryWrite(before, session, taskDbHandle());
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
  noteSessionRowTouched(session.claudeSessionId);
}

/** The stored row's area history fields only (router/history-write.ts), without decoding the whole payload. */
function storedHistoryFields(db: import('../lib/sqlite.js').Database, claudeSessionId: string): SessionHistoryFields | undefined {
  const field = (key: string) => `CASE WHEN json_valid(payload) THEN json_extract(payload, '$.${key}') END AS ${key}`;
  const keys = ['profile', 'engine', 'legacyTaskId', 'fromPlanSessionId', 'forkedFromSessionId', 'rewoundAtMessageUuid', 'engineSwitch', 'resumedBySwitch'];
  const row = db.prepare(`SELECT task_id, host, from_plan_session_id, forked_from_session_id,
    CASE WHEN payload IS NULL OR payload = '' THEN 1 WHEN json_valid(payload) THEN json_type(payload) = 'object' ELSE 0 END AS readable,
    ${keys.map(field).join(', ')} FROM sessions WHERE claude_session_id = ?`)
    .get(claudeSessionId) as Record<string, any> | undefined;
  if (!row) return undefined;
  if (!row.readable) throw new OrgError('router_history_unreadable', 503, `Session ${claudeSessionId}'s policy payload cannot be read. Nothing was written; retry after repairing the store.`);
  const json = (v: unknown) => {
    if (typeof v !== 'string') return v ?? undefined;
    try { return JSON.parse(v); } catch { return v; }
  };
  return {
    claudeSessionId, taskId: row.task_id ?? undefined, host: row.host ?? undefined, engine: row.engine ?? undefined,
    profile: json(row.profile), legacyTaskId: row.legacyTaskId ?? undefined,
    fromPlanSessionId: row.from_plan_session_id ?? row.fromPlanSessionId ?? undefined,
    forkedFromSessionId: row.forked_from_session_id ?? row.forkedFromSessionId ?? undefined,
    rewoundAtMessageUuid: row.rewoundAtMessageUuid ?? undefined,
    engineSwitch: json(row.engineSwitch), resumedBySwitch: json(row.resumedBySwitch),
  } as SessionHistoryFields;
}

/** The one DELETE for a session row: the lock patches the cache from what it notes. */
function deleteSessionRowSqlite(db: import('../lib/sqlite.js').Database, claudeSessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE claude_session_id = ?').run(claudeSessionId);
  noteSessionRowTouched(claudeSessionId);
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
  /**
   * Spawn-time persona for the imported session — a RESUME builds its argv from
   * the record (claude-code-session's resolveResumeArgs), so a session that must
   * wake up as the Personal AI has to carry the profile from the moment it is
   * registered. Set here rather than patched afterwards for the same reason
   * `engine` is: updateSessionRecord bumps lastActiveAt on every write.
   */
  profile?: SessionRecord['profile'];
  effort?: SessionRecord['effort'];
  /**
   * Permission mode the resumed session wakes up in. Same reason `profile` lives
   * here: a RESUME builds its argv from the record, and the two defaults differ —
   * a fresh spawn with no mode starts in 'bypass' (see claude-code-session's
   * `start`), while a resume with no mode on the record falls back to 'default'
   * and prompts Allow/Deny for every tool. So an import of a conversation that
   * ALREADY ran unattended must say so, or continuing it asks permission for
   * work the same session did without asking a minute earlier.
   *
   * Left unset (the default below) for an import of someone's own terminal
   * session: it was run by a human at a prompt, and waking it up with bypass
   * would hand it more than it ever had.
   */
  mode?: SessionRecord['mode'];
  /**
   * Why this record is stopped. Without one, classifySessionError reads
   * 'unknown' and the imported session stays a "rescuable stopped record" for a
   * day — the health monitor and every local-daemon reconnect then spend probe
   * budget on a session no daemon has ever heard of. Pass a terminal reason
   * (e.g. 'normal_completion') when the import is of a conversation that ENDED.
   */
  status_reason?: SessionRecord['status_reason'];
  human_note?: string;
}): Promise<SessionRecord> {
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('importSessionRecord: SQLite handle is null');
    }
    return transactionWhenFree((handle) => {
      const now = new Date().toISOString();
      const record: SessionRecord = {
        claudeSessionId: opts.claudeSessionId,
        taskId: opts.taskId,
        project: opts.taskId ? projectOrInbox(opts.project) : opts.project,
        process_status: 'stopped',
        mode: opts.mode ?? 'default',
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
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.status_reason ? { status_reason: opts.status_reason } : {}),
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
      if (opts.taskId) assertTaskSessionFree(handle, opts.taskId, opts.claudeSessionId);
      // Outside history never joins an area, whatever profile it names.
      assertOutsideHistoryImport(record, taskDbHandle());
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
/**
 * When a record's facts show a model turn ran, else undefined: a turn's speed with a finished message
 * (from its start), the prompt cache facts of a main-loop request (Claude Code), an ACP turn's context.
 */
export function turnEvidenceAt(r: Partial<SessionRecord>): string | undefined {
  const speed = r.lastTurnSpeed;
  if (speed && speed.messages > 0) return new Date(speed.startedAt ?? Date.now()).toISOString();
  if (r.promptCache?.requestAt) return r.promptCache.requestAt;
  if (r.contextTokens != null) return new Date().toISOString();
  return undefined;
}

function applyUpdateToSession(
  session: SessionRecord,
  updates: SessionRecordUpdates,
  logLabel: string,
): boolean {
  updates = withoutStatusVersionOverrides(updates);
  // A host's row is written by its host (sessions/session-row-owner.ts): the leader writes only
  // the leader's fields of it, the owning host only its own.
  // What the leader told a host's session is kept in the leader's own copies (sessions/told-copies.ts).
  if (!isFollower() && judgedByHost(session) && !rowOwnedHere(session, thisHostKey()) && !isWritingAsHost()) {
    updates = toldIntoLeaderCopies(updates as Record<string, unknown>) as SessionRecordUpdates;
  }
  const owned = ownedPartOf(session, updates as Record<string, unknown>);
  if (owned.dropped.length > 0) {
    log.session.warn('session write left out fields another server owns', {
      sessionId: session.claudeSessionId, host: session.host, fields: owned.dropped,
    });
    updates = owned.patch as SessionRecordUpdates;
  }

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

  // When the session's first turn ran, kept once (usage/engine-compare.ts dates and times the work from
  // it, so a CLI that died before its first reply and was resumed later is told from work done then).
  // Only from the first sign of a turn this record ever got: a record that already had one before this
  // field existed keeps none, rather than a later turn's time.
  const firstTurnAt = !session.firstTurnAt && !turnEvidenceAt(session) ? turnEvidenceAt(updates) : undefined;
  // A later final turn adds to the session's per-model speed totals, once (sessions/speed-totals.ts).
  const speedTotals = updates.lastTurnSpeed
    ? foldTurnSpeed(session.speedTotals, updates.lastTurnSpeed)
    : undefined;

  const prevStatus = session.process_status;
  const prevPid = session.pid;
  const now = new Date().toISOString();
  Object.assign(session, updates);
  if (firstTurnAt) session.firstTurnAt = firstTurnAt;
  if (speedTotals) session.speedTotals = speedTotals;

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
    // The history keeps ten moves; a count of errors outlives it (usage/engine-compare.ts reads it).
    if (updates.process_status === 'error') session.errorCount = (session.errorCount ?? 0) + 1;
  }

  // Terminal-state PID clear. Prevents stale PID orphan kills when OS recycles PIDs.
  const livePidSupplied = session.process_status === 'error' && updates.pid != null && updates.pid === session.pid;
  if (updates.process_status !== undefined && isTerminalSession(session) && session.pid != null && !livePidSupplied) {
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
    ((updates.process_status && updates.process_status !== prevStatus) || (prevPid != null && session.pid == null))
    && isTerminalSession(session)
    && !livePidSupplied
    && session.status_reason !== 'remote_unreachable'
  ) {
    expireErrorNotificationsOnDeath(session.claudeSessionId);
  }
  // Walnut's own quiet turn (its idle compaction, sessions/quiet-turn.ts) is no activity of the
  // session's: it would read "just now" and top the recent lists after an hour nobody touched it.
  if (!isQuietTurn(session.claudeSessionId)) session.lastActiveAt = now;
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
  let permissionChanged = false;
  const updated = await withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('updateSessionRecord: SQLite handle is null');
    }

    return transactionWhenFree((handle) => {
      const row = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
        | Record<string, any>
        | undefined;
      if (!row) {
        throw new Error(`Session not found: ${claudeSessionId}`);
      }
      const session = rowToSession(row);
      if (updates.taskId && updates.taskId !== session.taskId) {
        assertTaskSessionFree(handle, updates.taskId, claudeSessionId);
      }
      const searchContentBefore = searchContentProjection(session);
      const permissionBefore = canonicalStatusProjection(session).pendingPermissionTool;

      // No-op guard BEFORE any UPDATE SQL — critical to avoid write-lock storms
      // when the daemon replays identical init/model/pid updates.
      if (!applyUpdateToSession(session, updates, 'clearing stale PID on terminal transition')) {
        return session;
      }

      writeSessionRowSqlite(handle, session);
      permissionChanged = permissionBefore !== canonicalStatusProjection(session).pendingPermissionTool;
      searchContentChanged =
        searchContentBefore !== searchContentProjection(session);
      log.session.info('session record updated', { sessionId: claudeSessionId, fields: Object.keys(updates) });
      return session;
    });
  });
  if (permissionChanged) {
    emitSessionStatusChanged(updated, {}, ['*'], { source: 'session-tracker', urgency: 'urgent' });
  }
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
    const insertCols = [...SESSION_COLUMNS, 'payload'];
    const insertSql =
      'INSERT OR REPLACE INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    const written: string[] = [];
    // Single transaction for the whole batch — one BEGIN/COMMIT instead of N.
    const lockWait = transactionWhenFree((handle) => {
      const selectStmt = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
      const insertStmt = handle.prepare(insertSql);
      for (const id of claudeSessionIds) {
        try {
          const row = selectStmt.get(id) as Record<string, any> | undefined;
          if (!row) continue; // missing row — skip, don't abort the batch
          const session = rowToSession(row);
          const before = storedHistoryFields(handle, id)!;
          // Reuse the shared no-op guard + status_history + terminal PID clear.
          if (!applyUpdateToSession(session, updates, 'clearing stale PID on batch terminal transition')) {
            continue; // no material change — skip write
          }
          // A refusal skips this row like any other row error.
          if (sessionHistoryWriteNeedsCheck(before, session)) assertSessionHistoryWrite(before, session, taskDbHandle());
          const partial = sessionToRow(session);
          const bound: Record<string, unknown> = {};
          for (const col of insertCols) bound[col] = partial[col] === undefined ? null : partial[col];
          insertStmt.run(bound);
          noteSessionRowTouched(id);
          written.push(id);
        } catch (err) {
          // One poisoned row must not roll back the other ~292.
          log.session.warn('batchUpdateSessionRecords: row failed (skipped)', {
            sessionId: id, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    if (lockWait instanceof Promise) await lockWait;
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
  // setLastActiveAt: write this activity time instead of "now" (a clock read
  // from the transcript, e.g. the importer learning an external session is
  // still in use). Wins over preserveLastActiveAt.
  options?: { preserveLastActiveAt?: boolean; setLastActiveAt?: string },
): Promise<SessionRecord | null> {
  await ensureSessionInit();
  let searchContentChanged = false;
  let permissionChanged = false;
  const updated = await withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('updateSessionRecordConditionally: SQLite handle is null');
    }

    return transactionWhenFree((handle) => {
      const row = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
        | Record<string, any>
        | undefined;
      if (!row) return null;
      const session = rowToSession(row);

      if (!shouldUpdate(session)) return null;
      const lastActiveAt = session.lastActiveAt;
      const contentBefore = searchContentProjection(session);
      const permissionBefore = canonicalStatusProjection(session).pendingPermissionTool;

      const applied = applyUpdateToSession(session, updates, 'clearing stale PID on terminal transition (conditional)');
      // An explicit activity time is a change of its own, even with no field patch.
      if (!applied && !options?.setLastActiveAt) return session;
      if (options?.preserveLastActiveAt) session.lastActiveAt = lastActiveAt;
      if (options?.setLastActiveAt) session.lastActiveAt = options.setLastActiveAt;
      searchContentChanged = contentBefore !== searchContentProjection(session);
      writeSessionRowSqlite(handle, session);
      permissionChanged = permissionBefore !== canonicalStatusProjection(session).pendingPermissionTool;
      log.session.info('session record updated (conditional)', { sessionId: claudeSessionId, fields: Object.keys(updates) });
      return session;
    });
  });
  if (updated && permissionChanged) {
    emitSessionStatusChanged(updated, {}, ['*'], { source: 'session-tracker', urgency: 'urgent' });
  }
  if (searchContentChanged) {
    bus.emit(EventNames.SESSION_CONTENT_UPDATED, { sessionId: claudeSessionId }, ['*'], { source: 'session-tracker' });
  }
  return updated;
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
    return transactionWhenFree((handle) => {
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
      const historyBefore = storedHistoryFields(handle, oldClaudeSessionId)!;
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
      if (sessionHistoryWriteNeedsCheck(historyBefore, session)) assertSessionHistoryWrite(historyBefore, session, taskDbHandle());

      // Delete old PK + insert under new PK in one transaction so a crash mid-rename
      // can't leave both rows orphaned. INSERT OR REPLACE with the new PK won't
      // clean up the old row on its own.
      deleteSessionRowSqlite(handle, oldClaudeSessionId);
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
      noteSessionRowTouched(newClaudeSessionId);
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
    return transactionWhenFree((handle) => {
      const oldRow = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?')
        .get(oldClaudeSessionId) as Record<string, any> | undefined;
      if (!oldRow) return null;
      const conflict = handle.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?')
        .get(newClaudeSessionId);
      if (conflict) return null;

      const oldRecord = rowToSession(oldRow);
      const historyBefore = storedHistoryFields(handle, oldClaudeSessionId)!;
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
      writeSessionRowSqlite(handle, replacement, { before: historyBefore });
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
    return transactionWhenFree((handle) => {
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
      deleteSessionRowSqlite(handle, newClaudeSessionId);
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
  const before = (await getSessionByClaudeId(claudeSessionId))?.statusRevision;
  const updated = await updateSessionRecord(claudeSessionId, { taskId });
  // The task is part of the status projection: a link that moved the revision
  // is announced like any other status change, so a page holding the old
  // snapshot hears the new task instead of keeping the old one.
  if (updated.statusRevision !== before) {
    emitSessionStatusChanged(updated, {}, ['*'], { source: 'session-tracker' });
  }
}

/**
 * What one retask slice may hold the event loop for: its transaction, the
 * cache patch at its lock's release, and its announcements, which cost the most
 * (two events per session, each sent to every socket). A bulk delete has no
 * count limit (POST /api/v1/tasks/batch/delete), so the work is split, never
 * capped: one block over 2000 sessions held the loop 228 ms (r3 gate, L-18).
 * The first slice is small; each next one is sized by what the last cost per
 * session, because rows run from a few to tens of KB.
 */
const RETASK_SLICE_DEFAULT_MS = 8;
const RETASK_FIRST_SLICE_ROWS = 25;
/** How many times a retask reads the linked ids (the first read, then re-reads for links made meanwhile). */
const RETASK_MAX_READS = 4;
let RETASK_SLICE_MS = RETASK_SLICE_DEFAULT_MS;
/** Test knob: the slice budget (0 = one row per slice); null restores the default. */
export function _setRetaskSliceMsForTesting(ms: number | null): void {
  RETASK_SLICE_MS = ms ?? RETASK_SLICE_DEFAULT_MS;
}
/** The clock a slice's cost is read on (performance.now). */
let retaskClock: () => number = () => performance.now();
/** Test knob: the clock a slice's cost is read on; null restores performance.now. */
export function _setRetaskClockForTesting(clock: (() => number) | null): void {
  retaskClock = clock ?? (() => performance.now());
}
/** Test knob: run `fn` under the session write lock, as a writer that holds it across an await. */
export function _withSessionWriteLockForTesting<T>(fn: () => Promise<T>): Promise<T> {
  return withWriteLock(fn);
}

/**
 * Point every session linked to one of `fromTaskIds` at `taskId` (undefined =
 * no task), as a status change. The task is part of the status projection
 * (canonicalStatusProjection), so each row's revision moves and the row is
 * announced (announceRetaskedSessions). Until 2026-10-11 delete and merge
 * rewrote task_id with a raw UPDATE that kept the revision: a page that held the
 * old snapshot then refused the record's "no task" as an equal-revision conflict
 * and kept the deleted task's controls live for good. lastActiveAt stays: a task
 * going away is not activity in the session.
 *
 * The rows go in slices, each its own locked transaction, cache patch and
 * announcement, with a turn of the event loop between them (RETASK_SLICE_MS).
 * Each slice reads its rows again and skips one linked elsewhere since the ids
 * were read. Only the three columns that change are written (the payload stays
 * as stored), with one statement per slice. Returns how many sessions it
 * pointed at `taskId` and how many it left with no task.
 *
 * Others write between the slices, so once the ids run out they are read again,
 * and the rows linked to a `from` task meanwhile go too (a session started for
 * the deleted task, or a merge into it), up to RETASK_MAX_READS reads.
 * `targetExists` (a merge) is asked inside every slice's transaction: once the
 * survivor is deleted, its links are cleared instead. That delete's own unlink
 * reads the ids only after its task is gone, so a slice either wrote before
 * that read or sees the task gone, and no session ends up on a deleted task
 * (r4 gate, L-23: 59 of 60 did when the survivor was deleted between slices).
 */
async function retaskSessionRows(
  fromTaskIds: readonly string[],
  taskId: string | undefined,
  targetExists?: () => boolean,
): Promise<{ pointed: number; cleared: number }> {
  await ensureSessionInit();
  const from = new Set(fromTaskIds.filter(Boolean));
  if (from.size === 0) return { pointed: 0, cleared: 0 };
  const list = [...from];
  const readIds = () => withWriteLock(async () => {
    const db = getDb();
    if (!db) return [] as string[];
    return db.prepare(`SELECT claude_session_id FROM sessions WHERE task_id IN (${list.map(() => '?').join(', ')})`)
      .pluck().all(...list) as string[];
  });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  let target = taskId;
  let pointed = 0;
  let cleared = 0;
  let sliced = false;
  let rows = RETASK_SLICE_MS > 0 ? RETASK_FIRST_SLICE_ROWS : 1;
  for (let reads = 0; reads < RETASK_MAX_READS; reads++) {
    // A re-read comes after a turn of the loop, as every slice after the first does.
    if (reads > 0) await turn();
    const ids = await readIds();
    if (ids.length === 0) break;
    let next = 0;
    while (next < ids.length) {
      if (sliced) await turn();
      sliced = true;
      const chunk = ids.slice(next, next + rows);
      next += chunk.length;
      // The cost is timed from the lock on: a wait behind other writers is not this slice's work.
      let began = retaskClock();
      const sessions = await withWriteLock(async () => {
        began = retaskClock();
        const db = getDb();
        if (!db) return [] as SessionRecord[];
        const now = new Date().toISOString();
        return transactionWhenFree((handle) => {
          if (target && targetExists && !targetExistsNow(targetExists, target)) {
            log.session.warn('merge survivor deleted while its sessions were re-pointed: clearing their links', {
              fromTaskIds: list, toTaskId: target,
            });
            target = undefined;
          }
          const read = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
          const write = handle.prepare(
            'UPDATE sessions SET task_id = ?, status_revision = ?, status_updated_at = ? WHERE claude_session_id = ?',
          );
          const out: SessionRecord[] = [];
          for (const id of chunk) {
            const row = read.get(id) as Record<string, any> | undefined;
            if (!row || !from.has(row.task_id)) continue;
            const session = rowToSession(row);
            const before = canonicalStatusProjection(session);
            const historyBefore = storedHistoryFields(handle, id)!;
            // A survivor that already has its session takes no second one: the
            // merge refuses that case up front, so a row met here lost a race and
            // is left with no task rather than break one-session-per-task.
            const taken = target ? otherTaskSessionId(handle, target, id) : null;
            if (taken) {
              log.session.warn('retask: target task already has its session; leaving this one unlinked', {
                sessionId: id, toTaskId: target, existingSessionId: taken,
              });
            }
            // No task is a NULL column, as rows with no link have always been stored.
            if (target && !taken) session.taskId = target;
            else delete (session as Partial<SessionRecord>).taskId;
            if (sessionHistoryWriteNeedsCheck(historyBefore, session)) {
              try {
                assertSessionHistoryWrite(historyBefore, session, taskDbHandle());
              } catch (err) {
                // An area conversation is never left with no task: it keeps its (deleted) task's id.
                if (!session.taskId && isHistoryRefusal(err)) {
                  log.session.warn('retask: area conversation kept on its task', { sessionId: id, fromTaskId: row.task_id });
                  continue;
                }
                throw err;
              }
            }
            commitStatusVersion(session, before, now);
            write.run(session.taskId ?? null, session.statusRevision, session.statusUpdatedAt, session.claudeSessionId);
            noteSessionRowTouched(session.claudeSessionId);
            out.push(session);
          }
          return out;
        });
      });
      announceRetaskedSessions(sessions);
      for (const session of sessions) {
        if (target && session.taskId === target) pointed++;
        else cleared++;
      }
      // Size the next slice to the budget by this one's cost per row, announcements
      // included (at most four times as many).
      const spent = Math.max(retaskClock() - began, 0.1);
      rows = Math.max(1, Math.min(rows * 4, Math.floor((chunk.length * RETASK_SLICE_MS) / spent)));
    }
  }
  return { pointed, cleared };
}

/** A merge's survivor check. A check that throws keeps the survivor: the rows
 *  then follow it, as before the check existed, rather than stay on the victim. */
function targetExistsNow(targetExists: () => boolean, taskId: string): boolean {
  try {
    return targetExists();
  } catch (err) {
    log.session.warn('merge survivor check failed; re-pointing to it anyway', {
      toTaskId: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** The committed rows of a retask slice, announced after its lock: a status
 *  snapshot for every page and consumer, and a search re-sync (the task is part
 *  of the indexed session too, as in updateSessionRecord). */
function announceRetaskedSessions(sessions: readonly SessionRecord[]): void {
  for (const session of sessions) {
    emitSessionStatusChanged(session, {}, ['*'], { source: 'session-tracker' });
    bus.emit(
      EventNames.SESSION_CONTENT_UPDATED,
      { sessionId: session.claudeSessionId },
      ['*'],
      { source: 'session-tracker' },
    );
  }
}

/**
 * Clear the task link on every session that points at one of the given task
 * ids. Called by task deletion (deleteTask / deleteTasksByIds / deleteTasksBulk)
 * so a removed task never leaves dangling session.task_id pointers — a sweep on
 * 2026-08-20 found 275 sessions orphaned this way, each invisible on its
 * task's session list forever after.
 */
export async function unlinkSessionsFromTasks(taskIds: string[]): Promise<number> {
  if (!taskIds.length) return 0;
  const { cleared: unlinked } = await retaskSessionRows(taskIds, undefined);
  if (unlinked > 0) {
    log.session.info('cleared task links for deleted tasks', {
      taskIds, sessionsUnlinked: unlinked,
    });
  }
  return unlinked;
}

/**
 * Re-point every session linked to `fromTaskId` at `toTaskId`. The merge-side
 * sibling of unlinkSessionsFromTasks: when duplicate tasks are merged, the
 * victims' sessions must FOLLOW the surviving task, never be dropped — dedup
 * cleanups that deleted the copy holding the links are how sessions went
 * invisible (35 tasks lost their links before 2026-08-20). A status change
 * like the unlink (retaskSessionRows). `toTaskExists` says, synchronously,
 * whether the survivor still exists (the merge passes a read of the task DB):
 * the rows move in slices, and a delete of the survivor between them must not
 * leave the rest pointing at it (those are left with no task). Returns how many
 * sessions it pointed at the survivor.
 */
export async function relinkSessionsToTask(
  fromTaskId: string,
  toTaskId: string,
  opts?: { toTaskExists?: () => boolean },
): Promise<number> {
  if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return 0;
  const { pointed, cleared } = await retaskSessionRows([fromTaskId], toTaskId, opts?.toTaskExists);
  if (pointed > 0 || cleared > 0) {
    log.session.info('re-pointed session task links to merge survivor', {
      fromTaskId, toTaskId, sessionsRelinked: pointed, sessionsClearedSurvivorDeleted: cleared,
    });
  }
  return pointed;
}

/**
 * Mark all sessions in the given list as completed.
 * Skips sessions that are already in a terminal state (completed/error).
 * Also asks the owning daemon to stop each CLI that still had a pid
 * (best-effort, fire-and-forget). Returns the number of sessions actually updated.
 */
export async function completeTaskSessions(
  sessionIds: string[],
  // The session whose API call completed the task. Mid-turn (its record
  // 'running'), it is stopped when that turn ends instead
  // (sessions/self-complete-stop.ts).
  // `gentle`: a pass that did not just decide the completion (the boot pass, a later write to the
  // complete task): a session its host judges is asked to stop at its turn's end, never mid-turn.
  // That holds an idle session with background work too, up to the turn-end wait's limit (24 h,
  // SELF_COMPLETE_STOP_MAX_MS), where such a pass used to stop it at once.
  opts?: { actorSid?: string; gentle?: boolean },
): Promise<number> {
  if (!sessionIds.length) return 0;
  await ensureSessionInit();
  return withWriteLock(async () => {
    const db = getDb();
    if (!db) {
      throw new Error('completeTaskSessions: SQLite handle is null');
    }
    const now = new Date().toISOString();
    let updated = 0;
    // The in-memory session must be told the stop is intentional BEFORE it lands,
    // or its liveness monitor reports the exit as "session init failed" (a red
    // toast on every task you mark done, 2026-08-10). host picks the owning daemon.
    const pidsToKill: { sid: string; host?: string }[] = [];
    // An ACP session has no pid: its worker is a daemon child keyed by its runtime
    // id (2026-11-01: completing a task left its OpenCode worker generating on the
    // only Ollama slot, so the next session waited behind it).
    const acpToStop: Pick<SessionRecord, 'claudeSessionId' | 'host' | 'acpRuntimeId'>[] = [];
    const toReap: { claudeSessionId: string; host?: string }[] = [];
    // Each row this marks stopped, announced once the write commits: a status change no
    // subscriber hears leaves them reading it as alive (2026-11-14: a completed task's
    // isolated workspace waited for its session's stop, which never came, and stayed).
    const stoppedRows: SessionRecord[] = [];
    let stopAtTurnEnd: string | undefined;
    // A stop the owner cannot receive now is not written as done (2026-11-18: the boot
    // migration wrote a live session stopped while its host was not connected yet, and
    // the stop it sent reached nothing). Such a row keeps its state, and its stop is
    // sent when the host connects (sessions/task-complete-stop.ts).
    const unreachable = await unreachableOwnerHosts(db, sessionIds);
    const liveAcp = unreachable.size > 0 ? await liveAcpSessionIds(sessionIds) : new Set<string>();
    const undelivered: string[] = [];
    const rearm: { sid: string; since: number }[] = [];
    const nowMs = Date.parse(now);
    // Sessions their host runs and judges: stopped by that host, their row untouched here (R2-M3).
    const hostStops: HostCompletionStop[] = [];
    const hereKey = thisHostKey();

    const insertCols = [...SESSION_COLUMNS, 'payload'];
    const insertSql =
      'INSERT OR REPLACE INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    // A worker this server holds live is stopped here, whatever its host's link says.
    const ownerUnreachable = (session: SessionRecord) => unreachable.has(cliHostOf(session))
      && !(session.pid == null && liveAcp.has(session.claudeSessionId));

    const lockWait = transactionWhenFree((handle) => {
      const sel = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
      const ins = handle.prepare(insertSql);
      const writeRow = (session: SessionRecord) => {
        const partial = sessionToRow(session);
        const bound: Record<string, unknown> = {};
        for (const col of insertCols) bound[col] = partial[col] === undefined ? null : partial[col];
        ins.run(bound);
        noteSessionRowTouched(session.claudeSessionId);
      };
      // A row whose only change is its taskCompleteStop marker: no status moved.
      const writeMarker = (session: SessionRecord, marker: SessionRecord['taskCompleteStop']) => {
        session.taskCompleteStop = marker;
        writeRow(session);
      };
      for (const sid of sessionIds) {
        const row = sel.get(sid) as Record<string, any> | undefined;
        if (!row) continue;
        const session = rowToSession(row);
        if (judgedByHost(session) && !rowOwnedHere(session, hereKey)) {
          if (isTerminalSession(session) || (session.process_status === 'stopped' && session.pid == null)) continue;
          // This pass decided nothing new, and an ask is on its way, or its host, which takes the stop
          // itself, keeps it on its own row already (host-judged-complete.ts). A new decision asks
          // again, behind one on its way (the host takes it once: its marker may be one it dropped since), and the marker
          // of a host that went back to an older Walnut is not read: that host is handed the stop.
          if (opts?.gentle && completionAskPending(sid)) continue;
          if (opts?.gentle && session.taskCompleteStop?.state === 'turn_end' && hostCompleteStopState(session.host!) === 'takes') continue;
          // It completed its own task mid-turn: it stops when that turn ends, as does any session a
          // pass that did not just decide the completion finds live.
          const midTurnActor = !!opts?.actorSid && (sid === opts.actorSid || session.acpRuntimeId === opts.actorSid) && session.process_status === 'running';
          const when = midTurnActor || opts?.gentle ? 'turn_end' : 'now';
          hostStops.push({ sid, host: session.host!, when });
          if (when === 'now') updated++;
          continue;
        }
        initializeStatusVersion(session);
        const beforeStatus = canonicalStatusProjection(session);
        const marker = session.taskCompleteStop;
        const converged = (isTerminalSession(session) || session.process_status === 'stopped') && session.pid == null;
        // A stop that already happened another way needs no marker; one whose send
        // failed on the way (recorded stopped, marker 'undelivered') keeps it for the host.
        if (converged && marker?.state === 'turn_end') writeMarker(session, undefined);
        if (isTerminalSession(session) && session.pid == null) continue;
        // Already-converged record: stopped with no PID — rewriting it is pure
        // churn. 'stopped' is not terminal per isTerminalSession (only 'error'
        // is), so without this skip every server boot re-wrote the same ~1000
        // rows in one synchronous transaction (~6s event-loop stall right after
        // listen, queueing the browser's first requests behind it).
        if (session.process_status === 'stopped' && session.pid == null) continue;
        const hasCli = session.pid != null && session.provider !== 'embedded' && session.provider !== 'sdk';
        const hasAcpWorker = session.pid == null && isAcpEngine(session.engine) && !!session.acpRuntimeId;
        // An ACP session calls the API under its worker's runtime id, not the record's id.
        const isActor = !!opts?.actorSid && (sid === opts.actorSid || session.acpRuntimeId === opts.actorSid);
        // It completed its own task and waits for its turn's end: that wait stops it,
        // after a restart too (its deadline bounds a stale marker).
        if (!isActor && marker?.state === 'turn_end' && nowMs - Date.parse(marker.at) < SELF_COMPLETE_STOP_MAX_MS) continue;
        if ((hasCli || hasAcpWorker) && isActor && session.process_status === 'running') {
          stopAtTurnEnd = sid;
          if (marker?.state !== 'turn_end') writeMarker(session, { at: now, state: 'turn_end' });
          continue;
        }
        // It completed its own task and its stop could not be sent: now that the host is
        // back, it still waits for its turn's end, whoever completes the task again.
        if (!isActor && (hasCli || hasAcpWorker) && marker?.state === 'undelivered' && marker.actor
            && !ownerUnreachable(session)) {
          writeMarker(session, { at: marker.at, state: 'turn_end' });
          rearm.push({ sid, since: Date.parse(marker.at) });
          continue;
        }
        if ((hasCli || hasAcpWorker) && ownerUnreachable(session)
            && (marker?.state !== 'undelivered' || undeliveredHolds(marker, nowMs))) {
          if (marker?.state !== 'undelivered' || (isActor && !marker.actor)) {
            const actor = isActor || (marker?.state === 'undelivered' && marker.actor);
            writeMarker(session, { at: marker?.state === 'undelivered' ? marker.at : now, state: 'undelivered', ...(actor ? { actor: true } : {}) });
          }
          undelivered.push(sid);
          continue;
        }
        if (hasCli) {
          pidsToKill.push({ sid: session.claudeSessionId, host: session.host });
        }
        if (hasAcpWorker) {
          acpToStop.push({ claudeSessionId: session.claudeSessionId, host: session.host, acpRuntimeId: session.acpRuntimeId });
        }
        toReap.push({ claudeSessionId: session.claudeSessionId, host: session.host });
        session.process_status = 'stopped';
        // Stamp the INTENT before the stop below lands: the death snapshot the
        // daemon folds after our kill has no clean result tail (the CLI can die
        // mid-turn, e.g. a task completed from the board while its session works)
        // and projects 'error'. The snapshot applier honors a durable
        // intentional-teardown reason and keeps the label 'stopped' (2026-08-23:
        // compare-task session showed red Error after finishing its work and
        // completing its task).
        session.status_reason = 'expected_teardown';
        session.status_changed_by = 'system';
        if (session.pid != null) {
          log.session.info('clearing stale PID on task completion', { sessionId: sid, pid: session.pid });
        }
        session.pid = undefined;
        session.taskCompleteStop = undefined;
        session.last_status_change = now;
        session.lastActiveAt = now;
        commitStatusVersion(session, beforeStatus, now);
        // history-write exempt: status, reason, pid and activity times only, read from this row.
        writeRow(session);
        stoppedRows.push(session);
        updated++;
      }
    });
    if (lockWait instanceof Promise) await lockWait;
    for (const session of stoppedRows) emitSessionStatusChanged(session, {}, ['*'], { source: 'session-tracker' });
    if (hostStops.length > 0) {
      const atTurnEnd = hostStops.filter((h) => h.when === 'turn_end').length;
      log.session.info('completing task sessions: their hosts stop the sessions they run', {
        sessionIds: hostStops.map((h) => `${h.sid}:${h.when}`).join(','), now: hostStops.length - atTurnEnd, atTurnEnd,
      });
      stopHostRunForCompletion(hostStops);
    }
    // Still under the lock every record write takes: the status write that
    // ends this turn lands after the wait is registered.
    if (stopAtTurnEnd) {
      stopWhenTurnEnds(stopAtTurnEnd);
      log.session.info('self-completing session stops when its turn ends', { sessionId: stopAtTurnEnd });
    }
    for (const r of rearm) stopWhenTurnEnds(r.sid, Number.isFinite(r.since) ? r.since : Date.now());
    if (undelivered.length > 0) {
      log.session.info('completing task sessions: host not connected, record kept and stop sent when it connects', { sessionIds: undelivered.join(','), count: undelivered.length });
      // A host that connected while this pass read: its connect's flush may have looked before
      // these markers landed, so flush it once more after the lock is released.
      void recheckUndeliveredHosts([...unreachable]);
    }
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
      // The daemon that owns each CLI stops it; this server never signals a pid
      // it read from a record. It used to SIGINT each pid from the LOCAL machine,
      // remote hosts' pids included, and at startup this ran over every completed
      // task, so a server holding a copy of another server's database signalled
      // that server's live CLIs. See sessions/owner-stop.ts.
      if (pidsToKill.length > 0) {
        const { stopThroughOwner } = await import('./sessions/owner-stop.js');
        for (const target of pidsToKill) {
          void stopThroughOwner({ claudeSessionId: target.sid, host: target.host }, 'maintenance', 'task_completed')
            .then((outcome) => outcome === 'unreachable' || outcome === 'unknown' ? noteStopUndelivered(target.sid, outcome) : undefined)
            .catch(() => {});
        }
      }
      if (acpToStop.length > 0) void stopAcpWorkers(acpToStop);
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

/** Stop each ACP worker of a completed task: the live session in this server, else through its host's daemon. */
async function stopAcpWorkers(rows: Pick<SessionRecord, 'claudeSessionId' | 'host' | 'acpRuntimeId'>[]): Promise<void> {
  const { sessionRunner } = await import('../providers/claude-code-session.js');
  const { stopAcpThroughOwner } = await import('./sessions/owner-stop.js');
  for (const row of rows) {
    try {
      const live = sessionRunner.findAcpSession(row.claudeSessionId);
      if (live) await live.gracefulStop();
      else {
        const outcome = await stopAcpThroughOwner(row, 'task_completed');
        if (outcome === 'unreachable' || outcome === 'unknown') await noteStopUndelivered(row.claudeSessionId, outcome);
      }
    } catch (err) {
      log.session.warn('stopping an ACP worker on task completion failed', {
        sessionId: row.claudeSessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
    const lockWait = transactionWhenFree((handle) => {
      const sel = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
      const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
      for (const id of ids) {
        const row = sel.get(id) as Record<string, any> | undefined;
        const res = del.run(id);
        noteSessionRowTouched(id);
        removed += res.changes;
        if (res.changes > 0) {
          removedIds.push(id);
          if (row) {
            const rec = rowToSession(row);
            // A host's own row (it runs and judges the session): the host drops its row too (leader-drops.ts).
            if (judgedByHost(rec) && !rowOwnedHere(rec, thisHostKey())) noteLeaderDrop(handle, id, rec.host!);
            removedSnapshots.push({
              sessionId: id, taskId: rec.taskId, title: rec.title, host: rec.host,
              process_status: rec.process_status, startedAt: rec.startedAt,
            });
          }
        }
      }
    });
    if (lockWait instanceof Promise) await lockWait;
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
  const { removeCancelledSnapshots } = await import('./session-queue-store.js');
  await removeCancelledSnapshots(ids);
  return removed;
}

// ── A host's own rows, as its session channel sends them (session-channel/leader-side.ts) ──

/** One change of a host's own row: its patch, or its whole row (`born`, a rows frame). */
export interface HostRowChange {
  sid: string;
  /** The whole row: a host field it leaves out is cleared. */
  born?: boolean;
  patch: Readonly<Record<string, unknown>>;
  /** The record's place in the host's log: changes and renames apply in this order. */
  seq?: number;
  /** A born row's echo of its start's hand (handed-sessions.ts): the open hand it may take. */
  hand?: string;
  /** Fields the host's log cut on disk (fact-log.ts cutRowFields): the leader's own value of each stays. */
  keep?: readonly string[];
}

export interface HostRename { from: string; to: string; seq?: number }

export interface HostChannelBatch {
  hostId: string;
  rows: readonly HostRowChange[];
  renames: readonly HostRename[];
  /** The channel's new position: kept in the same transaction as the rows. */
  cursor: { logId: string; seq: number };
  /** Sessions the host dropped (its `drop` records): the leader's marks of them go (leader-drops.ts). */
  drops?: readonly string[];
  /** Sessions of the batch's other records: answered in `gone` when the leader deleted them. */
  check?: readonly string[];
  /**
   * The batch's turn ends that move a task's phase (session-channel/turn-ends.ts): each one of a
   * host-judged row of this host is marked in the same transaction, so a leader that stops before
   * its handlers acted sets the phase at its next boot.
   */
  turnEnds?: readonly HostTurnEnd[];
  /**
   * A rows frame: `rows` are every row the host owns now, as of record `at` of its log. A frame at
   * or below what is applied already is skipped whole; a row of that host it no longer names is
   * deleted only when the host names it in `gone`, else kept (session-channel/rows-snapshot.ts).
   * `keep`: starts in flight whose born row has not come yet. Its records carry no seq.
   */
  snapshot?: { keep?: ReadonlySet<string>; at?: number; gone?: readonly string[] };
}

/** What one batch did: the rows it wrote, those it left out, and where the stored position stood. */
export interface HostChannelBatchResult {
  written: string[];
  skipped: string[];
  gone: string[];
  /**
   * The stored position of the same log when the batch began: a record at or below it was applied
   * already (a link before this one took it), so it was skipped here and is not said again.
   */
  after: number;
  /** Sessions whose row the leader could not apply as sent (no base row, a refused write): worth the host's whole row. */
  resync: string[];
  /** Rows a snapshot no longer named and the host named gone, deleted here. */
  removed: string[];
  /** Rows a snapshot no longer named, kept and marked stopped (session-channel/rows-snapshot.ts). */
  orphaned?: string[];
  /** A rows frame older than what was applied already: nothing of it was applied. */
  stale?: boolean;
  /** Sessions whose hand-over to this host the rows ended (session-channel/handover-marks.ts). */
  handOversEnded?: string[];
  /**
   * Session ids the host named that are not its (handed-sessions.ts): a new session nobody handed
   * it, one handed to another host or for another task, a rename into another session's row.
   * Never applied.
   */
  refused?: string[];
  /** Rows the leader holds whose patch named another task: written with the leader's task kept. */
  taskKept?: string[];
  /** The renames this batch applied (a rename's `to` can be in `written` for another reason: its born row). */
  renamed?: Array<{ from: string; to: string }>;
}

/**
 * Apply one batch of a host's channel records: its row changes and renames in their log order and
 * the channel's new position, in ONE SQLite transaction, as the writer of the host's rows
 * (writingAsHost). A row this leader already holds keeps its leader fields (session-row-owner.ts
 * mergeHostFacts). A change that names another host, or a row that is not the host's, is skipped
 * and logged: a host writes only its own rows. After the commit, the status and content events a
 * normal write announces are emitted for the rows whose status or searchable text moved.
 */
/** Host rows whose cut spawn prompt was asked for again in this process (applyHostChannelBatch). */
const cutPromptResynced = new Set<string>();

export async function applyHostChannelBatch(batch: HostChannelBatch): Promise<HostChannelBatchResult> {
  await ensureSessionInit();
  const hostId = batch.hostId;
  const steps: Array<{ seq: number; i: number; row?: HostRowChange; rename?: HostRename }> = [
    ...batch.rows.map((row, i) => ({ seq: row.seq ?? 0, i, row })),
    ...batch.renames.map((rename, i) => ({ seq: rename.seq ?? 0, i: batch.rows.length + i, rename })),
  ].sort((a, b) => a.seq - b.seq || a.i - b.i);
  const written: string[] = [];
  const skipped: string[] = [];
  const resync = new Set<string>();
  const removed: string[] = [];
  const orphaned: string[] = [];
  const handOversEnded: string[] = [];
  const refused: string[] = [];
  const taskKept: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  let stale = false;
  let after = 0;
  // Deleted on the leader, its host not done yet: none of its rows comes back, none of its facts is said.
  const gone = new Set<string>();
  const announce: Array<{ record: SessionRecord; status: boolean; content: boolean }> = [];
  await withWriteLock(async () => {
    const db = getDb();
    if (!db) throw new Error('applyHostChannelBatch: SQLite handle is null');
    const lockWait = transactionWhenFree((handle) => writingAsHost(() => {
      const sel = prepared(handle, 'SELECT * FROM sessions WHERE claude_session_id = ?');
      const read = (id: string): SessionRecord | null => {
        const raw = sel.get(id) as Record<string, any> | undefined;
        return raw ? rowToSession(raw) : null;
      };
      // Exactly once across links: the position is read in the transaction that moves it, so a
      // record an earlier link of this host applied (its apply still waited for the lock when the
      // link dropped, and the next link resumed below it) is never applied, or said, twice.
      const stored = readChannelCursor(handle, hostId);
      after = stored && stored.logId === batch.cursor.logId ? stored.seq : 0;
      // A rows frame of a link a newer one replaced: its rows are older than what is applied.
      if (batch.snapshot && snapshotIsStale(hostId, batch.cursor.logId, batch.snapshot.at ?? batch.cursor.seq, stored)) { stale = true; return; }
      for (const sid of new Set([...batch.rows.map((r) => r.sid), ...batch.renames.map((r) => r.to), ...(batch.check ?? [])])) {
        if (leaderDroppedIn(handle, sid)) gone.add(sid);
      }
      for (const step of steps) {
        if (step.seq > 0 && step.seq <= after) continue;
        if (step.rename) {
          const { from, to } = step.rename;
          if (gone.has(to)) continue;
          const old = read(from);
          if (!old || !hostOwns(old.host, hostId) || !judgedByHost(old)) {
            skipped.push(from);
            // The host has `to` now: its whole row repairs what the rename could not, when it was handed `to`.
            if (!old && handedTo(handle, hostId, to)) resync.add(to);
            continue;
          }
          // Into a row that is not this host's, or an id handed to another host: refused, both rows stay.
          const into = read(to);
          if (into ? !hostOwns(into.host, hostId) || !judgedByHost(into) : !mayRenameInto(handle, hostId, to)) { refused.push(to); continue; }
          const historyBefore = storedHistoryFields(handle, from);
          deleteSessionRowSqlite(handle, from);
          if (!into) writeSessionRowSqlite(handle, { ...old, claudeSessionId: to }, { before: historyBefore! });
          written.push(to);
          renamed.push({ from, to });
          continue;
        }
        const change = step.row!;
        if (gone.has(change.sid)) continue;
        const before = read(change.sid);
        // A row of this host's machine under another of its names is its own too (handed-sessions.ts hostOwns).
        if (before && (!hostOwns(before.host, hostId) || !judgedByHost(before))) { skipped.push(change.sid); continue; }
        // A patch of a row the leader lacks: its whole row is asked for only when it was handed this
        // host (a refused session's patches are not asked about again and again).
        if (!before && !change.born) { skipped.push(change.sid); if (handedTo(handle, hostId, change.sid)) resync.add(change.sid); continue; }
        const next = mergeHostFacts(before, change.patch, change.born === true, change.keep);
        next.claudeSessionId = change.sid;
        // A boundary the host read: the leader's own told state of the row follows it (told-copies.ts).
        if (before) leaderToldAtBoundary(before, next);
        if (!hostOwns(next.host, hostId) || !judgedByHost(next)) { skipped.push(change.sid); continue; }
        // The task a session is for is set at its birth here and never moved by its host.
        if (before && (next.taskId ?? '') !== (before.taskId ?? '')) { next.taskId = before.taskId; taskKept.push(change.sid); }
        // A session the leader has no row of: only one it handed this host, for that task (handed-sessions.ts).
        const hand = before ? null : handForNewSession(handle, hostId, change.sid, { echo: change.hand, taskId: next.taskId ?? '' });
        if (hand && 'refused' in hand) { refused.push(change.sid); continue; }
        try {
          writeSessionRowSqlite(handle, next);
        } catch (err) {
          // One row the store refuses (its history guard) never wedges the channel behind it.
          log.session.warn('host channel: a row change was refused', { hostId, sessionId: change.sid, error: err instanceof Error ? err.message : String(err) });
          skipped.push(change.sid);
          if (!change.born) resync.add(change.sid);
          continue;
        }
        written.push(change.sid);
        // A field an older host's log cut (session-channel/fact-log.ts), the spawn prompt above all: its whole row is asked for once.
        if ((change.keep?.length || next.appliedAppendSystemPrompt?.length === FACT_INLINE_CAP) && !cutPromptResynced.has(change.sid)) {
          cutPromptResynced.add(change.sid);
          resync.add(change.sid);
        }
        // The host wrote its row of a session this leader handed it: the hand-over's answer, on disk
        // with the row (a lost answer, a leader that stopped before it, change nothing of it).
        if (clearHandOverMarkIn(handle, change.sid, hostId)) handOversEnded.push(change.sid);
        if (hand) useHand(handle, hand.hand);
        if (change.born) settleHandsOf(handle, hostId, change.sid);
        announce.push({
        record: next,
        status: !before || !statusProjectionEquals(canonicalStatusProjection(before), canonicalStatusProjection(next))
          || normalizedStatusRevision(before) !== normalizedStatusRevision(next),
        content: !before || searchContentProjection(before) !== searchContentProjection(next),
      });
      }
      if (batch.snapshot) {
        // The host's rows here it no longer names: deleted only on the host's word (rows-snapshot.ts).
        const named = new Set(batch.rows.map((r) => r.sid));
        const keep = batch.snapshot.keep;
        const ids = handle.prepare('SELECT claude_session_id FROM sessions WHERE host = ?').pluck().all(hostId) as string[];
        const unnamed: SessionRecord[] = [];
        for (const id of ids) {
          if (named.has(id) || keep?.has(id) || leaderDroppedIn(handle, id)) continue;
          const row = read(id);
          if (row && judgedByHost(row)) unnamed.push(row);
        }
        const plan = planSnapshot({ unnamed, gone: new Set(batch.snapshot.gone ?? []), logKnown: !!stored && stored.logId === batch.cursor.logId });
        for (const id of plan.remove) { deleteSessionRowSqlite(handle, id); removed.push(id); }
        const at = new Date().toISOString();
        for (const id of plan.orphan) {
          const before = read(id)!;
          const next = orphanedRow(before, at);
          writeSessionRowSqlite(handle, next);
          orphaned.push(id);
          announce.push({ record: next, status: true, content: false });
        }
      }
      if (batch.drops?.length) clearLeaderDrops(handle, hostId, batch.drops);
      if (batch.turnEnds?.length) {
        const at = Date.now();
        for (const te of batch.turnEnds) {
          if (te.seq <= after || gone.has(te.sid)) continue;
          const row = read(te.sid);
          if (row && hostOwns(row.host, hostId) && judgedByHost(row)) noteTurnEndIn(handle, hostId, te.sid, te.edge, at);
        }
      }
      // Never back: a batch an earlier link already passed keeps the position where it is.
      if (!(stored && stored.logId === batch.cursor.logId && stored.seq > batch.cursor.seq)) writeChannelCursor(handle, hostId, batch.cursor);
    }));
    if (lockWait instanceof Promise) await lockWait;
    if (batch.snapshot && !stale) noteSnapshotApplied(hostId, batch.cursor.logId, batch.snapshot.at ?? batch.cursor.seq);
  });
  if (stale) log.session.info('host channel: a rows frame older than what is applied was skipped', { hostId, at: batch.snapshot?.at });
  if (orphaned.length > 0) log.session.warn('host channel: rows the host does not name were kept and marked stopped', { hostId, sessionIds: orphaned.slice(0, 20), count: orphaned.length });
  if (skipped.length > 0) log.session.warn('host channel: changes skipped (not this host\'s rows)', { hostId, sessionIds: skipped.slice(0, 20), count: skipped.length });
  if (refused.length > 0) noteRefusedSessions(hostId, refused, 'row');
  if (taskKept.length > 0) noteRefusedSessions(hostId, taskKept, 'task');
  // After the commit: one announcement that throws never stops the others, nor the channel.
  for (const a of announce) {
    try {
      if (a.status) emitSessionStatusChanged(a.record, {}, ['*'], { source: 'host-channel' });
      if (a.content) bus.emit(EventNames.SESSION_CONTENT_UPDATED, { sessionId: a.record.claudeSessionId }, ['*'], { source: 'host-channel' });
    } catch (err) {
      log.session.warn('host channel: announcing a row failed', { hostId, sessionId: a.record.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (removed.length > 0) {
    log.session.warn('host channel: rows the host no longer has were removed', { hostId, sessionIds: removed.slice(0, 20), count: removed.length });
    try { bus.emit(EventNames.SESSION_DELETED, { sessionIds: removed }, ['*'], { source: 'host-channel', urgency: 'normal' }); } catch { /* announced best-effort */ }
  }
  return { written, skipped, gone: [...gone], after, resync: [...resync], removed, orphaned, ...(handOversEnded.length ? { handOversEnded } : {}), ...(stale ? { stale } : {}), ...(refused.length ? { refused } : {}), ...(taskKept.length ? { taskKept } : {}), renamed };
}

export { loadChannelCursor } from './session-db.js';

/**
 * A row this leader made for a start before the runner handed it to `host`, whose own service
 * runs and judges it (a task start seeds its row under the id it answers with): marked the host's
 * now, so the channel's `born` row of that session fills it in (applyHostChannelBatch takes only a
 * host's rows) and keeps the leader's own fields. A row under another name of the same machine
 * (revoked-hosts.ts oneDaemonNow: an ssh row of a box whose one service goes by its host-network
 * name) is moved to `host`, the name that service knows itself by: it claims only a row of its own
 * name (session-db.ts claimable). False: no such seed (nothing to do).
 */
export async function handSeedToHost(sid: string, host: string): Promise<boolean> {
  const rec = await getSessionByClaudeId(sid);
  if (!rec || !rec.host || judgedByHost(rec) || !oneDaemonNow(rec.host, host)) return false;
  await updateSessionRecord(sid, rec.host === host ? { judge: 'host' } : { judge: 'host', host });
  return true;
}

/**
 * The start handSeedToHost prepared did not go: the seed is the leader's again (its failure is
 * written on it). `from`: the name it had before the hand-over moved it to `host` (another name of
 * the same machine): it goes back to that name.
 */
export async function takeSeedBack(sid: string, host: string, from?: string): Promise<void> {
  const rec = await getSessionByClaudeId(sid);
  if (!rec || rec.host !== host || !judgedByHost(rec)) return;
  await writingAsHost(() => updateSessionRecord(sid, from && from !== host ? { judge: undefined, host: from } : { judge: undefined }));
}

export async function sweepOrphanedCancelledSnapshots(): Promise<void> {
  const { readQueueFileFresh, removeCancelledSnapshots } = await import('./session-queue-store.js');
  const ids = Object.keys((await readQueueFileFresh()).cancelled ?? {});
  if (!ids.length) return;
  await ensureSessionInit();
  await withWriteLock(async () => {
    const db = getDb();
    if (!db) throw new Error('Cancellation snapshot cleanup requires the session database');
    const query = db.prepare('SELECT claude_session_id FROM sessions WHERE claude_session_id = ?');
    const orphaned = new Set(ids.filter(id => !query.get(id)));
    await removeCancelledSnapshots(orphaned);
  });
}

/**
 * Get session summaries from markdown files in the sessions directory.
 */
export async function getSessionSummaries(limit = 10): Promise<SessionSummary[]> {
  // The cloud companion reads its copy of the Mac's memory dir (stage 4d), never its own disk.
  const companion = await import('./companion-memory-files.js');
  const state = companion.companionMemoryFiles();
  if (state === 'needs-mac') throw new NeedsLeaderError('kind_not_copied');
  if (state === 'copy') {
    return companion.copySessionSummaryFiles(limit)
      .map((f) => parseSessionMarkdown(f.content, f.file))
      .filter((s): s is SessionSummary => s !== null);
  }
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
  const view = await readStoreView();
  return view
    .filter((s) => (opts?.includeLanes ? true : !isLaneSession(s)))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, limit)
    .map(cloneSession);
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
