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
  if (initAttempted) return db; // previous open failed; don't retry in a hot loop
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

    // Truncate the WAL on open (see task-db.ts:128 — same rationale).
    let checkpoint: unknown = null;
    try {
      checkpoint = handle.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log.session.warn('session-db: WAL checkpoint on open failed', { err: String(err) });
    }

    db = handle;
    log.session.info('session-db opened', { path: SESSION_DB_PATH });
    log.session.info('session-db: WAL checkpoint on open', { result: checkpoint });
    return db;
  } catch (err) {
    log.session.error('session-db open failed', { path: SESSION_DB_PATH, err: String(err) });
    throw err;
  }
}

/**
 * Close the handle. Safe to call when already closed or never opened.
 * Intended for test teardown and graceful shutdown.
 */
export function closeDb(): void {
  if (db) {
    try { db.close(); } catch (err) { log.session.warn('session-db close error', { err: String(err) }); }
    db = null;
  }
  initAttempted = false;
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

  return row;
}

// Re-export the column list so callers can build prepared statements without
// duplicating the ordering.
export const SESSION_COLUMNS: readonly string[] = EXPLICIT_SESSION_COLUMNS;

// ── Schema ─────────────────────────────────────────────────────────────────
// Idempotent. Safe to run on every open — matches the pattern in
// memory-index.ts and task-db.ts.
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
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_task_id ON sessions(task_id);
  CREATE INDEX IF NOT EXISTS sessions_host ON sessions(host);
  CREATE INDEX IF NOT EXISTS sessions_process_status ON sessions(process_status);
  CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(last_active_at);
`;

