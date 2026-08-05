/**
 * task-db.ts — SQLite foundation for the tasks store.
 *
 * This module owns the singleton `better-sqlite3` connection, schema
 * initialization (WAL + busy_timeout + NORMAL sync), and the row↔Task
 * (de)serialization helpers that the rest of the rewrite (task-manager,
 * migration, bulk update APIs) builds on top of.
 *
 * Do NOT add business logic here. This file is the storage primitive only.
 * Phase rules, terminal-phase guards, dirty checks, and plugin content
 * validation all live in task-manager.ts on top of these helpers.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { TASKS_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import type { Task } from './types.js';
import type { ExtIndexSpec } from './integration-types.js';

/** SQLite file path. Sits next to the legacy tasks.json in the same dir. */
export const TASK_DB_PATH = path.join(TASKS_DIR, 'tasks.sqlite');

/**
 * Columns that map directly onto a `Task` field. Order matters for prepared
 * statements and is used by `taskToRow` / `rowToTask` to decide which fields
 * get their own column vs spill into the `payload` JSON blob.
 *
 * Keep this list in sync with the schema below and the Task type in types.ts.
 * Any `Task` key not in this set is packed into `payload` on write and merged
 * back onto the task object on read — that's the "future-proof fallback" the
 * plan refers to. It means adding an optional Task field doesn't require a
 * schema migration; we only add a dedicated column when we want to query or
 * index on that field.
 */
const EXPLICIT_TASK_COLUMNS = [
  'id',
  'title',
  'category',
  'project',
  'status',
  'phase',
  'priority',
  'source',
  'parent_task_id',
  'due_date',
  'start_date',
  'created_at',
  'updated_at',
  'completed_at',
  'sprint',
  'focus_tier',
  'pinned',
  'ext',
  'tags',
  'depends_on',
  'session_ids',
  'note',
  'summary',
  'description',
  'conversation_log',
  'sync_error',
  '_synced_at',
] as const;

/**
 * Columns that hold a JSON-encoded value. Everything else is stored as text
 * (or INTEGER for `pinned`). `payload` is also JSON but handled separately.
 */
const JSON_COLUMNS = new Set<string>([
  'ext',
  'tags',
  'depends_on',
  'session_ids',
  'conversation_log',
]);

/**
 * Task keys handled by explicit columns. Used by `taskToRow` to decide which
 * keys spill into `payload`. Built from `EXPLICIT_TASK_COLUMNS` plus the
 * `_syncedAt` alias (stored as `_synced_at`, see note on column naming below).
 */
const EXPLICIT_TASK_KEYS = new Set<string>([
  ...EXPLICIT_TASK_COLUMNS,
  // Task type uses camelCase `_syncedAt`; column is snake `_synced_at`.
  '_syncedAt',
]);

// ── Singleton ──────────────────────────────────────────────────────────────
let db: DatabaseType | null = null;
let initAttempted = false;
// The original open error, rethrown on every subsequent call. Without this a
// failed open degrades to `getDb()` returning null forever, and every caller's
// `getDb()!.prepare(...)` dies with an uninformative "null.prepare" TypeError
// while the real cause (e.g. a missing better-sqlite3 native binding) is
// logged exactly once and lost.
let initError: unknown = null;

/**
 * Return the shared SQLite handle, lazily opening + initializing it on the
 * first call.
 *
 * On open we match the pragmas used in usage/tracker.ts:
 *   - journal_mode=WAL          → readers don't block the single writer.
 *   - busy_timeout=5000         → retry for 5s when another process holds the
 *                                 db lock (hook child procs may write).
 *   - synchronous=NORMAL        → fsync only at checkpoint time. Acceptable
 *                                 for task data where a <1s write loss on
 *                                 power failure is fine (sync plugins will
 *                                 repull on next tick).
 *   - foreign_keys=ON           → future-proof for child tables.
 */
export function getDb(): DatabaseType | null {
  if (db) return db;
  if (initAttempted) throw initError; // previous open failed; rethrow the real cause (no hot-loop retry)
  initAttempted = true;

  try {
    fs.mkdirSync(path.dirname(TASK_DB_PATH), { recursive: true });
    const handle = new Database(TASK_DB_PATH);
    handle.pragma('journal_mode = WAL');
    handle.pragma('busy_timeout = 5000');
    // wal_autocheckpoint: SQLite moves WAL → main file every N pages (default
    // 1000 ≈ 4MB). Belt-and-suspenders vs the explicit wal_checkpoint below,
    // because hook child processes open their own handles and never hit the
    // explicit-checkpoint code path — without this they could grow the WAL
    // unboundedly between server restarts.
    handle.pragma('wal_autocheckpoint = 1000');
    handle.pragma('synchronous = NORMAL');
    handle.pragma('foreign_keys = ON');

    handle.exec(SCHEMA_SQL);
    runOneTimeMigrations(handle);

    // Truncate the WAL on open. Without this the WAL grows unboundedly
    // between process restarts — observed at 80MB in prod. Returns
    // { busy, log, checkpointed } per SQLite docs.
    let checkpoint: unknown = null;
    try {
      checkpoint = handle.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log.task.warn('task-db: WAL checkpoint on open failed', { err: String(err) });
    }

    db = handle;
    log.task.info('task-db opened', { path: TASK_DB_PATH });
    log.task.info('task-db: WAL checkpoint on open', { result: checkpoint });
    return db;
  } catch (err) {
    initError = err;
    log.task.error('task-db open failed', { path: TASK_DB_PATH, err: String(err) });
    throw err;
  }
}

