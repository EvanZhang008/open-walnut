/**
 * session-db.ts — SQLite foundation for the sessions store.
 *
 * Mirrors task-db.ts exactly in layout and semantics. Owns the singleton
 * `better-sqlite3` connection for `sessions.sqlite`, schema initialization
 * (WAL + busy_timeout=5000 + NORMAL sync + wal_checkpoint(TRUNCATE) on open),
 * and the row↔SessionRecord (de)serialization helpers that the rest of the
 * sessions rewrite (session-tracker router, one-shot migration, bulk APIs)
 * builds on.
 *
 * Do NOT add business logic here. This file is the storage primitive only.
 * Liveness checks, triage filtering, status-history ring-buffer trimming, and
 * all other session semantics stay in session-tracker.ts on top of these
 * helpers.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import { guardCopyHandle, openApplyConnection } from '../replica/copy-guard.js';
import { isHostReplica } from './server-role.js';
import type { SessionRecord } from './types.js';

/** SQLite file path. Sits next to the legacy sessions.json in WALNUT_HOME. */
export const SESSION_DB_PATH = path.join(WALNUT_HOME, 'sessions.sqlite');

/**
 * Columns that map directly onto a `SessionRecord` field.
 *
 * The SessionRecord `claudeSessionId` (camelCase) is stored as
 * `claude_session_id` (snake) and serves as PRIMARY KEY — same aliasing
 * pattern as `_syncedAt` / `_synced_at` in task-db.ts.
 *
 * Keep this list in sync with the schema below and the SessionRecord type in
 * types.ts. Any SessionRecord key not in this set is packed into `payload` on
 * write and merged back onto the record on read — that's the future-proof
 * fallback; we only add a dedicated column when we want to query or index
 * on that field.
 *
 * Not persisted here (by design):
 *   - `hostname`: resolved at runtime from config.hosts for display tooltips
 *   - `pendingPermission`, `status_history`: structured objects → payload
 */
const EXPLICIT_SESSION_COLUMNS = [
  'claude_session_id',
  'task_id',
  'project',
  'process_status',
  'mode',
  'provider',
  'type',
  'activity',
  'last_status_change',
  'started_at',
  'last_active_at',
  'message_count',
  'cwd',
  'host',
  'title',
  'description',
  'pid',
  'output_file',
  'plan_file',
  'plan_completed',
  'from_plan_session_id',
  'forked_from_session_id',
  'human_note',
  'model',
  'cli_model',
  'archived',
  'archive_reason',
  'plan_content',
  'error_message',
  'status_reason',
  'status_changed_by',
  'status_revision',
  'status_updated_at',
] as const;

/**
 * camelCase SessionRecord key ↔ snake_case column name. Used by both
 * `sessionToRow` and `rowToSession` so the mapping lives in exactly one place.
 *
 * Any SessionRecord key NOT in this map (and not `hostname`, which we never
 * persist) spills into `payload`. Any new scalar field added to SessionRecord
 * falls through to payload by default — add an entry here + a column below
 * only when we need to query/index on it.
 */
const FIELD_TO_COLUMN: Record<string, string> = {
  claudeSessionId: 'claude_session_id',
  taskId: 'task_id',
  project: 'project',
  process_status: 'process_status',
  mode: 'mode',
  provider: 'provider',
  type: 'type',
  activity: 'activity',
  last_status_change: 'last_status_change',
  startedAt: 'started_at',
  lastActiveAt: 'last_active_at',
  messageCount: 'message_count',
  cwd: 'cwd',
  host: 'host',
  title: 'title',
  description: 'description',
  pid: 'pid',
  outputFile: 'output_file',
  planFile: 'plan_file',
  planCompleted: 'plan_completed',
  fromPlanSessionId: 'from_plan_session_id',
  forkedFromSessionId: 'forked_from_session_id',
  human_note: 'human_note',
  model: 'model',
  cliModel: 'cli_model',
  archived: 'archived',
  archive_reason: 'archive_reason',
  planContent: 'plan_content',
  errorMessage: 'error_message',
  status_reason: 'status_reason',
  status_changed_by: 'status_changed_by',
  statusRevision: 'status_revision',
  statusUpdatedAt: 'status_updated_at',
};

