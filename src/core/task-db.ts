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
import yaml from 'js-yaml';
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

/**
 * Retired Task keys. NOT columns and NOT allowed into the `payload` spillover
 * blob either — see the denylist in `taskToRow`. Project is the single grouping
 * layer, so `category` must never come back; `needs_attention` was renamed to
 * `unread` (v6 migration) and an old client spelling it must not resurrect a
 * second read marker beside the real one.
 */
const RETIRED_TASK_KEYS = new Set<string>(['category', 'needs_attention']);

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
    backfillNullTimestamps(handle);

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
 * for further normalization (phase migration, defaults, etc.) —
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
  // project is nullable in SQL and optional on Task ('' = Inbox). Normalize to ''
  // here so DB-loaded tasks never make callers choose between undefined and ''.
  if (typeof task.project !== 'string') task.project = '';
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
    // Retired keys are DROPPED, never spilled into payload. Without this a
    // legacy-shaped write (an old cloud op, a stale client, a `POST /api/tasks`
    // body spread) round-trips `task.category` back to life via the payload
    // blob — rowToTask merges payload keys onto the task object.
    if (RETIRED_TASK_KEYS.has(key)) continue;
    const val = (task as Record<string, any>)[key];
    if (val === undefined) continue;
    // null is the explicit-clear marker (same as the column path, where it
    // writes SQL NULL). For a payload field "cleared" = key ABSENT from the
    // blob — storing a literal null would leak back out of rowToTask as a
    // null field value, which the in-memory Task contract never carries. The
    // key still counts as payload-touching (hasPayload) so a patch that ONLY
    // clears a payload field still rewrites the payload column.
    if (val === null) { hasPayload = true; continue; }
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

// Project registry: the single grouping layer and the sync-claim point.
// Identity is case-insensitive (COLLATE NOCASE PK) so two spellings of the same
// project can never coexist. The empty project ('' = Inbox) never gets a row and
// can never be claimed by a provider.
//
// ⚠️ KNOWN, ACCEPTED ASYMMETRY: SQLite's NOCASE folds ASCII A-Z only, while JS
// `toLowerCase()` folds Unicode. So "Ärger" vs "ärger" are ONE project to every
// JS-side lookup but TWO distinct PK values to SQLite. The JS side is the
// ENFORCER of project identity (ensureProjectRowLocked does an explicit
// lowercased existence check under the write lock — it does NOT rely on
// ON CONFLICT); NOCASE is only the ASCII-case backstop for cross-process writes.
// metadata JSON: default_cwd, default_host, summary, summary_task_count,
//                legacy_category, remote_list.
// Future nesting = add a nullable `parent` column.
//
// Its own const because the historical v1→v2 migration DROPs a long-dead table
// of the same name — the v5 branch has to be able to recreate it after that.
const TASK_PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS task_projects (
    name        TEXT PRIMARY KEY COLLATE NOCASE,
    source      TEXT NOT NULL DEFAULT 'local',
    order_index INTEGER,
    metadata    TEXT
  );