/**
 * Close the handle. Safe to call when already closed or never opened.
 * Intended for test teardown and graceful shutdown; production code should
 * not need to close/reopen during normal operation.
 */
export function closeDb(): void {
  if (db) {
    try { db.close(); } catch (err) { log.task.warn('task-db close error', { err: String(err) }); }
    db = null;
  }
  initAttempted = false;
  initError = null;
}

/**
 * Run `fn` inside a single SQLite transaction.
 *
 * Uses `better-sqlite3`'s `db.transaction()` wrapper which implicitly begins
 * an IMMEDIATE transaction, runs the function synchronously, and commits on
 * return (rolls back on throw). This is the pattern used in usage/tracker.ts.
 *
 * NOTE: `fn` must be synchronous. `better-sqlite3` is synchronous by design;
 * mixing awaits inside a transaction causes silent commit-before-completion.
 * If you need async work, do it before/after the transaction, not inside.
 */
export function transaction<T>(fn: (db: DatabaseType) => T): T {
  const handle = getDb();
  if (!handle) {
    throw new Error('task-db: transaction() called before database was successfully opened');
  }
  const tx = handle.transaction(fn);
  return tx(handle);
}

// ── (De)serialization ──────────────────────────────────────────────────────

/**
 * Convert a SQLite row back to a `Task` object. JSON columns are parsed;
 * `pinned` is coerced from INTEGER to boolean; `payload` keys are merged
 * back onto the top-level object (with explicit columns winning on collision
 * so stale payload data can't override a real column value).
 *
 * Unknown / null columns are stripped so the returned object matches the
 * "JSON-loaded" shape the rest of the code expects. Callers are responsible
 * for further normalization (phase migration, default categories, etc.) —
 * that logic stays in task-manager.ts.
 */
export function rowToTask(row: Record<string, any>): Task {
  // Start from payload so explicit columns can override any leftover keys.
  let task: Record<string, any> = {};
  if (row.payload != null && row.payload !== '') {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        task = { ...parsed };
      }
    } catch (err) {
      // Corrupt payload shouldn't take the whole task down; log and move on.
      log.task.warn('rowToTask: payload JSON parse failed', { id: row.id, err: String(err) });
    }
  }

  // Explicit columns.
  for (const col of EXPLICIT_TASK_COLUMNS) {
    const val = row[col];
    if (val === undefined || val === null) continue;
    if (JSON_COLUMNS.has(col)) {
      // Empty-string sentinels from older migrations land here; treat as absent.
      if (val === '') continue;
      try {
        task[col] = JSON.parse(val);
      } catch (err) {
        log.task.warn('rowToTask: JSON column parse failed', { id: row.id, col, err: String(err) });
      }
    } else if (col === 'pinned') {
      task.pinned = val === 1 || val === true;
    } else {
      task[col] = val;
    }
  }

  // Column is `_synced_at` (snake) but Task interface uses `_syncedAt` (camel).
  if (row._synced_at != null && row._synced_at !== '') {
    task._syncedAt = row._synced_at;
  }

  // Required-field fallbacks — the DB may have NULL where Task requires a value
  // (pre-migration data). Mirror the JSON-load defaults so downstream code
  // never sees `undefined` for these fields.
  if (typeof task.session_ids === 'undefined') task.session_ids = [];
  if (typeof task.description === 'undefined') task.description = '';
  if (typeof task.summary === 'undefined') task.summary = '';
  if (typeof task.note === 'undefined') task.note = '';

  return task as Task;
}

/**
 * Convert a `Task` (or a partial patch) to a row suitable for prepared
 * INSERT / UPDATE statements. Explicit columns are picked out; any remaining
 * keys are JSON-stringified into the `payload` column so we don't silently
 * drop fields that don't have a dedicated column yet.
 *
 * Returns a `Record<string, any>` keyed by column name. Callers bind these
 * by name using `@col` placeholders (`stmt.run(row)`) — that's what makes
 * this safe for partial UPDATEs (just omit the key).
 *
 * NOTE: passing a `Partial<Task>` is supported — missing keys are simply
 * absent from the return object. But passing a Task with `pinned:false`
 * and expecting "do not update pinned" is ambiguous; callers that need
 * true partial-update semantics should filter the patch before calling.
 */