const COLUMN_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_TO_COLUMN).map(([k, v]) => [v, k]),
);

/** Boolean columns — stored as INTEGER 0/1 in SQLite. */
const BOOLEAN_COLUMNS = new Set<string>(['plan_completed', 'archived']);

/** Explicit SessionRecord keys covered by a dedicated column. Built from FIELD_TO_COLUMN. */
const EXPLICIT_SESSION_KEYS = new Set<string>(Object.keys(FIELD_TO_COLUMN));

/**
 * Runtime-only keys that MUST NOT be persisted. `hostname` is resolved from
 * config.hosts on each read in session-tracker; persisting it would just bake
 * in a stale display name.
 */
const NON_PERSISTED_KEYS = new Set<string>(['hostname']);

// ── Singleton ──────────────────────────────────────────────────────────────
let db: DatabaseType | null = null;
let initAttempted = false;
// Rethrown on every call after a failed open — see task-db.ts for rationale
// (silent null degrades every caller to an uninformative "null.prepare").
let initError: unknown = null;

/**
 * Return the shared SQLite handle, lazily opening + initializing it on the
 * first call.
 *
 * Pragmas mirror task-db.ts and usage/tracker.ts:
 *   - journal_mode=WAL          → readers don't block the single writer.
 *   - busy_timeout=5000         → retry for 5s on writer contention.
 *   - synchronous=NORMAL        → fsync only at checkpoint time. Session
 *                                 metadata is re-derivable from the JSONL
 *                                 stream + live processes on crash, so the
 *                                 tiny durability reduction is fine.
 *   - foreign_keys=ON           → future-proof for child tables.
 *
 * Also runs `wal_checkpoint(TRUNCATE)` on open to stop the WAL growing
 * unboundedly between restarts (same problem tasks.sqlite-wal hit at 80 MB).
 */
export function getDb(): DatabaseType | null {
  if (db) return db;
  if (initAttempted) throw initError; // previous open failed; rethrow the real cause (no hot-loop retry)
  initAttempted = true;

  try {
    fs.mkdirSync(path.dirname(SESSION_DB_PATH), { recursive: true });
    const handle = new Database(SESSION_DB_PATH);
    handle.pragma('journal_mode = WAL');
    handle.pragma('busy_timeout = 5000');
    // See task-db.ts for the wal_autocheckpoint rationale — on-stop/on-compact
    // hook child processes hold their own handles and never hit the explicit
    // wal_checkpoint below.
    handle.pragma('wal_autocheckpoint = 1000');
    handle.pragma('synchronous = NORMAL');
    handle.pragma('foreign_keys = ON');

    handle.exec(SCHEMA_SQL);
    // A host replica's file is the Mac's rows, kept by the follower apply
    // connection (sessions kind, replication/kinds/sessions.ts): its own data
    // fixes and WAL truncation would change the copy behind its hashes, so it
    // adds missing columns only (task-db.ts does the same).
    const copy = isHostReplica();
    ensureSessionStatusColumns(handle, undefined, { backfill: !copy });

    // Truncate the WAL on open (see task-db.ts:128 — same rationale).
    let checkpoint: unknown = null;
    if (!copy) {
      try {
        checkpoint = handle.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log.session.warn('session-db: WAL checkpoint on open failed', { err: String(err) });
      }
    }

    // A host replica's copy reads only; its one writer is the apply connection (replica/copy-guard.ts).
    guardCopyHandle(handle, 'sessions');
    db = handle;
    log.session.info('session-db opened', { path: SESSION_DB_PATH });
    log.session.info('session-db: WAL checkpoint on open', { result: checkpoint });
    return db;
  } catch (err) {
    initError = err;
    log.session.error('session-db open failed', { path: SESSION_DB_PATH, err: String(err) });
    throw err;
  }
}

/** The follower apply connection of this store on a host replica (replica/copy-guard.ts). */
export function openCopyApplyConnection(): DatabaseType {
  getDb();
  return openApplyConnection(SESSION_DB_PATH, 'sessions');
}