`;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project);
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS tasks_source ON tasks(source);
  CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at);
  CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id);

  -- Composable task query (queryTasks in task-manager.ts) pushes time windows and
  -- phase sets into SQL. The trailing id keeps the query's stable tie-breaker
  -- (id ASC) inside the index, so a windowed top-N never needs the table.
  -- CREATE INDEX IF NOT EXISTS is idempotent → no PRAGMA user_version bump.
  -- Deliberately NOT indexed: pinned (a low-selectivity boolean).
  CREATE INDEX IF NOT EXISTS tasks_created_at_id ON tasks(created_at, id);
  CREATE INDEX IF NOT EXISTS tasks_updated_at_id ON tasks(updated_at, id);
  CREATE INDEX IF NOT EXISTS tasks_phase_updated_at_id ON tasks(phase, updated_at, id);

  -- Plugin ext-id indexes are no longer baked into SCHEMA_SQL — each plugin
  -- declares its own ext-index spec via PluginApi.registerExtIndex, and the
  -- loader calls ensureExtIndexes() after plugins finish loading. This keeps
  -- core agnostic to which plugins exist and lets external plugins (loaded
  -- from ~/.open-walnut/plugins/) bring their own indexes without touching
  -- core code.

  ${TASK_PROJECTS_DDL}

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
  -- Remote-identity ledger: which remote item ids this store has ever owned,
  -- released (ext cleared by a source migration), or deleted. Sync pull paths
  -- consult it so a remote id a local task once owned can NEVER mint a second
  -- local task (the fork bug: 141 tasks re-created under new ids, 35 losing
  -- their session links, before 2026-08-20). Replaces the ms-todo-only
  -- deletedMsIds array in ms-todo-delta.json, which was capped at 500 and
  -- silently evicted old tombstones.
  -- state: 'owned' | 'released' | 'deleted'.
  -- remote_delete_confirmed: for state='deleted', 1 once the remote item is
  -- verified gone (delete returned success or 404); the sync tick retries
  -- unconfirmed deletions so local deletes never block on network.
  CREATE TABLE IF NOT EXISTS task_remote_links (
    remote_source TEXT NOT NULL,
    remote_id     TEXT NOT NULL,
    task_id       TEXT,
    remote_list   TEXT,
    state         TEXT NOT NULL,
    reason        TEXT,
    remote_delete_confirmed INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (remote_source, remote_id)
  );
  CREATE INDEX IF NOT EXISTS task_remote_links_task ON task_remote_links(task_id);
  CREATE INDEX IF NOT EXISTS task_remote_links_unconfirmed
    ON task_remote_links(remote_source, state, remote_delete_confirmed)
    WHERE state = 'deleted' AND remote_delete_confirmed = 0;
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
/**
 * Exported so migration tests can assert "the DB ended up current" without
 * hardcoding a number that every future bump would break.
 */
export const SCHEMA_VERSION = 6;

function runOneTimeMigrations(handle: DatabaseType): void {
  const current = handle.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  if (current < 2) {
    // v1 → v2: drop the dead `task_projects` table that the initial migration
    // created but no runtime code reads or writes. NOTE: v5 reuses that name for
    // the live project registry, so it recreates the table right after — do not
    // "clean up" that seemingly redundant CREATE.
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

  if (current < 5) {
    // v4 → v5: category removal — Project becomes the single grouping layer.
    migrateToProjectOnly(handle);
  }

  if (current < 6) {
    // v5 → v6: `needs_attention` → `unread` (the read/unread marker rename).
    migrateReadMarkerToUnread(handle);
  }

  handle.pragma('user_version = ' + SCHEMA_VERSION);
}

// ── v5: category removal ───────────────────────────────────────────────────

/** Whole-file backup written once, before the v5 rewrite touches anything. */
export const TASK_DB_PRE_V5_BACKUP_PATH = `${TASK_DB_PATH}.pre-v5.backup`;

/**
 * Legacy MS To-Do list-name encoding (the old `buildListName`): "Cat / Proj",
 * or just the category when the two matched. Used to pre-seed the
 * `remote_list` alias so pushes keep landing in the existing remote list.
 *
 * Exported so the JSON→SQLite importer seeds the SAME alias (task-db-migration.ts).
 */
export function legacyListName(category: string, project: string): string {
  // Case-insensitive equality: everything else in this migration folds case, and
  // MS To-Do list lookup lowercases too, so "Work"/"work" was ONE list named
  // "Work" — not "Work / work".
  if (!category || !project || category.toLowerCase() === project.toLowerCase()) {
    return category || project;
  }
  return `${category} / ${project}`;
}

/**
 * Majority-weighted provider claim for a project merged from several legacy
 * categories: the provider owning the most TASKS wins; a genuine tie (or no
 * provider at all) falls back to 'local', loudly.
 *
 * Weighting by task count — not by distinct contributing category, which counts a
 * 1-task straggler as much as a 700-task group — matters on real data: a project
 * merged from a 722-task ms-todo category plus one stray task filed under another
 * provider's category IS an ms-todo project, and labelling it `local` would make
 * pushTask refuse all 722 (it hard-refuses any task whose project registry row
 * names a different source).
 *
 * Shared by BOTH migration paths (v4→v5 SQLite, and the JSON→SQLite importer) so
 * they can never diverge on the claim a project ends up with.
 */
export function pickMajoritySource(
  weights: Map<string, number>,
  projectName: string,
): string {
  const ranked = [...weights.entries()]
    .filter(([src, n]) => src && src !== 'local' && n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (ranked.length === 0) return 'local';
  if (ranked.length === 1) return ranked[0][0];
  if (ranked[0][1] > ranked[1][1]) {
    log.task.warn('task-db: project merged categories from several providers, majority wins', {
      project: projectName, source: ranked[0][0], weights: Object.fromEntries(ranked),
    });
    return ranked[0][0];
  }
  log.task.warn('task-db: project merged categories with tied sources, using local', {
    project: projectName, weights: Object.fromEntries(ranked),
  });
  return 'local';
}

function parseYamlObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text || !text.trim()) return null;
  try {
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    log.task.warn('task-db v5: metadata YAML parse failed', { err: String(err) });
  }
  return null;
}

/** Copy keys that aren't already present. First writer wins; conflicts are logged. */
function mergeFirstWins(
  target: Record<string, unknown>,
  src: Record<string, unknown>,
  context: string,
): void {
  for (const [key, value] of Object.entries(src)) {
    if (key in target) {
      if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
        log.task.warn('task-db v5: metadata conflict, keeping first value', { context, key });
      }
      continue;
    }
    target[key] = value;
  }
}

/**
 * Target project name for a legacy (category, project) pair.
 *
 * Rules (locked in the refactor plan):
 *  - "Quick Start" under ANY category was a routing artifact → Inbox ('').
 *  - Degenerate group (project empty, or equal to the category case-insensitively):
 *    the category carried the grouping information, so its name is promoted to
 *    the project name — EXCEPT category 'Inbox' (or no category), which is Inbox.
 *  - Otherwise the real project name survives unchanged.
 *
 * WHY promote the degenerate group instead of flattening it to Inbox:
 *  1. Inbox has NO registry row by design, so a flatten would throw away the
 *     grouping entirely — `legacy_category`, `default_cwd`, and the provider
 *     claim have nowhere to live.
 *  2. It preserves the MS To-Do list correspondence: the legacy list for a
 *     degenerate group was named after the category alone (see `legacyListName`),
 *     so promoting the category name keeps `remote_list` resolvable and pushes
 *     landing in the list the account already has.
 *  3. Measured stakes on real data: ~1200 tasks sit in degenerate groups vs ~330
 *     in the genuinely-Inbox ones — flattening would have dumped the bulk of the
 *     store into an unstructured, unclaimable bucket.
 *
 * The pull side MUST agree with this rule or sync undoes the migration — see
 * `routePulledListToProject` in src/utils/format.ts.
 */
export function promoteLegacyGroup(category: string, project: string): string {
  const cat = (category ?? '').trim();
  const proj = (project ?? '').trim();
  if (proj.toLowerCase() === 'quick start') return '';
  if (!proj || proj.toLowerCase() === cat.toLowerCase()) {
    if (!cat || cat.toLowerCase() === 'inbox') return '';
    return cat;
  }
  return proj;
}

interface LegacyGroup {
  /** Raw column values — used verbatim in the UPDATE's WHERE clause. */
  category: string | null;
  project: string | null;
  taskCount: number;
  target: string;
  /** Canonical spelling after the case-insensitive merge. */
  final: string;
}

function migrateToProjectOnly(handle: DatabaseType): void {
  // MUST come before the sniff below: on a fresh DB every branch runs, and the
  // historical v1→v2 branch DROPs a long-dead table that now shares this name —
  // so it deletes the registry SCHEMA_SQL just created. Re-assert it here.
  handle.exec(TASK_PROJECTS_DDL);

  const cols = handle.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'category')) {
    // Fresh install (SCHEMA_SQL already project-only) or an already-migrated DB
    // whose user_version somehow lagged. Nothing to rewrite.
    return;
  }

  // ── Backup (never overwrite: the FIRST pre-v5 snapshot is the valuable one) ──
  try {
    handle.pragma('wal_checkpoint(TRUNCATE)');
    if (!fs.existsSync(TASK_DB_PRE_V5_BACKUP_PATH)) {
      fs.copyFileSync(TASK_DB_PATH, TASK_DB_PRE_V5_BACKUP_PATH);
      log.task.info('task-db v5: wrote pre-migration backup', { path: TASK_DB_PRE_V5_BACKUP_PATH });
    }
  } catch (err) {
    // A missing backup must not block the migration — the user would be stuck on
    // a schema the running code can no longer read.
    log.task.warn('task-db v5: backup failed (continuing)', {
      path: TASK_DB_PRE_V5_BACKUP_PATH,
      err: String(err),
    });
  }

  const summary = handle.transaction(() => {
    // 1. Sentinel metadata tasks → plain objects, then delete the rows.
    const sentinels = handle
      .prepare(
        `SELECT category, project, title, description FROM tasks
          WHERE title IN ('.metadata_project', '.metadata_category')`,
      )
      .all() as { category: string | null; project: string | null; title: string; description: string | null }[];

    const catMeta = new Map<string, Record<string, unknown>>();  // lower(category) → settings
    const projMeta = new Map<string, Record<string, unknown>>(); // "lower(cat) lower(proj)" → settings
    const sentinelPairs: { category: string | null; project: string | null }[] = [];
    for (const row of sentinels) {
      const cat = (row.category ?? '').trim().toLowerCase();
      const settings = parseYamlObject(row.description);
      if (row.title === '.metadata_category') {
        if (!settings) continue;
        const bucket = catMeta.get(cat) ?? {};
        mergeFirstWins(bucket, settings, `category:${cat}`);
        catMeta.set(cat, bucket);
        continue;
      }
      // Project-level sentinel: remember the pair so a project whose only row
      // was the sentinel still gets a registry row (it may hold default_cwd).
      sentinelPairs.push({ category: row.category, project: row.project });
      if (!settings) continue;
      const key = `${cat}\u0000${(row.project ?? '').trim().toLowerCase()}`;
      const bucket = projMeta.get(key) ?? {};
      mergeFirstWins(bucket, settings, `project:${key}`);
      projMeta.set(key, bucket);
    }
    handle
      .prepare(`DELETE FROM tasks WHERE title IN ('.metadata_project', '.metadata_category')`)
      .run();

    // 2. Group snapshot (post-sentinel-deletion so sentinels can't skew counts).
    const groups: LegacyGroup[] = (
      handle
        .prepare(`SELECT category, project, COUNT(*) AS n FROM tasks GROUP BY category, project`)
        .all() as { category: string | null; project: string | null; n: number }[]
    ).map((r) => ({
      category: r.category,
      project: r.project,
      taskCount: r.n,
      target: promoteLegacyGroup(r.category ?? '', r.project ?? ''),
      final: '',
    }));
    for (const pair of sentinelPairs) {
      const exists = groups.some((g) => g.category === pair.category && g.project === pair.project);
      if (exists) continue;
      groups.push({
        category: pair.category,
        project: pair.project,
        taskCount: 0,
        target: promoteLegacyGroup(pair.category ?? '', pair.project ?? ''),
        final: '',
      });
    }

    // 3. Case-insensitive canonical spelling: most tasks wins, ties alphabetical.
    const spellings = new Map<string, Map<string, number>>();
    for (const g of groups) {
      if (!g.target) continue;
      const lower = g.target.toLowerCase();
      const bySpelling = spellings.get(lower) ?? new Map<string, number>();
      bySpelling.set(g.target, (bySpelling.get(g.target) ?? 0) + g.taskCount);
      spellings.set(lower, bySpelling);
    }
    const canonical = new Map<string, string>();
    for (const [lower, bySpelling] of spellings) {
      const best = [...bySpelling.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )[0][0];
      canonical.set(lower, best);
    }
    for (const g of groups) {
      g.final = g.target ? (canonical.get(g.target.toLowerCase()) ?? g.target) : '';
    }

    // 4. Rewrite tasks.project. Null-safe WHERE (`IS`) because project was nullable.
    const updateGroup = handle.prepare(
      `UPDATE tasks SET project = @project WHERE category IS @category AND project IS @old`,
    );
    for (const g of groups) {
      if ((g.project ?? '') === g.final) continue;
      updateGroup.run({ project: g.final, category: g.category, old: g.project });
    }

    // 5. Populate task_projects.
    let legacyCatSources = new Map<string, string>(); // lower(category) → source
    let catOrder: string[] = [];
    try {
      const rows = handle
        .prepare(
          `SELECT name, source FROM task_categories
            ORDER BY (order_index IS NULL), order_index, name`,
        )
        .all() as { name: string; source: string | null }[];
      catOrder = rows.map((r) => r.name);
      legacyCatSources = new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.source || 'local']));
    } catch {
      // No task_categories table (very old or hand-made DB) — everything is local.
    }

    // Contributors per canonical project.
    const contributors = new Map<string, LegacyGroup[]>(); // lower(final) → groups
    for (const g of groups) {
      if (!g.final) continue;
      const key = g.final.toLowerCase();
      const list = contributors.get(key) ?? [];
      list.push(g);
      contributors.set(key, list);
    }

    // order_index: old category order expanded, projects alphabetical within a
    // category, first appearance wins.
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    const catsInOrder = [
      ...catOrder,
      ...[...new Set(groups.map((g) => (g.category ?? '').trim()))]
        .filter((c) => !catOrder.some((k) => k.trim().toLowerCase() === c.toLowerCase()))
        .sort(),
    ];
    for (const cat of catsInOrder) {
      const names = [
        ...new Set(
          groups
            .filter((g) => g.final && (g.category ?? '').trim().toLowerCase() === cat.trim().toLowerCase())
            .map((g) => g.final),
        ),
      ].sort();
      for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        orderedKeys.push(key);
      }
    }
    for (const key of [...contributors.keys()].sort()) {
      if (!seen.has(key)) { seen.add(key); orderedKeys.push(key); }
    }

    const insertProject = handle.prepare(
      `INSERT INTO task_projects (name, source, order_index, metadata)
       VALUES (@name, @source, @order_index, @metadata)
       ON CONFLICT(name) DO NOTHING`,
    );

    // Minority-source normalization (mirrors task-manager's migrateTaskSource).
    // The registry row carries ONE claim, and pushTask hard-refuses any task whose
    // project's row names a different source — so after the majority-weighted pick
    // above, every task in that project with a losing source would be permanently
    // unpushable. Adopt the winning claim and drop the stale remote identity
    // (`ext` / `external_url` / `sync_error`) so the next sync tick re-creates a
    // twin in the right place instead of PATCHing a twin in the wrong list.
    //
    // LOCAL tasks are exempt: a local task parked in a provider project is a
    // deliberate never-sync state (quick-start tasks live like this), not an
    // unpushable orphan. Promoting it here would re-open the duplicate-import
    // loop this exemption exists to close. NULL source counts as local.
    const selectMinority = handle.prepare(
      `SELECT id, source FROM tasks WHERE project = @name COLLATE NOCASE AND source IS NOT @source
         AND source IS NOT NULL AND source != 'local'`,
    );
    const normalizeMinority = handle.prepare(
      `UPDATE tasks SET source = @source, ext = NULL, sync_error = NULL, updated_at = @now,
         payload = CASE WHEN payload IS NOT NULL AND json_valid(payload)
                        THEN json_remove(payload, '$.external_url') ELSE payload END
        WHERE id = @id`,
    );
    const nowIso = new Date().toISOString();
    let normalizedMinorityTotal = 0;

    const perProject: Record<string, unknown>[] = [];
    orderedKeys.forEach((key, index) => {
      const groupsForProject = contributors.get(key);
      if (!groupsForProject || groupsForProject.length === 0) return;
      const name = groupsForProject[0].final;
      const taskCount = groupsForProject.reduce((sum, g) => sum + g.taskCount, 0);

      // Source inheritance: majority-weighted by task count (see
      // pickMajoritySource — shared with the JSON→SQLite importer).
      const providerWeights = new Map<string, number>();
      for (const g of groupsForProject) {
        const src = legacyCatSources.get((g.category ?? '').trim().toLowerCase()) ?? 'local';
        if (!src || src === 'local') continue;
        providerWeights.set(src, (providerWeights.get(src) ?? 0) + g.taskCount);
      }
      const source = pickMajoritySource(providerWeights, name);

      // Metadata: category-level sentinels form the base, project-level ones
      // override (mirrors the retired getProjectMetadata resolution chain).
      const base: Record<string, unknown> = {};
      const overlay: Record<string, unknown> = {};
      for (const g of groupsForProject) {
        const cat = (g.category ?? '').trim().toLowerCase();
        const fromCat = catMeta.get(cat);
        if (fromCat) mergeFirstWins(base, fromCat, `${name}<-category:${cat}`);
        const fromProj = projMeta.get(`${cat}\u0000${(g.project ?? '').trim().toLowerCase()}`);
        if (fromProj) mergeFirstWins(overlay, fromProj, `${name}<-project:${cat}/${g.project ?? ''}`);
      }
      const metadata: Record<string, unknown> = { ...base, ...overlay };

      const legacyCats = [
        ...new Set(groupsForProject.map((g) => (g.category ?? '').trim()).filter(Boolean)),
      ].sort();
      if (legacyCats.length === 1) metadata.legacy_category = legacyCats[0];
      else if (legacyCats.length > 1) metadata.legacy_category = legacyCats;

      // remote_list alias: keep pushing into the MS To-Do list the account
      // already has ("Cat / Proj"), instead of forking a new one named after the
      // project. Only ms-todo encodes the grouping into the remote list name.
      if (source === 'ms-todo') {
        const owned = groupsForProject
          .filter((g) => (legacyCatSources.get((g.category ?? '').trim().toLowerCase()) ?? 'local') === source)
          .sort((a, b) => b.taskCount - a.taskCount);
        const pick = owned[0];
        if (pick) {
          const oldList = legacyListName((pick.category ?? '').trim(), (pick.project ?? '').trim());
          if (oldList && oldList !== name) metadata.remote_list = oldList;
          if (owned.length > 1) {
            log.task.warn('task-db v5: ambiguous remote list for merged project', {
              project: name,
              picked: oldList,
              candidates: owned.length,
            });
          }
        }
      }

      insertProject.run({
        name,
        source,
        order_index: index,
        metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      });

      // Adopt the winning claim on every task the pick left behind.
      const minority = selectMinority.all({ name, source }) as { id: string; source: string | null }[];
      const minorityBySource: Record<string, number> = {};
      for (const row of minority) {
        normalizeMinority.run({ id: row.id, source, now: nowIso });
        const from = row.source ?? 'local';
        minorityBySource[from] = (minorityBySource[from] ?? 0) + 1;
      }
      if (minority.length > 0) {
        log.task.warn('task-db v5: normalized minority-source tasks onto the project claim', {
          project: name, source, tasks: minority.length, from: minorityBySource,
        });
        normalizedMinorityTotal += minority.length;
      }

      perProject.push({
        project: name,
        source,
        tasks: taskCount,
        from: groupsForProject.map((g) => `${g.category ?? ''}/${g.project ?? ''}`),
        remote_list: metadata.remote_list,
        ...(minority.length > 0
          ? { normalized_minority: minority.length, normalized_from: minorityBySource }
          : {}),
      });
    });

    const inboxCount = groups.filter((g) => !g.final).reduce((sum, g) => sum + g.taskCount, 0);

    // 5b. Provider-sourced tasks that landed in Inbox ('') — the degenerate
    //     "Quick Start under a provider-claimed category" shape. Inbox has NO
    //     registry row and can never be claimed, so the model's invariant is
    //     "a provider task requires a non-empty project" (addTaskFull and
    //     validateProjectSource both enforce it). Leaving them provider-sourced
    //     would mean pushTask refuses them forever AND every read sees a state
    //     the create path would reject. Reset to local + clear the remote
    //     identity, so they are honest local Inbox tasks.
    const inboxProviderRows = handle
      .prepare(
        `SELECT id, source FROM tasks
          WHERE (project IS NULL OR project = '') AND source IS NOT NULL AND source != 'local'`,
      )
      .all() as { id: string; source: string }[];
    const inboxProviderBySource: Record<string, number> = {};
    if (inboxProviderRows.length > 0) {
      const toLocal = handle.prepare(
        `UPDATE tasks SET source = 'local', ext = NULL, sync_error = NULL, updated_at = @now,
           payload = CASE WHEN payload IS NOT NULL AND json_valid(payload)
                          THEN json_remove(payload, '$.external_url') ELSE payload END
          WHERE id = @id`,
      );
      for (const row of inboxProviderRows) {
        toLocal.run({ id: row.id, now: nowIso });
        inboxProviderBySource[row.source] = (inboxProviderBySource[row.source] ?? 0) + 1;
      }
      log.task.warn('task-db v5: reset provider-sourced Inbox tasks to local', {
        tasks: inboxProviderRows.length, from: inboxProviderBySource,
      });
    }

    // 6. Drop the category column. Index MUST go first — SQLite refuses to drop
    //    an indexed column.
    //    Requires SQLite >= 3.35 for ALTER TABLE ... DROP COLUMN (added 2021-03).
    //    better-sqlite3 bundles its own amalgamation (3.51 at time of writing), so
    //    the host's sqlite3 version is irrelevant — but a future switch to a
    //    system-linked build must re-check this.
    handle.exec(`DROP INDEX IF EXISTS tasks_category_project;`);
    handle.exec(`ALTER TABLE tasks DROP COLUMN category;`);
    handle.exec(`DROP TABLE IF EXISTS task_categories;`);

    return {
      perProject,
      inboxCount,
      sentinels: sentinels.length,
      normalizedMinority: normalizedMinorityTotal,
      inboxProviderReset: inboxProviderRows.length,
      inboxProviderResetFrom: inboxProviderBySource,
    };
  })();

  log.task.info('task-db v5: category removed — project is now the only grouping layer', {
    projects: summary.perProject.length,
    inboxTasks: summary.inboxCount,
    sentinelsAbsorbed: summary.sentinels,
    normalizedMinoritySourceTasks: summary.normalizedMinority,
    inboxProviderTasksResetToLocal: summary.inboxProviderReset,
    inboxProviderResetFrom: summary.inboxProviderResetFrom,
    perProject: summary.perProject,
  });
}

// ── v6: read-marker rename ─────────────────────────────────────────────────

/**
 * v5 → v6: fold the retired `needs_attention` marker into `unread`.
 *
 * The marker never had a column — it lives inside the `payload` JSON blob — so
 * this is JSON surgery, not an ALTER TABLE. Two statements, in this order:
 *
 *   1. Carry `true` forward as `unread: true`, but only where `unread` isn't
 *      already set (a task written after the rename is already correct and its
 *      value wins).
 *   2. Delete the retired key from every row. `false` is dropped rather than
 *      copied: absent means read, so `unread: false` would be pure noise.
 *
 * `updated_at` is deliberately NOT touched. The marker is viewer state, not task
 * content — bumping it would reshuffle every updated_at-sorted list on upgrade.
 */
function migrateReadMarkerToUnread(handle: DatabaseType): void {
  const summary = handle.transaction(() => {
    const carried = handle
      .prepare(
        `UPDATE tasks SET payload = json_set(payload, '$.unread', json('true'))
          WHERE payload IS NOT NULL AND json_valid(payload)
            AND json_extract(payload, '$.needs_attention') IN (1, 'true')
            AND json_extract(payload, '$.unread') IS NULL`,
      )
      .run().changes;
    const cleared = handle
      .prepare(
        `UPDATE tasks SET payload = json_remove(payload, '$.needs_attention')
          WHERE payload IS NOT NULL AND json_valid(payload)
            AND json_extract(payload, '$.needs_attention') IS NOT NULL`,
      )
      .run().changes;
    return { carried, cleared };
  })();

  if (summary.cleared > 0) {
    log.task.info('task-db v6: read marker renamed needs_attention → unread', summary);
  }
}

// ── Timestamp backfill (idempotent, runs on every open) ────────────────────
// Deliberately NOT a numbered one-time migration: the WHERE clause matches
// nothing once repaired, so re-running is a single cheap SELECT — and keeping
// it out of the version chain lets it land independently of concurrent
// migration work.

/**
 * Decode the base36 millisecond timestamp that generateId() embeds before the
 * dash. Returns an ISO string, or null when the prefix doesn't decode to a
 * plausible time (imported/foreign ids). Exported for the migration test.
 */
export function timestampFromTaskId(id: string): string | null {
  const prefix = id.split('-')[0];
  if (!prefix || !/^[0-9a-z]+$/.test(prefix)) return null;
  const ms = parseInt(prefix, 36);
  // Plausibility window: 2020-01-01 .. 2100-01-01. Outside it the prefix is
  // not one of ours (e.g. an imported id that happens to parse).
  if (!Number.isFinite(ms) || ms < 1577836800000 || ms > 4102444800000) return null;
  return new Date(ms).toISOString();
}

/**
 * Backfill NULL timestamps. Bulk sync paths historically inserted rows with
 * NULL created_at/updated_at/_synced_at, which zeroes the reconciler's
 * Last-Write-Wins threshold (max(_syncedAt, updated_at)) and made those rows
 * re-update every cycle forever (2026-08-20: 28 identical `updated 1197`
 * cycles; 1,551 NULL-created_at rows). Seeds created_at from the base36
 * timestamp inside the task id, falling back to updated_at, then now.
 */
function backfillNullTimestamps(handle: DatabaseType): void {
  const summary = handle.transaction(() => {
    let createdFixed = 0;
    let updatedFixed = 0;
    let syncedFixed = 0;
    const rows = handle
      .prepare(
        `SELECT id, created_at, updated_at, _synced_at, source FROM tasks
          WHERE created_at IS NULL OR created_at = ''
             OR updated_at IS NULL OR updated_at = ''
             OR ((_synced_at IS NULL OR _synced_at = '') AND source != 'local')`,
      )
      .all() as Array<{ id: string; created_at: string | null; updated_at: string | null; _synced_at: string | null; source: string | null }>;
    const upd = handle.prepare(
      `UPDATE tasks SET created_at = @created_at, updated_at = @updated_at, _synced_at = @_synced_at WHERE id = @id`,
    );
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const fromId = timestampFromTaskId(row.id);
      const created = row.created_at || fromId || row.updated_at || nowIso;
      const updated = row.updated_at || created;
      // Synced rows (non-local source) with no _synced_at: stamp it equal to
      // updated_at so the LWW threshold reflects "as of now, believed in sync".
      // A genuinely newer remote edit still wins (remoteTime > threshold).
      const synced = row.source && row.source !== 'local'
        ? (row._synced_at || updated)
        : row._synced_at;
      if (!row.created_at) createdFixed++;
      if (!row.updated_at) updatedFixed++;
      if (synced !== row._synced_at) syncedFixed++;
      upd.run({ id: row.id, created_at: created, updated_at: updated, _synced_at: synced ?? null });
    }
    return { rows: rows.length, createdFixed, updatedFixed, syncedFixed };
  })();

  if (summary.rows > 0) {
    log.task.info('task-db: backfilled NULL timestamps (LWW threshold repair)', summary);
  }
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