export function taskToRow(task: Partial<Task>): Record<string, any> {
  const row: Record<string, any> = {};

  // Explicit columns.
  for (const col of EXPLICIT_TASK_COLUMNS) {
    if (col === '_synced_at') continue; // aliased below
    if (!(col in task)) continue;
    const val = (task as Record<string, any>)[col];
    if (val === undefined) continue;
    if (JSON_COLUMNS.has(col)) {
      row[col] = val === null ? null : JSON.stringify(val);
    } else if (col === 'pinned') {
      row.pinned = val ? 1 : 0;
    } else {
      row[col] = val;
    }
  }

  // camelCase Task field → snake_case column.
  if ('_syncedAt' in task) {
    row._synced_at = (task as Record<string, any>)._syncedAt ?? null;
  }

  // Anything left over (not an explicit column, not _syncedAt) goes to payload.
  const payload: Record<string, any> = {};
  let hasPayload = false;
  for (const key of Object.keys(task)) {
    if (EXPLICIT_TASK_KEYS.has(key)) continue;
    const val = (task as Record<string, any>)[key];
    if (val === undefined) continue;
    payload[key] = val;
    hasPayload = true;
  }
  if (hasPayload) {
    row.payload = JSON.stringify(payload);
  } else if ('payload' in task) {
    // Explicit clear request.
    row.payload = null;
  }

  return row;
}

// Re-export the column list so task-manager / migration can build prepared
// statements without duplicating the ordering.
export const TASK_COLUMNS: readonly string[] = EXPLICIT_TASK_COLUMNS;

// ── Schema ─────────────────────────────────────────────────────────────────
// Idempotent. Safe to run on every open — matches the pattern in memory-index.ts.
// Keep comments in-file rather than in separate docs so schema drift is
// obvious during code review.
//
// IMPORTANT: SCHEMA_SQL must stay idempotent (all CREATE ... IF NOT EXISTS).
// One-time destructive migrations (DROP INDEX / DROP TABLE) live in
// ONE_TIME_MIGRATIONS below, gated by PRAGMA user_version.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    project TEXT,
    status TEXT,
    phase TEXT,
    priority TEXT,
    source TEXT,
    parent_task_id TEXT,
    due_date TEXT,
    start_date TEXT,
    created_at TEXT,
    updated_at TEXT,
    completed_at TEXT,
    sprint TEXT,
    focus_tier TEXT,
    pinned INTEGER DEFAULT 0,
    ext TEXT,
    tags TEXT,
    depends_on TEXT,
    session_ids TEXT,
    note TEXT,
    summary TEXT,
    description TEXT,
    conversation_log TEXT,
    sync_error TEXT,
    _synced_at TEXT,
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_category_project ON tasks(category, project);
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS tasks_source ON tasks(source);
  CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at);
  CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id);

  -- Plugin ext-id indexes are no longer baked into SCHEMA_SQL — each plugin
  -- declares its own ext-index spec via PluginApi.registerExtIndex, and the
  -- loader calls ensureExtIndexes() after plugins finish loading. This keeps
  -- core agnostic to which plugins exist and lets external plugins (loaded
  -- from ~/.open-walnut/plugins/) bring their own indexes without touching
  -- core code.

  CREATE TABLE IF NOT EXISTS task_categories (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    order_index INTEGER
  );

  -- Virtual task-group name registry (local-only). Maps Task.group_id (stored in
  -- the tasks.payload blob) to a human-readable group label. Membership itself
  -- lives on the tasks (tasks.group_id); this table only holds the names.
  CREATE TABLE IF NOT EXISTS task_groups (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  );

  -- User-defined focus tiers (local-only). Ids are ct_* strings referenced by
  -- tasks.focus_tier; order_index preserves the user's Settings ordering.
  CREATE TABLE IF NOT EXISTS custom_tiers (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    order_index INTEGER
  );