let applyHandle: DatabaseType | null = null;

/**
 * The ids this store holds (the sessions copy's local keys). `exceptHost`: leave out the
 * sessions that run on that host (a host replica's own, which its purge keeps).
 */
export function sessionIdsInStore(opts: { exceptHost?: string } = {}): string[] {
  const handle = getDb();
  if (!handle) return [];
  if (opts.exceptHost) {
    return handle.prepare('SELECT claude_session_id FROM sessions WHERE host IS NULL OR host != ?').pluck().all(opts.exceptHost) as string[];
  }
  return handle.prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[];
}

/** Every session id and ACP runtime id in the store, without decoding records (the ephemeral session gate's copied set). */
export function sessionIdentitiesInStore(): string[] {
  const handle = getDb();
  if (!handle) throw new Error('sessions store unavailable');
  return handle.prepare(
    `SELECT claude_session_id FROM sessions UNION
     SELECT json_extract(payload, '$.acpRuntimeId') FROM sessions WHERE instr(payload, '"acpRuntimeId"') > 0 AND json_valid(payload)`,
  ).pluck().all().filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * The sessions copy's one write (replication/kinds/sessions.ts): rows in as
 * they came (INSERT OR REPLACE, every column), removed ids out, one
 * transaction. On a host replica it runs on the follower apply connection, the
 * only handle that may write the copy; session-tracker's read cache sees the
 * commit through `PRAGMA data_version`. Off a host replica (tests) it uses the
 * shared handle.
 */
export function applySessionCopy(change: { rows?: readonly SessionRecord[]; removeIds?: readonly string[] }): void {
  const shared = getDb();
  if (!shared) throw new Error('session-db: applySessionCopy() called before database was successfully opened');
  const handle = isHostReplica() ? (applyHandle ??= openCopyApplyConnection()) : shared;
  const cols = [...EXPLICIT_SESSION_COLUMNS, 'payload'];
  const ins = handle.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
  const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
  handle.transaction(() => {
    for (const id of change.removeIds ?? []) del.run(id);
    for (const r of change.rows ?? []) {
      const row = sessionToRow(r);
      const bound: Record<string, unknown> = {};
      for (const c of cols) bound[c] = row[c] === undefined ? null : row[c];
      ins.run(bound);
    }
  })();
}

// ── The cloud companion's copy of the Mac's sessions (stage 2c of
// docs/plan/walnut-companion-unified-replica.md): its own file under the copy store,
// never the box's live registry, which holds the sessions the box runs itself. ──

let companionCopy: { path: string; handle: DatabaseType } | null = null;

function companionCopyHandle(dbPath: string): DatabaseType {
  if (companionCopy && companionCopy.path === dbPath) return companionCopy.handle;
  if (companionCopy) { try { companionCopy.handle.close(); } catch { /* reopened below */ } }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('synchronous = NORMAL');
  handle.exec(SCHEMA_SQL);
  // The Mac's rows as they came: missing columns only, no data fixes.
  ensureSessionStatusColumns(handle, undefined, { backfill: false });
  companionCopy = { path: dbPath, handle };
  return handle;
}

/** The ids the companion's sessions copy at `dbPath` holds. */
export function companionSessionCopyIds(dbPath: string): string[] {
  return companionCopyHandle(dbPath).prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[];
}

/**
 * The rows a list can show, kept parsed in memory (the copy is the Mac's whole store,
 * 5,000 rows and 18 MB of JSON measured, so a list never parses it per request): not
 * archived, and live or active in the last 30 days (the list's own window is 14).
 */
const COPY_LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
let copyRows: { path: string; rows: Map<string, SessionRecord> } | null = null;
let copyRowsLoad: Promise<Map<string, SessionRecord>> | null = null;
/** Bumped when the copy is closed: a parse begun before that installs nothing. */
let copyGen = 0;
/** Writes that landed while the rows were being parsed: applied to them once parsed. */
let copyRowsPending: Array<{ rows?: readonly SessionRecord[]; removeIds?: readonly string[] }> = [];

function listableCopyRow(r: SessionRecord, now: number): boolean {
  if (r.archived) return false;
  if (r.process_status !== 'stopped' && r.process_status !== 'error') return true;
  const at = Date.parse(r.lastActiveAt ?? r.startedAt);
  return Number.isFinite(at) && at >= now - COPY_LIST_WINDOW_MS;
}

function applyToCopyRows(rows: Map<string, SessionRecord>, change: { rows?: readonly SessionRecord[]; removeIds?: readonly string[] }): void {
  const now = Date.now();
  for (const id of change.removeIds ?? []) rows.delete(id);
  for (const r of change.rows ?? []) {
    if (listableCopyRow(r, now)) rows.set(r.claudeSessionId, r);
    else rows.delete(r.claudeSessionId);
  }
}

async function loadCopyRows(dbPath: string): Promise<Map<string, SessionRecord>> {
  const gen = copyGen;
  const cutoff = new Date(Date.now() - COPY_LIST_WINDOW_MS).toISOString();
  // This read holds every write before it: only the ones from here on are pending.
  copyRowsPending = [];
  // One read of the raw rows (strings), then the JSON parsed in slices between turns of the loop.
  const raw = companionCopyHandle(dbPath)
    .prepare("SELECT * FROM sessions WHERE coalesce(archived, 0) = 0 AND (coalesce(process_status, '') NOT IN ('stopped', 'error') OR coalesce(nullif(last_active_at, ''), started_at) >= ?)")
    .all(cutoff) as Array<Record<string, unknown>>;
  const rows = new Map<string, SessionRecord>();
  for (let i = 0; i < raw.length; i++) {
    const r = rowToSession(raw[i]!);
    rows.set(r.claudeSessionId, r);
    if (i % 50 === 49) await new Promise((done) => setImmediate(done));
  }
  if (gen !== copyGen) return rows;
  for (const change of copyRowsPending) applyToCopyRows(rows, change);
  copyRowsPending = [];
  copyRows = { path: dbPath, rows };
  return rows;
}

/** The companion's sessions copy's one write: rows in as they came, removed ids out, one transaction. */
export function applyCompanionSessionCopy(dbPath: string, change: { rows?: readonly SessionRecord[]; removeIds?: readonly string[] }): void {
  const handle = companionCopyHandle(dbPath);
  const cols = [...EXPLICIT_SESSION_COLUMNS, 'payload'];
  const ins = handle.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
  const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
  handle.transaction(() => {
    for (const id of change.removeIds ?? []) del.run(id);
    for (const r of change.rows ?? []) {
      const row = sessionToRow(r);
      const bound: Record<string, unknown> = {};
      for (const c of cols) bound[c] = row[c] === undefined ? null : row[c];
      ins.run(bound);
    }
  })();
  // The parsed rows follow the file only once it is written.
  if (copyRows && copyRows.path === dbPath) applyToCopyRows(copyRows.rows, change);
  else if (copyRowsLoad) copyRowsPending.push(change);
}

/** The sessions of the companion's copy at `dbPath` a list can show (see COPY_LIST_WINDOW_MS). */
export async function readCompanionSessionCopy(dbPath: string): Promise<SessionRecord[]> {
  if (copyRows && copyRows.path === dbPath) return [...copyRows.rows.values()];
  if (!fs.existsSync(dbPath)) return [];
  if (!copyRowsLoad) {
    const load = loadCopyRows(dbPath).finally(() => { if (copyRowsLoad === load) copyRowsLoad = null; });
    copyRowsLoad = load;
  }
  return [...(await copyRowsLoad).values()];
}

/** Close the companion's sessions copy and forget its parsed rows (the next read opens and parses it again). */
export function closeCompanionSessionCopy(): void {
  copyGen++;
  if (companionCopy) {
    try { companionCopy.handle.close(); } catch { /* closing anyway */ }
    companionCopy = null;
  }
  copyRows = null;
  copyRowsLoad = null;
  copyRowsPending = [];
}

/**
 * Close the handle. Safe to call when already closed or never opened.
 * Intended for test teardown and graceful shutdown.
 */
export function closeDb(): void {
  closeCompanionSessionCopy();
  if (applyHandle) {
    try { applyHandle.close(); } catch (err) { log.session.warn('session-db apply connection close error', { err: String(err) }); }
    applyHandle = null;
  }
  if (db) {
    try { db.close(); } catch (err) { log.session.warn('session-db close error', { err: String(err) }); }
    db = null;
  }
  initAttempted = false;
  initError = null;
}

/**
 * Run `fn` inside a single SQLite transaction.
 *
 * Same semantics as task-db.ts: `better-sqlite3` is synchronous by design; do
 * not `await` inside the transaction — that breaks commit boundaries.
 */
export function transaction<T>(fn: (db: DatabaseType) => T): T {
  const handle = getDb();
  if (!handle) {
    throw new Error('session-db: transaction() called before database was successfully opened');
  }
  const tx = handle.transaction(fn);
  return tx(handle);
}

/**
 * Idempotently add/backfill the versioned status projection columns.
 * Kept explicit because CREATE TABLE IF NOT EXISTS never alters old tables.
 */
export function ensureSessionStatusColumns(
  handle: DatabaseType,
  now = new Date().toISOString(),
  opts: { backfill?: boolean } = {},
): void {
  const columns = handle.pragma('table_info(sessions)') as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const migrate = handle.transaction(() => {
    if (!names.has('status_revision')) {
      handle.exec(
        'ALTER TABLE sessions ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 1',
      );
    }
    if (!names.has('status_updated_at')) {
      handle.exec('ALTER TABLE sessions ADD COLUMN status_updated_at TEXT');
    }
    if (opts.backfill === false) return;
    handle.prepare(`
      UPDATE sessions
      SET status_revision = 1
      WHERE status_revision IS NULL OR status_revision < 1
    `).run();
    handle.prepare(`
      UPDATE sessions
      SET status_updated_at = COALESCE(
        NULLIF(status_updated_at, ''),
        NULLIF(last_status_change, ''),
        NULLIF(last_active_at, ''),
        NULLIF(started_at, ''),
        ?
      )
      WHERE status_updated_at IS NULL OR status_updated_at = ''
    `).run(now);
  });
  migrate();
}

// ── (De)serialization ──────────────────────────────────────────────────────

/**
 * Convert a SQLite row back to a `SessionRecord`. JSON `payload` is parsed
 * first so explicit columns can override any leftover keys; boolean columns
 * coerce 0/1 → false/true; snake_case columns map back to camelCase fields.
 *
 * Null/undefined columns are stripped so the returned object matches the
 * "JSON-loaded" shape the rest of the code expects. Callers (session-tracker)
 * do further normalization (type inference from title, status_history
 * trimming, etc.).
 */
export function rowToSession(row: Record<string, any>): SessionRecord {
  // Start from payload so explicit columns can override any leftover keys.
  let record: Record<string, any> = {};
  if (row.payload != null && row.payload !== '') {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = { ...parsed };
      }
    } catch (err) {
      log.session.warn('rowToSession: payload JSON parse failed', {
        claudeSessionId: row.claude_session_id,
        err: String(err),
      });
    }
  }

  // Explicit columns → camelCase fields.
  for (const col of EXPLICIT_SESSION_COLUMNS) {
    const val = row[col];
    if (val === undefined || val === null) continue;
    const field = COLUMN_TO_FIELD[col];
    if (!field) continue; // defensive — should never hit
    if (BOOLEAN_COLUMNS.has(col)) {
      record[field] = val === 1 || val === true;
    } else {
      record[field] = val;
    }
  }

  // Required-field fallbacks — the DB may have NULL where SessionRecord
  // expects a value (pre-migration or partially written rows). Match the
  // JSON-load defaults the tracker code has always relied on.
  if (typeof record.messageCount !== 'number') record.messageCount = 0;
  if (typeof record.startedAt !== 'string' || !record.startedAt) {
    record.startedAt = record.lastActiveAt ?? new Date().toISOString();
  }
  if (typeof record.lastActiveAt !== 'string' || !record.lastActiveAt) {
    record.lastActiveAt = record.startedAt;
  }

  return record as SessionRecord;
}