`;

/**
 * Schema version tracked via PRAGMA user_version.
 *
 * Why this exists: earlier releases ran `DROP INDEX IF EXISTS` + CREATE on
 * every open to let the plugin ext-id indexes change their json_extract path
 * (e.g. jira $.jira.key → $.jira.issue_key). That pays 40-400ms of CPU every
 * server start, even when the schema is already current.
 *
 * This gate runs each migration exactly once per database; subsequent opens
 * are a single cheap PRAGMA read.
 *
 * Bump SCHEMA_VERSION and add an `if (from < N)` branch for each new one-time
 * migration. Keep the branch append-only — never edit or reorder old ones.
 */
const SCHEMA_VERSION = 4;

function runOneTimeMigrations(handle: DatabaseType): void {
  const current = handle.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  if (current < 2) {
    // v1 → v2: drop the dead `task_projects` table that the initial migration
    // created but no runtime code reads or writes.
    //
    // Drop any stale plugin ext-id indexes from old releases — indexes whose
    // json_extract path drifted (e.g. jira originally pointed at $.jira.key
    // instead of $.jira.issue_key) need to disappear so the loader can
    // recreate them with the current path. We list a small known-stale set
    // by sniffing sqlite_master for any index name starting with the
    // historical prefix `idx_tasks_ext_` so we don't have to enumerate every
    // plugin id ever shipped.
    const staleIndexes = handle
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_tasks_ext_%'",
      )
      .all() as { name: string }[];
    for (const { name } of staleIndexes) {
      // Identifier comes from sqlite_master, not user input — safe to inline.
      handle.exec(`DROP INDEX IF EXISTS "${name}";`);
    }
    handle.exec(`DROP TABLE IF EXISTS task_projects;`);
    // We don't recreate the indexes here — the integration loader calls
    // ensureExtIndexes() after plugins are loaded, which recreates whatever
    // the currently-installed plugin set declares.
  }

  if (current < 3) {
    // v2 → v3: add the `hidden` flag to task_groups (Focus-area collapse). Older
    // DBs created the table without it; CREATE TABLE IF NOT EXISTS won't alter an
    // existing table, so add the column here. Guard against re-runs (a fresh DB
    // already has it from the current CREATE) by sniffing the column list.
    const cols = handle.prepare(`PRAGMA table_info(task_groups)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'hidden')) {
      handle.exec(`ALTER TABLE task_groups ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  if (current < 4) {
    // v3 → v4: add the `start_date` column ("start working on" time — drives the
    // Now view's deferral). CREATE TABLE IF NOT EXISTS won't alter an existing
    // table, so add it here; sniff the column list to stay re-run safe.
    const cols = handle.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'start_date')) {
      handle.exec(`ALTER TABLE tasks ADD COLUMN start_date TEXT;`);
    }
  }

  handle.pragma('user_version = ' + SCHEMA_VERSION);
}

// ── Dynamic ext-index management ───────────────────────────────────────────
// Plugins declare their ext-id indexes via PluginApi.registerExtIndex; the
// integration loader calls ensureExtIndexes(specs) after all plugins finish
// loading. CREATE INDEX IF NOT EXISTS is idempotent so this is safe to run
// on every server start.

const SAFE_IDENT = /^[a-z0-9_]+$/;

function sanitizeIdent(s: string): string {
  // Replace anything that isn't [a-z0-9_] with '_'. Both source ids (e.g.
  // 'ms-todo') and path keys go through this so the resulting index name
  // is always SQL-safe. Round-tripping ambiguity (two source ids collapsing
  // to the same sanitized form) is acceptable here — it would just mean
  // an extra IF NOT EXISTS no-op, not a security issue.
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * Open SQLite indexes declared by plugins. Idempotent — uses
 * `CREATE INDEX IF NOT EXISTS` so calling this on every server start is fine.
 *
 * Index naming: `idx_tasks_ext_<sanitized_source>_<sanitized_path_key>`.
 * Each index is partial (`WHERE source = '<source>'`) so it stays tight to
 * just the rows owned by that plugin.
 *
 * The `json_extract` path comes straight from the plugin spec. We validate
 * it loosely (must start with `$.` or `$[`) at the PluginApi layer; SQLite
 * itself will reject malformed paths at index-create time, surfacing the
 * error before the plugin runs any queries.
 */
export function ensureExtIndexes(specs: Iterable<ExtIndexSpec>): void {
  const handle = getDb();
  if (!handle) {
    throw new Error('ensureExtIndexes: task-db is not open');
  }
  for (const spec of specs) {
    const safeSource = sanitizeIdent(spec.source);
    // Escape the SQL string literal for the WHERE clause. We can't
    // parameterize partial-index predicates in SQLite, so quote-doubling
    // is the only option. Single quotes are the only metachar we need to
    // worry about.
    const sourceLiteral = spec.source.replace(/'/g, "''");
    for (const p of spec.paths) {
      if (!SAFE_IDENT.test(p.key)) {
        throw new Error(`ensureExtIndexes: path key "${p.key}" must match /^[a-z0-9_]+$/`);
      }
      const indexName = `idx_tasks_ext_${safeSource}_${p.key}`;
      // p.json was validated at registration time; we still wrap it as a
      // SQL string literal (json_extract accepts a string arg).
      const jsonLiteral = p.json.replace(/'/g, "''");
      const sql =
        `CREATE INDEX IF NOT EXISTS "${indexName}" ` +
        `ON tasks(json_extract(ext, '${jsonLiteral}')) ` +
        `WHERE source = '${sourceLiteral}';`;
      handle.exec(sql);
    }
  }
}