/**
 * Convert a `SessionRecord` (or a partial patch) to a row suitable for
 * prepared INSERT / UPDATE statements. Explicit fields are mapped to their
 * snake_case columns; anything else (not a runtime-only key) is
 * JSON-stringified into the `payload` column so fields without a dedicated
 * column aren't silently dropped.
 *
 * Returns a `Record<string, any>` keyed by column name. Bind these by name
 * with `@col` placeholders (`stmt.run(row)`).
 */
export function sessionToRow(session: Partial<SessionRecord>): Record<string, any> {
  const row: Record<string, any> = {};

  // Explicit fields → columns.
  for (const [field, col] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in session)) continue;
    const val = (session as Record<string, any>)[field];
    if (val === undefined) continue;
    if (BOOLEAN_COLUMNS.has(col)) {
      row[col] = val ? 1 : 0;
    } else {
      row[col] = val;
    }
  }

  // Everything left that isn't a runtime-only key goes to payload. That
  // includes objects (pendingPermission), arrays (status_history), and any
  // future SessionRecord field we haven't given a column yet.
  const payload: Record<string, any> = {};
  let hasPayload = false;
  for (const key of Object.keys(session)) {
    if (EXPLICIT_SESSION_KEYS.has(key)) continue;
    if (NON_PERSISTED_KEYS.has(key)) continue;
    const val = (session as Record<string, any>)[key];
    if (val === undefined) continue;
    payload[key] = val;
    hasPayload = true;
  }
  if (hasPayload) {
    row.payload = JSON.stringify(payload);
  } else if ('payload' in session) {
    // Explicit clear request.
    row.payload = null;
  }

  // Full legacy records may reach bulk INSERT helpers without the versioned
  // fields. Bind safe initial values instead of NULL (status_revision is
  // NOT NULL); partial UPDATE patches do not carry claudeSessionId and are
  // intentionally left untouched.
  if (typeof session.claudeSessionId === 'string') {
    if (row.status_revision === undefined) row.status_revision = 1;
    if (row.status_updated_at === undefined) {
      row.status_updated_at = session.last_status_change
        ?? session.lastActiveAt
        ?? session.startedAt
        ?? new Date().toISOString();
    }
  }

  return row;
}

// Re-export the column list so callers can build prepared statements without
// duplicating the ordering.
export const SESSION_COLUMNS: readonly string[] = EXPLICIT_SESSION_COLUMNS;

// ── Schema ─────────────────────────────────────────────────────────────────
// Idempotent. Safe to run on every open — matches the pattern in
// task-db.ts and notes-index.ts.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    claude_session_id TEXT PRIMARY KEY,
    task_id TEXT,
    project TEXT,
    process_status TEXT,
    mode TEXT,
    provider TEXT,
    type TEXT,
    activity TEXT,
    last_status_change TEXT,
    started_at TEXT,
    last_active_at TEXT,
    message_count INTEGER DEFAULT 0,
    cwd TEXT,
    host TEXT,
    title TEXT,
    description TEXT,
    pid INTEGER,
    output_file TEXT,
    plan_file TEXT,
    plan_completed INTEGER DEFAULT 0,
    from_plan_session_id TEXT,
    forked_from_session_id TEXT,
    human_note TEXT,
    model TEXT,
    cli_model TEXT,
    archived INTEGER DEFAULT 0,
    archive_reason TEXT,
    plan_content TEXT,
    error_message TEXT,
    status_reason TEXT,
    status_changed_by TEXT,
    status_revision INTEGER NOT NULL DEFAULT 1,
    status_updated_at TEXT,
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_task_id ON sessions(task_id);
  CREATE INDEX IF NOT EXISTS sessions_host ON sessions(host);
  CREATE INDEX IF NOT EXISTS sessions_process_status ON sessions(process_status);
  CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(last_active_at);
  CREATE INDEX IF NOT EXISTS sessions_last_status_change ON sessions(last_status_change);
`;
