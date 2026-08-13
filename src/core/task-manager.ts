import fsSync from 'node:fs';
import { TASKS_FILE } from '../constants.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';
import { generateId, isLegacyInboxGroup, isRetiredQuickStartGroup } from '../utils/format.js';
import { initDirectories } from './init.js';
import { getConfig, updateConfig } from './config-manager.js';
import { bus, EventNames } from './event-bus.js';
import { VALID_PRIORITIES as VALID_PRIORITIES_ARRAY, READ_MARKER_KEYS, type Task, type TaskStore, type TaskStatus, type TaskPhase, type TaskPriority, type TaskSource, type DashboardData, type ProjectRecord, type TaskGroupRecord, type CustomTierRecord } from './types.js';
import { applyPhase, deriveStatusFromPhase, phaseFromStatus, VALID_PHASES, TERMINAL_PHASES } from './phase.js';
import { registry } from './integration-registry.js';
import { getDb, rowToTask, taskToRow, TASK_COLUMNS, transaction as dbTransaction, TASK_DB_PATH } from './task-db.js';
import { runMigrationIfNeeded } from './task-db-migration.js';
import { migrateProjectMemoryDirs } from './memory-dir-migration.js';
import { getExtIndexSpec } from './ext-index-registry.js';

// CJK detection regex — used only for log enrichment so that "plugin not loaded"
// warnings flag the cases that an external sync plugin's validateContent would
// have rejected.
const CJK_DETECT_REGEX = /[一-鿿㐀-䶿぀-ヿ]/;

/** A sync plugin's validateContent rejected a write. Typed (vs a bare Error) so
 *  AI writers can tell "the content broke a plugin rule — regenerate with the
 *  rule as feedback" apart from real failures. `.message` is the plugin's own
 *  human-readable reason, suitable to feed back to a model verbatim. */
export class ContentValidationError extends Error {
  constructor(message: string, public field: string) {
    super(message);
    this.name = 'ContentValidationError';
  }
}

/** The plugin's stated content rule for a field — what an AI generator should
 *  know BEFORE generating (vs validatePluginContent, which judges a candidate
 *  after). Returns null when the task's plugin has no rule for the field. */
export function pluginContentRequirement(task: { source: string }, field: string): string | null {
  return registry.get(task.source)?.sync.contentRequirement?.(field) ?? null;
}

/** Non-throwing plugin content check — returns the plugin's human-readable
 *  rejection reason, or null when the content is acceptable (or no plugin /
 *  no validator). Exported so AI writers (session-auto-title) can check a
 *  candidate value BEFORE writing and regenerate, instead of learning about
 *  the rule from a thrown write. */
export function validatePluginContent(task: { source: string; id?: string }, field: string, value: string): string | null {
  const plugin = registry.get(task.source);
  if (!plugin) {
    // Loophole detector: plugin failed to load → silent-pass means content guards
    // are fully bypassed. Surface CJK content explicitly so we can trace any new
    // Chinese-into-external-system regression back to a concrete write site.
    const hasCJK = typeof value === 'string' && CJK_DETECT_REGEX.test(value);
    log.task.warn('content validation skipped: plugin not loaded', {
      source: task.source,
      field,
      taskId: (task as Task).id,
      hasCJK,
      preview: typeof value === 'string' ? value.slice(0, 200) : undefined,
      stack: hasCJK ? new Error().stack : undefined,
    });
    return null;
  }
  if (!plugin.sync.validateContent) return null;
  return plugin.sync.validateContent(task as Task, field, value) ?? null;
}

/** Ask the task's plugin to validate content before writing. Throws on rejection. */
function runPluginContentValidation(task: { source: string; id?: string }, field: string, value: string): void {
  const error = validatePluginContent(task, field, value);
  if (error) {
    log.task.info('content validation rejected', { source: task.source, field, taskId: (task as Task).id, error });
    throw new ContentValidationError(error, field);
  }
}

/**
 * The retired sentinel-task shape. `.metadata_project` / `.metadata_category`
 * tasks used to carry per-group settings; those now live in the `task_projects`
 * registry row's `metadata` blob and the v5 migration deleted the task rows.
 *
 * Matched by PREFIX (not exact title) because the whole `.metadata*` namespace is
 * retired — readers across the codebase already filter on
 * `title.startsWith('.metadata')`, so anything in that namespace would be an
 * invisible phantom row.
 */
export function isRetiredSentinelTitle(title: string | undefined | null): boolean {
  return (title ?? '').trim().startsWith('.metadata');
}

let initialized = false;

// ── Whole-store read cache ────────────────────────────────────────────────
// readStore() runs `SELECT * FROM tasks` + rows.map(rowToTask) over the WHOLE
// table (3000+ rows, each with JSON columns parsed per row) on EVERY call. It
// is the second hot whole-store scan behind the simultaneous-15s-timeout root
// cause: /api/tasks runs it once, then enrichTasksWithSessionStatus runs a
// sessions scan too, and it re-runs uncached on every concurrent request. The
// single scan is ~50-84ms but the REPETITION under load is the bug.
//
// Fix: cache the mapped store and serve it until the next write. Every mutation
// — single-row (updateTask/addTask/…), per-row fast paths (updateTaskRaw,
// updateTasksBulk, addTasksBulk, deleteTasksBulk), and whole-store writeStore —
// funnels through withWriteLock (verified), so invalidating in that lock's
// finally is the single correct hook. readStore() returns per-call clones so
// the many helpers that filter/sort/mutate store.tasks in place can't poison
// the cache. Env-gated for instant prod revert.
const STORE_CACHE_ENABLED = process.env.WALNUT_STORE_CACHE !== '0';
let taskStoreCache: TaskStore | null = null;
// data_version observed when the cache was filled. `PRAGMA data_version` bumps
// when ANOTHER connection commits (our own writes don't move it — they
// invalidate via withWriteLock.finally instead), so a mismatch on a cache hit
// means an external process wrote the DB and the snapshot is stale. Without
// this check a second server process sharing the DB file reads its stale
// cache, and writeStore()'s full-snapshot delete-diff then ERASES the rows the
// other process created (2026-08-04 task-loss incident — a stray second server
// on :3467 silently deleted every task created via :3456).
let taskStoreCacheDataVersion: number | null = null;

/** Drop the cached whole-store snapshot. Called from withWriteLock.finally. */
function invalidateTaskStoreCache(): void {
  taskStoreCache = null;
  taskStoreCacheDataVersion = null;
}

// ── Row shadow: makes writeStore() write only the rows that changed ──
//
// writeStore() takes a whole-store snapshot, so without this it re-INSERTs every
// task on every edit (O(all tasks) per one-field change). The shadow records, for
// the last snapshot we persisted, each row's serialized column tuple AND the row
// order, letting writeStore skip untouched rows.
//
// ORDER IS PART OF THE STATE, not just content. `store.tasks` array order is
// persisted implicitly as SQLite rowid order: INSERT OR REPLACE deletes and
// re-inserts a row, giving it a fresh (highest) rowid, and readStore() does a bare
// `SELECT * FROM tasks`. That's how reorderTasks() works — it PERMUTES array slots
// without changing any field, so a content-only diff would see zero changes and
// silently drop the reorder. Hence: any permutation of surviving rows forces a full
// ordered rewrite; only append-at-the-end (the addTask case) stays incremental.
//
// Trust boundary: `PRAGMA data_version` changes when ANOTHER connection commits
// (our own commits don't bump it), so a mismatch means someone else wrote the DB
// and our shadow may be stale → we fall back to a full rewrite and re-seed. That
// makes a stale shadow a performance question, never a correctness one.
interface RowShadow {
  /** taskId → serialized column tuple as last persisted. */
  fingerprints: Map<string, string>;
  /** Row order as last persisted (== SQLite rowid order). */
  order: string[];
}
let rowShadow: RowShadow | null = null;
let rowShadowDataVersion: number | null = null;
/** Shadow built inside the current transaction, published only on commit. */
let pendingRowShadow: RowShadow | null = null;

type SqliteHandle = Pick<import('better-sqlite3').Database, 'pragma'>;

function readDataVersion(handle: SqliteHandle): number | null {
  try {
    return handle.pragma('data_version', { simple: true }) as number;
  } catch {
    return null; // pragma unavailable — behave as if un-shadowed (full rewrite)
  }
}

/** The shadow, but only if no foreign connection has committed since we built it. */
function rowShadowIfCurrent(handle: SqliteHandle): RowShadow | null {
  if (!rowShadow || rowShadowDataVersion === null) return null;
  const current = readDataVersion(handle);
  if (current === null || current !== rowShadowDataVersion) return null;
  return rowShadow;
}

/**
 * True when `nextIds` keeps the shadow's relative order for every row that still
 * exists, i.e. the change is only removals and/or appends at the end. In that case
 * surviving rows keep their rowid ordering and need no positional rewrite.
 * A genuine permutation (reorderTasks) returns false → caller does a full rewrite.
 */
function preservesShadowOrder(shadow: RowShadow, nextIds: string[]): boolean {
  const nextSet = new Set(nextIds);
  const survivors = shadow.order.filter((id) => nextSet.has(id));
  // survivors must be a PREFIX of nextIds (anything past it is newly appended).
  if (survivors.length > nextIds.length) return false;
  for (let i = 0; i < survivors.length; i++) {
    if (nextIds[i] !== survivors[i]) return false;
  }
  return true;
}

/** Adopt the shadow built by a transaction that committed successfully. */
function commitRowShadow(): void {
  if (!pendingRowShadow) return;
  rowShadow = pendingRowShadow;
  pendingRowShadow = null;
  const db = getDb();
  rowShadowDataVersion = db ? readDataVersion(db) : null;
}

/**
 * Drop the shadow after a write that did NOT go through writeStore().
 *
 * The per-row fast paths (updateTaskRaw, updateTasksBulk, addTasksBulk,
 * deleteTasksBulk) issue targeted UPDATE/INSERT/DELETE on OUR OWN connection, so
 * `data_version` does not move and the staleness check can't see them. Without
 * this, the shadow would still claim the pre-patch value and the next
 * writeStore() would skip re-writing a row that genuinely changed. Cost of
 * dropping it: exactly one full rewrite on the next whole-store write.
 */
function invalidateRowShadow(): void {
  rowShadow = null;
  rowShadowDataVersion = null;
}

/** Reset internal flags for test isolation (call in beforeEach). */
export function _resetForTesting(): void {
  initialized = false;
  taskStoreCache = null;
  taskStoreCacheDataVersion = null;
  rowShadow = null;
  rowShadowDataVersion = null;
  pendingRowShadow = null;
  writeLockDepth = 0;
}

// ── Write lock: serializes all read-modify-write operations ──
// Two layers: in-process promise chain + cross-process file lock.
// The promise chain prevents concurrent async operations within the server.
// The file lock prevents races with hook child processes (on-stop, on-compact).
let writeLock: Promise<void> = Promise.resolve();
// Depth of the currently-executing locked section. The lock serializes, so this
// is 0 or 1 in practice; it exists so a helper reachable BOTH from inside a
// locked section and from a bare call can avoid self-deadlocking (the file lock
// is not re-entrant — a nested acquire waits out the full 10s timeout and
// throws). See withWriteLockIfFree.
let writeLockDepth = 0;

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  // Invalidate the whole-store read cache after EVERY locked mutation. All
  // writers — single-row, per-row fast paths (updateTaskRaw/*Bulk), and
  // writeStore — funnel through this lock, so this one hook keeps the cache
  // correct without enumerating writers.
  return prev
    .then(() => withFileLock(TASKS_FILE, async () => {
      writeLockDepth += 1;
      try { return await fn(); } finally { writeLockDepth -= 1; }
    }))
    .finally(() => {
      invalidateTaskStoreCache();
      resolve!();
    });
}

/**
 * Run `fn` under the write lock, or inline when the lock is ALREADY held by the
 * current locked section. For helpers on the init path: `ensureInit()` is awaited
 * by `readStore()`, and readStore runs inside withWriteLock all over this file —
 * so an unconditional withWriteLock there self-deadlocks.
 *
 * `fn` must therefore be correct in both modes: keep its DB work inside a single
 * `dbTransaction` (better-sqlite3 is synchronous, so a transaction can't be
 * interleaved by another in-process writer) and do any awaits BEFORE it.
 */
function withWriteLockIfFree<T>(fn: () => Promise<T>): Promise<T> {
  return writeLockDepth > 0 ? fn() : withWriteLock(fn);
}

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await initDirectories();
    // Open the SQLite handle (creates schema on first touch) and run the
    // one-shot JSON→SQLite migration if the DB is still empty. Both are
    // idempotent no-ops on subsequent calls.
    getDb();
    await runMigrationIfNeeded();
    // One-shot: memory/projects/<cat>/<proj>/ → <proj>/ (marker-guarded no-op
    // after the first pass). Lives here because every project-memory reader
    // goes through a task lookup first.
    await migrateProjectMemoryDirs();
    await seedProjectsFromConfig();
    initialized = true;
  }
}

/**
 * Idempotently seed task_projects rows that must exist:
 *   - every `plugins.<id>.project` reservation (source = <plugin id>)
 *   - every distinct non-empty project already present on tasks (source derived
 *     from that task's source) — heals a restore that dropped the registry table
 *     but kept task rows.
 *
 * Plugin reservations take precedence over task-derived sources. An existing row
 * is never rewritten: the registry is the claim of record, and the v5 migration
 * already resolved conflicts once.
 *
 * Inbox (the empty project) deliberately has no row and can never be claimed.
 *
 * Runs under the write lock (or inline when already held — it's on the ensureInit
 * path that writeStore's own callers await). Unlocked, its read-then-INSERT raced
 * a concurrent writeStore(), whose registry rewrite is DELETE-then-reinsert from a
 * snapshot: the seeded rows could be wiped, or the seed could re-add a row that
 * snapshot had legitimately dropped.
 */
async function seedProjectsFromConfig(): Promise<void> {
  const config = await getConfig(); // await BEFORE the lock/transaction
  return withWriteLockIfFree(async () => {
    const db = getDb()!;
    const desired: Array<{ name: string; source: TaskSource }> = [];
    let added = 0;
    dbTransaction((handle) => {
      const existingRows = handle.prepare('SELECT name FROM task_projects').all() as { name: string }[];
      const existing = new Set(existingRows.map((r) => r.name.trim().toLowerCase()));
      const seen = new Set<string>();
      const addIfNew = (rawName: string, source: TaskSource) => {
        const name = (rawName ?? '').trim();
        if (!name) return; // Inbox is never registered
        // Seeding reads UNVALIDATED names (plugin config + raw task rows), so
        // without this gate a bad name that reached a task row by any legacy
        // path gets laundered into the registry on the next boot. Skip, don't
        // throw — this runs on the ensureInit path and must never block boot.
        try {
          assertValidProjectName(name);
        } catch (err) {
          log.task.warn('seedProjectsFromConfig: skipping invalid project name', {
            name, source, err: String(err),
          });
          return;
        }
        const key = name.toLowerCase();
        if (seen.has(key) || existing.has(key)) return;
        seen.add(key);
        desired.push({ name, source });
      };

      const plugins = (config.plugins ?? {}) as Record<string, Record<string, unknown>>;
      for (const [pluginId, cfg] of Object.entries(plugins)) {
        const reserved = (cfg as Record<string, unknown>).project;
        if (typeof reserved === 'string' && reserved) addIfNew(reserved, pluginId as TaskSource);
      }

      const taskRows = handle
        .prepare("SELECT project, source, COUNT(*) AS n FROM tasks WHERE project IS NOT NULL AND project != '' GROUP BY project, source ORDER BY n DESC")
        .all() as { project: string; source: string; n: number }[];
      for (const row of taskRows) {
        addIfNew(row.project, (row.source as TaskSource) ?? 'local');
      }

      if (desired.length === 0) return;
      const nextOrder = (handle
        .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM task_projects')
        .get() as { next: number }).next;
      const stmt = handle.prepare(
        'INSERT INTO task_projects (name, source, order_index) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING'
      );
      let idx = nextOrder;
      for (const { name, source } of desired) {
        stmt.run(name, source, idx);
        idx += 1;
        added += 1;
      }
    });
    void db;
    if (added === 0) return;
    // Only the registry changed; the row shadow covers `tasks` rows, so it stays valid.
    invalidateTaskStoreCache();
    log.task.info('seeded task_projects', { added });
  });
}

/** Parse a task_projects.metadata JSON blob. Corrupt JSON degrades to "no
 *  metadata" rather than taking the whole store read down. */
function parseProjectMetadataJson(
  raw: string | null | undefined,
  project: string,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    log.task.warn('task_projects: metadata JSON parse failed', { project, err: String(err) });
  }
  return undefined;
}

const VALID_PRIORITIES_SET = new Set<string>(VALID_PRIORITIES_ARRAY);

/** Sanitize a priority value — maps legacy values to new 3-tier system, unknown → 'none'. */
function sanitizePriority(p: string | undefined): TaskPriority {
  if (!p) return 'none';
  if (VALID_PRIORITIES_SET.has(p)) return p as TaskPriority;
  // Legacy migrations
  if (p === 'high') return 'immediate';
  if (p === 'medium' || p === 'low') return 'backlog';
  return 'none';
}

// ── Store I/O ──────────────────────────────────────────────────────────────
// Whole-store reads return the "legacy" TaskStore shape (version + tasks[] +
// projects{}) so the helper functions below can keep using
// store.tasks.filter / store.projects without restructuring. Per-row hot
// paths (updateTaskRaw, *Bulk) query rows directly and never go through here.
//
// ⚠️ DESIGN DEBT — that "read the whole store, filter in JS" shape is a leftover
// from the tasks.json era and is the wrong shape for SQLite. The helpers below
// (completeTask, addNote, linkSession, search's expandChildTasks, …) each pull
// all ~3000+ task rows + per-row JSON.parse just to touch one or a handful.
// The CORRECT fix is to push predicates into SQL (`WHERE id=?`, `WHERE
// parent_task_id=?`, indexed lookups) per call site, like updateTaskRaw/*Bulk
// already do. The read cache below is a deliberate STOPGAP that removes the
// acute cost (re-scanning per request), NOT the rewrite. See the approved plan
// in project memory: task_storage_root_cause_and_sqlite_plan.

/**
 * Whole-store read. Served from an in-process cache invalidated on every write
 * (withWriteLock.finally). Returns per-call ISOLATED clones — the canonical
 * cached store is never handed out, because the many exported helpers below
 * read-modify-write `store.tasks` in place before calling writeStore(). Cloning
 * (shallow per task object + fresh array/projects) is far cheaper than the
 * `SELECT *` + per-row rowToTask JSON.parse this cache replaces.
 *
 * NOTE: the cache addresses the REPETITION of the scan, not the scan itself —
 * see the DESIGN DEBT note above for the proper per-call-site SQL-pushdown fix.
 */
async function readStore(): Promise<TaskStore> {
  await ensureInit();
  if (STORE_CACHE_ENABLED && taskStoreCache !== null) {
    // Trust the cache only while no OTHER connection has committed since it was
    // filled (same trust boundary as rowShadowIfCurrent — see the cache decl).
    const current = readDataVersion(getDb()!);
    if (current !== null && current === taskStoreCacheDataVersion) {
      return cloneTaskStore(taskStoreCache);
    }
    log.task.warn('task store cache dropped: external process wrote the DB', {
      cachedDataVersion: taskStoreCacheDataVersion, currentDataVersion: current,
    });
    invalidateTaskStoreCache();
  }
  const db = getDb()!;
  const taskRows = db.prepare('SELECT * FROM tasks').all() as Record<string, any>[];
  const tasks = taskRows.map(rowToTask);

  const projectRows = db
    .prepare('SELECT name, source, order_index, metadata FROM task_projects ORDER BY (order_index IS NULL), order_index ASC, name ASC')
    .all() as { name: string; source: string; order_index: number | null; metadata: string | null }[];
  const projects: Record<string, ProjectRecord> = {};
  for (const row of projectRows) {
    const metadata = parseProjectMetadataJson(row.metadata, row.name);
    projects[row.name] = {
      source: row.source as TaskSource,
      ...(row.order_index != null ? { order_index: row.order_index } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  const groupRows = db
    .prepare('SELECT id, label, hidden FROM task_groups')
    .all() as { id: string; label: string; hidden: number }[];
  const taskGroups: Record<string, TaskGroupRecord> = {};
  for (const row of groupRows) {
    taskGroups[row.id] = { label: row.label, ...(row.hidden ? { hidden: true } : {}) };
  }

  const tierRows = db
    .prepare('SELECT id, label FROM custom_tiers ORDER BY order_index ASC')
    .all() as { id: string; label: string }[];
  const customTiers: CustomTierRecord[] = tierRows.map((row) => ({ id: row.id, label: row.label }));

  const store: TaskStore = {
    tasks,
    ...(Object.keys(projects).length > 0 ? { projects } : {}),
    ...(Object.keys(taskGroups).length > 0 ? { task_groups: taskGroups } : {}),
    ...(customTiers.length > 0 ? { custom_tiers: customTiers } : {}),
  };
  if (STORE_CACHE_ENABLED) {
    taskStoreCache = store;
    taskStoreCacheDataVersion = readDataVersion(db);
    return cloneTaskStore(store);
  }
  return store;
}

/**
 * Shallow-clone a TaskStore so callers can mutate freely without touching the
 * cached canonical copy. Each task is spread into a fresh object; the array and
 * projects map is rebuilt.
 *
 * Scalar field replacements on a cloned task (task.session_id = …,
 * task.plan_session_id = undefined, task.phase = …) are fully isolated. A few
 * read-modify-write helpers DO mutate a nested array in place — notably
 * `task.session_ids.push(sid)` (linkSessionSlot/addSessionToHistory/linkSession)
 * — and the spread does NOT deep-copy that array, so the push transiently
 * touches the cached array too. That is safe ONLY because every such helper
 * runs inside withWriteLock and immediately calls writeStore(), whose
 * withWriteLock.finally invalidates the cache before the lock releases — so no
 * later read ever observes the mutated shared array. The invalidation is the
 * correctness guarantee, not the (incomplete) shallow clone. A future helper
 * that mutates a nested field in place WITHOUT writing through the lock must
 * clone that field itself.
 */
function cloneTaskStore(store: TaskStore): TaskStore {
  return {
    ...store,
    tasks: store.tasks.map((t) => ({ ...t })),
    // Registry rows carry a nested metadata object; clone it too so a caller
    // mutating settings can't reach into the cached snapshot.
    ...(store.projects
      ? {
          projects: Object.fromEntries(
            Object.entries(store.projects).map(([name, rec]) => [
              name,
              { ...rec, ...(rec.metadata ? { metadata: { ...rec.metadata } } : {}) },
            ]),
          ),
        }
      : {}),
    ...(store.task_groups ? { task_groups: { ...store.task_groups } } : {}),
    ...(store.custom_tiers ? { custom_tiers: store.custom_tiers.map((t) => ({ ...t })) } : {}),
  };
}

/**
 * Replace the task + project-registry tables with the full `store` snapshot.
 *
 * Used by every exported helper that still reads the whole store, mutates it
 * in JS, and writes it back. One transaction, prepared INSERT/REPLACE.
 *
 * Per-row fast paths (updateTaskRaw, *Bulk) skip this entirely — they issue
 * targeted UPDATEs and never rewrite unaffected rows.
 *
 * Backup-on-empty safety net: if we'd end up with zero rows but the DB
 * currently has rows, copy the SQLite file aside first.
 */
async function writeStore(store: TaskStore): Promise<void> {
  const db = getDb()!;

  if (store.tasks.length === 0) {
    try {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      if (existing.n > 0) {
        const backupPath = TASK_DB_PATH.replace(/\.sqlite$/, '.backup.sqlite');
        try {
          (db as unknown as { backup: (p: string) => Promise<unknown> }).backup(backupPath);
        } catch {
          try {
            fsSync.copyFileSync(TASK_DB_PATH, backupPath);
          } catch (err) {
            log.task.warn('backup-on-empty (sqlite) copy failed', {
              backupPath, err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        log.task.warn('backup-on-empty: saved SQLite backup before clearing tasks', {
          backupPath, previousTaskCount: existing.n,
        });
      }
    } catch (err) {
      log.task.debug('no existing SQLite tasks to back up before empty write', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const insertCols = [...TASK_COLUMNS, 'payload'];
  const insertSql =
    'INSERT OR REPLACE INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
    insertCols.map((c) => '@' + c).join(', ') + ')';

  // Clear any shadow staged by a transaction that rolled back — adopting it on a
  // later commit would describe rows that were never written.
  pendingRowShadow = null;

  dbTransaction((handle) => {
    const existingIds = (handle.prepare('SELECT id FROM tasks').all() as { id: string }[])
      .map((r) => r.id);
    const newIds = new Set<string>();
    for (const t of store.tasks) {
      if (t && typeof t.id === 'string') newIds.add(t.id);
    }
    const toDelete = existingIds.filter((id) => !newIds.has(id));

    // Audit every row the snapshot-diff removes. In the 2026-08-04 incident this
    // path silently erased tasks another process had just created — deletions
    // here MUST be traceable. Explicit deletes arrive with small intentional
    // diffs; a LARGE diff means the in-memory snapshot is stale vs the DB.
    if (toDelete.length > 0) {
      const logFn = toDelete.length > 5 ? log.task.warn : log.task.info;
      logFn.call(log.task, 'writeStore snapshot diff deleting rows', {
        count: toDelete.length,
        ids: toDelete.slice(0, 20),
        dbRows: existingIds.length,
        snapshotRows: newIds.size,
      });
    }

    const deleteStmt = handle.prepare('DELETE FROM tasks WHERE id = ?');
    for (const id of toDelete) deleteStmt.run(id);

    // Write only rows whose serialized form actually CHANGED.
    //
    // Why: every exported helper here is read-whole-store → mutate → writeStore,
    // so a one-field edit used to re-INSERT all ~4k rows (~600ms). A single
    // quick-start runs ~5 of these helpers (addTask → updateTask → togglePin →
    // setFocusTier → linkSession), so the click cost ~3s of pure SQLite before
    // the CLI was even asked to spawn. Diffing against a row shadow makes the
    // steady-state write O(changed rows) instead of O(all tasks).
    //
    // The shadow is only trusted while `PRAGMA data_version` matches what we saw
    // at our last commit: that counter is bumped by OTHER connections' commits
    // (verified — our own writes leave it untouched), so any external writer
    // (CLI process, migration, plugin) forces a full rewrite and self-heals.
    const shadow = rowShadowIfCurrent(handle);
    const validTasks = store.tasks.filter(
      (t) => t && typeof t === 'object' && typeof t.id === 'string',
    );
    const nextOrder = validTasks.map((t) => t.id);
    // Row order is persisted as rowid order (see RowShadow doc): a permutation must
    // rewrite every row positionally, so only skip rows when order is preserved.
    const canSkipUnchanged = !!shadow && preservesShadowOrder(shadow, nextOrder);
    const nextFingerprints = new Map<string, string>();

    const insertStmt = handle.prepare(insertSql);
    for (const task of validTasks) {
      const partial = taskToRow(task);
      const bound: Record<string, unknown> = {};
      for (const col of insertCols) {
        bound[col] = partial[col] === undefined ? null : partial[col];
      }
      // Identity key over the exact bound values, so a field that round-trips to
      // the same column value is correctly treated as unchanged.
      const fingerprint = JSON.stringify(insertCols.map((c) => bound[c] ?? null));
      nextFingerprints.set(task.id, fingerprint);
      if (canSkipUnchanged && shadow!.fingerprints.get(task.id) === fingerprint) {
        continue; // row unchanged and keeps its position — skip the write
      }
      insertStmt.run(bound);
    }
    // Staged, not published: dbTransaction rolls back on throw, and a shadow
    // describing rows that were never persisted would make the NEXT write skip
    // them. commitRowShadow() below adopts it only once the commit succeeded.
    pendingRowShadow = { fingerprints: nextFingerprints, order: nextOrder };

    // Project registry snapshot rewrite. Guarded on `!== undefined`: readStore
    // OMITS the key when the table is empty, and a hand-built snapshot may not
    // carry it at all — rewriting from `{}` in either case would erase the rows
    // (incl. the order_index/metadata the v5 migration populated). Registry
    // mutations (ensureProject/renameProject/setProjectMetadata) use targeted
    // SQL instead of routing through here.
    if (store.projects !== undefined) {
      handle.prepare('DELETE FROM task_projects').run();
      const projInsert = handle.prepare(
        'INSERT INTO task_projects (name, source, order_index, metadata) VALUES (@name, @source, @order_index, @metadata)'
      );
      let idx = 0;
      for (const [name, rec] of Object.entries(store.projects)) {
        if (!name.trim()) continue; // Inbox never gets a row
        projInsert.run({
          name,
          source: rec?.source ?? 'local',
          order_index: rec?.order_index ?? idx,
          metadata: rec?.metadata && Object.keys(rec.metadata).length > 0
            ? JSON.stringify(rec.metadata)
            : null,
        });
        idx += 1;
      }
    }

    // Full-snapshot rewrite of the group-name registry (mirrors task_projects).
    // Membership lives on tasks.group_id; this table only holds labels.
    handle.prepare('DELETE FROM task_groups').run();
    const groupInsert = handle.prepare(
      'INSERT INTO task_groups (id, label, hidden) VALUES (@id, @label, @hidden)'
    );
    for (const [id, rec] of Object.entries(store.task_groups ?? {})) {
      if (rec?.label) groupInsert.run({ id, label: rec.label, hidden: rec.hidden ? 1 : 0 });
    }

    // Full-snapshot rewrite of the custom-tier registry (mirrors task_groups).
    // Array index is the persisted order.
    handle.prepare('DELETE FROM custom_tiers').run();
    const tierInsert = handle.prepare(
      'INSERT INTO custom_tiers (id, label, order_index) VALUES (@id, @label, @order_index)'
    );
    (store.custom_tiers ?? []).forEach((tier, i) => {
      if (tier?.id && tier?.label) tierInsert.run({ id: tier.id, label: tier.label, order_index: i });
    });
  });

  // Transaction committed — the staged row shadow now describes what's on disk.
  commitRowShadow();

  // Invalidate the read cache at COMMIT time, not just in withWriteLock.finally.
  // Several helpers emit bus events between writeStore() and lock release
  // (e.g. setFocusTier emits config:changed{focus_bar}); a browser that reacts
  // to that event can GET /api/focus/tasks before .finally runs and be served
  // the pre-write snapshot — the fork/quick-start "lands in Satellite despite
  // focus_tier=focus" bug. The .finally invalidation stays as the backstop.
  invalidateTaskStoreCache();
}

export interface AddTaskInput {
  title: string;
  priority?: TaskPriority;
  /** Target project. Omitted/'' = Inbox. A name with no registry row is created. */
  project?: string;
  due_date?: string;
  start_date?: string;
  end_date?: string;
  parent_task_id?: string;
  description?: string;
  tags?: string[];
  depends_on?: string[];
  cwd?: string;
  sprint?: string;
  /** Explicit source override. Only needed for the first task in a new project (e.g. source='local'). */
  source?: TaskSource;
  /** Don't block the return on the external sync push. The task is written locally and
   *  returned immediately; the push to the external target runs in the background and
   *  backfills ext/external_url/sync_error via a TASK_UPDATED event. Set by the web
   *  create path so the UI is instant. Programmatic callers that report syncResult
   *  (agent task_create, CLI) leave this off and keep synchronous semantics. */
  asyncPush?: boolean;
  /** Skip plugin content-validation & auto-push (fork children are internal). */
  _skipPluginOps?: boolean;
}

// ── Project registry (task_projects) — the single grouping layer ────────────
//
// A project is identified case-insensitively (the SQLite PK is COLLATE NOCASE),
// carries at most ONE provider claim (`source`), and owns its settings in a
// `metadata` JSON blob (the retired `.metadata_project` sentinel task).
//
// The empty project ('' = Inbox) NEVER has a row and can never be claimed. That
// single rule replaces the whole old local-reservation config
// machinery: an unclaimable bucket is now structural, not configured.

/**
 * MS To-Do list name for a project. New projects push to a list named after the
 * project; a project migrated from the old "Cat / Proj" encoding keeps pushing
 * into its existing remote list via the `remote_list` metadata alias, so an
 * upgrade never forks a second list or renames the user's.
 */
export async function remoteListNameFor(project: string): Promise<string> {
  const name = (project ?? '').trim();
  if (!name) return '';
  const metadata = await getProjectMetadata(name);
  const alias = metadata?.remote_list;
  return typeof alias === 'string' && alias.trim() ? alias : name;
}

/** All registry rows, keyed by their canonical spelling. Never includes Inbox. */
export async function getStoreProjects(): Promise<Record<string, ProjectRecord>> {
  const store = await readStore();
  return store.projects ?? {};
}

/** Registry row for a project name (case-insensitive). Null for Inbox/unknown. */
export async function getProjectRecord(project: string): Promise<(ProjectRecord & { name: string }) | null> {
  const name = (project ?? '').trim();
  if (!name) return null;
  const projects = await getStoreProjects();
  const key = Object.keys(projects).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? { name: key, ...projects[key] } : null;
}

/**
 * Thrown when a project name has an unusable SHAPE (as opposed to a claim
 * conflict). Typed so routes can map it to 400 rather than 500.
 */
export class InvalidProjectNameError extends Error {
  public readonly project: string;
  constructor(message: string, project: string) {
    super(message);
    this.name = 'InvalidProjectNameError';
    this.project = project;
  }
}

/**
 * Validate a project name's shape and return the trimmed value.
 *
 * A project name becomes a FILESYSTEM PATH SEGMENT — `memory/projects/<project>/`
 * (project-memory) and it flows into session cwd resolution — so path
 * metacharacters are a traversal hole, not a cosmetic issue: "../../.ssh" would
 * escape the memory root. NUL truncates paths in syscalls, and a leading '.'
 * makes hidden dirs (and collides with the retired `.metadata*` namespace).
 *
 * Inbox ('') is legal in the MODEL but never reaches here: every caller returns
 * early for the empty name (it has no registry row and needs no directory).
 */
export function assertValidProjectName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    throw new InvalidProjectNameError(
      'Project name must be a non-empty string. To clear a project, move its tasks to Inbox.',
      trimmed,
    );
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new InvalidProjectNameError(
      `Invalid project name "${name}": path separators ('/', '\\') are not allowed — a project name becomes a directory segment.`,
      trimmed,
    );
  }
  if (trimmed.includes('..')) {
    throw new InvalidProjectNameError(
      `Invalid project name "${name}": '..' is not allowed — a project name becomes a directory segment.`,
      trimmed,
    );
  }
  if (trimmed.includes('\0')) {
    throw new InvalidProjectNameError(
      `Invalid project name "${name}": it contains a NUL character.`,
      trimmed,
    );
  }
  if (trimmed.startsWith('.')) {
    throw new InvalidProjectNameError(
      `Invalid project name "${name}": it cannot start with '.' (hidden directory / retired .metadata namespace).`,
      trimmed,
    );
  }
  return trimmed;
}

/**
 * Lock-free registry upsert. Must be called with the write lock already held
 * (addTask does its whole create inside one lock; a nested ensureProject() would
 * self-deadlock). Returns the canonical spelling and whether it was just created
 * — the caller emits PROJECT_CREATED, since the bus must not be touched while a
 * transaction is open.
 */
function ensureProjectRowLocked(
  name: string,
  source: TaskSource,
): { name: string; source: TaskSource; created: boolean } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { name: '', source: 'local', created: false };
  const db = getDb()!;
  // Existence check is done in JS with toLowerCase(), NOT by leaning on the
  // column's COLLATE NOCASE. SQLite's NOCASE folds ASCII A-Z only, while JS
  // toLowerCase() folds Unicode — so "Ärger" vs "ärger" are ONE project to every
  // JS-side lookup (getProjectRecord, addTask's registryKey, renameProject) but
  // TWO distinct PK values to SQLite. Relying on `WHERE name = ?` + `ON CONFLICT
  // DO NOTHING` would therefore insert a second row and split the project. This
  // runs with the write lock held, so lookup-then-insert is not racy in-process;
  // the ON CONFLICT below stays as the cross-process backstop.
  //
  // Accepted asymmetry: the JS side is the enforcer of project identity; SQLite's
  // NOCASE PK is only the ASCII-case backstop.
  const rows = db.prepare('SELECT name, source FROM task_projects').all() as
    { name: string; source: string }[];
  const lower = trimmed.toLowerCase();
  const existing = rows.find((r) => r.name.trim().toLowerCase() === lower);
  if (existing) {
    return { name: existing.name, source: existing.source as TaskSource, created: false };
  }
  const nextOrder = (db
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM task_projects')
    .get() as { next: number }).next;
  db.prepare(
    'INSERT INTO task_projects (name, source, order_index) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING',
  ).run(trimmed, source, nextOrder);
  log.task.info('project created', { project: trimmed, source });
  return { name: trimmed, source, created: true };
}

function emitProjectCreated(name: string, source: TaskSource): void {
  bus.emit(
    EventNames.PROJECT_CREATED,
    { name, source },
    ['web-ui', 'main-agent'],
    { source: 'task-manager' },
  );
}

/**
 * Emit task:phase-changed when a phase transition ACTUALLY happened.
 * Rides beside (never replaces) the existing TASK_UPDATED/TASK_COMPLETED
 * emits — hook consumers get old/new phase without diffing update payloads.
 * Call AFTER the store write with the pre-mutation phase captured by the caller.
 */
function emitPhaseChanged(task: Task, oldPhase: TaskPhase, source: string): void {
  if (task.phase === oldPhase) return;
  bus.emit(EventNames.TASK_PHASE_CHANGED, {
    task,
    oldPhase,
    newPhase: task.phase,
    source,
    sessionId: task.session_id,
  }, ['web-ui'], { source });
}

/**
 * Idempotently ensure a registry row for `name`. Returns the canonical spelling
 * plus the row's source — which is the EXISTING row's source when one is already
 * there, so a caller can't silently re-claim a project by passing a source.
 *
 * Emits PROJECT_CREATED only on a real first create (web project lists update
 * live). Inbox ('') is a no-op: it has no row by design.
 */
export async function ensureProject(
  name: string,
  source: TaskSource = 'local',
): Promise<{ name: string; source: TaskSource; created: boolean }> {
  // Inbox short-circuits BEFORE shape validation: '' is the legal absence of a
  // project, never a row, never a directory.
  if (!(name ?? '').trim()) return { name: '', source: 'local', created: false };
  const trimmed = assertValidProjectName(name);

  await ensureInit();
  const result = await withWriteLock(async () => ensureProjectRowLocked(trimmed, source));
  if (result.created) emitProjectCreated(result.name, result.source);
  return result;
}

/**
 * Rename a project, moving every task with it.
 *
 * Semantics (all of them — the old doc claimed only the last one):
 *  - MERGE-ON-COLLISION: renaming onto an existing project folds the two together
 *    (case-insensitive), which is the only sane semantic given NOCASE identity.
 *    A rename onto a project claimed by ANOTHER provider is refused
 *    (ProjectSourceConflictError), as is a source-mixed origin project.
 *  - Registry metadata moves with the row; on a MERGE the TARGET's own settings
 *    win (it already exists and may have a live cwd/alias).
 *  - Config lists follow: `favorites.projects` and `ordering.projects` are
 *    rewritten to the new name (NOCASE-deduped), so a rename doesn't silently
 *    unstar the project or drop it out of the user's hand-ordering.
 *  - For an ms-todo-claimed PLAIN rename (not a merge) the REMOTE LIST itself is
 *    renamed ONCE by display name (`renameListByName`, old alias → new name).
 *    Only if that fails do we fall back to per-task pushes, which would create a
 *    new list. The `remote_list` alias is kept pointing at the old list until the
 *    remote rename succeeds, then repointed to the new name — so a failure leaves
 *    pushes landing in the existing list rather than forking one.
 *
 * Returns the number of tasks moved and whether this was a merge.
 */
export async function renameProject(
  oldProject: string,
  newProject: string,
): Promise<{ count: number; merged: boolean }> {
  const from = (oldProject ?? '').trim();
  if (!from) throw new InvalidProjectNameError('Cannot rename Inbox — it is the absence of a project.', '');
  // Shape validation on the TARGET only: an existing project with a bad legacy
  // name must stay renamable (that's how you fix it).
  const to = assertValidProjectName(newProject);

  const {
    count, merged, renameSource, renamedTasks, renamedTaskIds, canonical, oldAlias,
  } = await withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    const tasksToRename = store.tasks.filter((t) => (t.project || '').toLowerCase() === fromLower);
    const projects = store.projects ?? {};
    const fromKey = Object.keys(projects).find((k) => k.toLowerCase() === fromLower);
    if (tasksToRename.length === 0 && !fromKey) {
      throw new Error(`No project "${from}" found`);
    }

    // Source of record: the registry row, falling back to the tasks themselves
    // for a project that only exists implicitly (registry row lost in a restore).
    const renameSource: TaskSource = fromKey
      ? projects[fromKey].source
      : (tasksToRename[0]?.source ?? 'local');
    const mixed = tasksToRename.find((t) => t.source !== renameSource);
    if (mixed) {
      throw new Error(
        `Project "${from}" has mixed sources (${renameSource} and ${mixed.source}). Clean it up before renaming.`,
      );
    }

    // Target claim check: merging into a project owned by ANOTHER provider is a
    // conflict, not a merge — the tasks cannot legally live there.
    const toKey = Object.keys(projects).find((k) => k.toLowerCase() === toLower);
    const merged = !!toKey && toLower !== fromLower;
    if (toKey && projects[toKey].source !== renameSource) {
      throw new ProjectSourceConflictError(
        `Cannot rename "${from}" to "${to}" — project "${to}" is claimed by ${projects[toKey].source} but "${from}" tasks sync to ${renameSource}.`,
        to,
        renameSource,
        projects[toKey].source,
      );
    }
    const config = await getConfig();
    const validation = validateProjectSource(to, renameSource, config, projects);
    if (!validation.ok) {
      throw new ProjectSourceConflictError(validation.error, to, renameSource, validation.existingSource);
    }

    const canonical = toKey ?? to;
    const renamedTaskIds: string[] = [];
    for (const task of store.tasks) {
      if ((task.project || '').toLowerCase() !== fromLower) continue;
      task.project = canonical;
      task.updated_at = now;
      renamedTaskIds.push(task.id);
    }

    // Registry: carry the old row's metadata onto the target. Merge keeps the
    // TARGET's own settings (it already exists and may have a live cwd/alias);
    // a plain rename moves everything.
    // The remote list this project's tasks currently live in — the alias if set,
    // else the old project's CANONICAL name (not the caller's spelling). The
    // post-lock remote rename needs it.
    let oldAlias = fromKey ?? '';
    if (fromKey) {
      const oldRec = projects[fromKey];
      const aliasValue = oldRec.metadata?.remote_list;
      if (typeof aliasValue === 'string' && aliasValue.trim()) oldAlias = aliasValue;
      delete projects[fromKey];
      const targetRec = toKey && toKey !== fromKey ? projects[toKey] : undefined;
      const nextMetadata: Record<string, unknown> = {
        ...(oldRec.metadata ?? {}),
        ...(targetRec?.metadata ?? {}),
      };
      // KEEP the alias here. It points at the remote list the tasks actually live
      // in, and the remote rename below hasn't happened yet — dropping it now
      // would make every push in the meantime resolve the NEW name and fork a
      // second list. It is repointed to `to` only after the remote rename
      // succeeds (and left alone if it fails), which is what makes the fallback
      // path non-destructive.
      projects[canonical] = {
        source: renameSource,
        ...(targetRec?.order_index !== undefined
          ? { order_index: targetRec.order_index }
          : oldRec.order_index !== undefined ? { order_index: oldRec.order_index } : {}),
        ...(Object.keys(nextMetadata).length > 0 ? { metadata: nextMetadata } : {}),
      };
      store.projects = projects;
    } else {
      store.projects = { ...projects, [canonical]: { source: renameSource } };
    }

    await writeStore(store);
    const renamedTasks = store.tasks.filter((t) => renamedTaskIds.includes(t.id));
    return {
      count: renamedTaskIds.length, merged, renameSource, renamedTasks, renamedTaskIds,
      canonical, oldAlias,
    };
  });

  // Config lists follow the rename (outside the store lock — config has its own).
  await migrateProjectInConfigLists(from, canonical);

  // Remote rename (best effort, outside the lock). The local rename already
  // committed; a remote failure leaves tasks pushing to the OLD list via the
  // surviving alias, which is exactly what the alias model tolerates.
  if (renameSource !== 'local') {
    let remoteRenamed = false;
    // Rename the CONTAINER once instead of pushing N tasks: a per-task push
    // resolves the new name, doesn't find a list, and CREATES one — forking the
    // user's list in two. Only meaningful for a plain rename; on a merge the
    // target list already exists and the tasks genuinely have to move into it.
    // Goes through the plugin's optional renameProjectRemote hook — core never
    // imports a specific integration (a plugin without the hook just takes the
    // per-task fallback below).
    if (!merged && oldAlias) {
      const remoteRename = registry.get(renameSource)?.sync.renameProjectRemote;
      if (remoteRename) {
        try {
          await remoteRename({ oldRemoteName: oldAlias, newName: canonical });
          remoteRenamed = true;
          // Remote container now IS the project name — repoint (not delete) the
          // alias so there is exactly one source of truth for the list name.
          await setProjectMetadata(canonical, { remote_list: canonical });
          log.task.info('project rename: renamed remote container', {
            project: canonical, from: oldAlias, source: renameSource,
          });
        } catch (err) {
          log.task.warn('project rename: remote container rename failed, falling back to per-task push', {
            project: canonical, from: oldAlias, source: renameSource,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (!remoteRenamed) {
      for (const task of renamedTasks) {
        pushToPlugin(task, 'updateProject', canonical).catch(() => { /* best effort */ });
      }
    }
  }

  if (renamedTaskIds.length > 0) {
    bus.emit(EventNames.TASK_UPDATED, {
      task: null,
      taskIds: renamedTaskIds,
      oldProject: from,
      newProject: canonical,
      count,
    }, ['web-ui', 'main-agent'], { source: 'task-manager' });
  }

  return { count, merged };
}

/**
 * Keep `config.favorites.projects` / `config.ordering.projects` in step with a
 * project rename or delete. Both are plain NAME lists, so a rename that skipped
 * them would silently unstar the project and drop it out of the user's
 * hand-ordering — the same class of bug the retired renameCategory fixed for
 * `config.local.categories`.
 *
 * `to === null` = delete (drop the entry). Comparison and dedupe are NOCASE,
 * matching project identity. No-op (no config write) when neither list mentions
 * the old name.
 */
async function migrateProjectInConfigLists(from: string, to: string | null): Promise<void> {
  const fromLower = from.trim().toLowerCase();
  if (!fromLower) return;
  try {
    const config = await getConfig();
    const rewrite = (list: string[] | undefined): { next: string[]; changed: boolean } | null => {
      if (!Array.isArray(list) || list.length === 0) return null;
      if (!list.some((n) => (n ?? '').trim().toLowerCase() === fromLower)) return null;
      const next: string[] = [];
      const seen = new Set<string>();
      for (const raw of list) {
        const name = (raw ?? '').trim();
        if (!name) continue;
        const replaced = name.toLowerCase() === fromLower ? to : name;
        if (!replaced) continue; // delete case
        const key = replaced.toLowerCase();
        if (seen.has(key)) continue; // rename collapsed onto an existing entry
        seen.add(key);
        next.push(replaced);
      }
      return { next, changed: true };
    };

    const favorites = rewrite(config.favorites?.projects);
    const ordering = rewrite(config.ordering?.projects);
    if (!favorites && !ordering) return;

    await updateConfig({
      ...(favorites
        ? { favorites: { ...(config.favorites ?? {}), projects: favorites.next } }
        : {}),
      ...(ordering
        ? { ordering: { ...(config.ordering ?? {}), projects: ordering.next } }
        : {}),
    });
    log.task.info('project config lists updated', {
      from, to,
      favorites: favorites ? favorites.next.length : undefined,
      ordering: ordering ? ordering.next.length : undefined,
    });
  } catch (err) {
    // Never fail the rename/delete over a config write — the store change already
    // committed and a stale favorite is cosmetic.
    log.task.warn('project config list migration failed', {
      from, to, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete a project: its tasks fall back to Inbox ('') and the registry row goes
 * away. Both halves MUST land in ONE transaction — a half-applied delete leaves
 * tasks pointing at a project with no row — hence this lives in the storage
 * layer, not the route. Case-insensitive; throws /^No project / when unknown.
 */
export async function deleteProject(project: string): Promise<{ movedToInbox: number }> {
  const name = (project ?? '').trim();
  if (!name) throw new Error('Inbox is not a project — nothing to delete.');

  await ensureInit();
  const { movedToInbox, taskIds, canonical } = await withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    const lower = name.toLowerCase();
    const projects = store.projects ?? {};
    const key = Object.keys(projects).find((k) => k.toLowerCase() === lower);
    const affected = store.tasks.filter((t) => (t.project || '').toLowerCase() === lower);
    if (!key && affected.length === 0) throw new Error(`No project "${name}" found`);

    for (const task of affected) {
      task.project = '';
      task.updated_at = now;
    }
    if (key) {
      // writeStore's registry rewrite is guarded on `!== undefined`, so mutating
      // the snapshot map is the transactional way to drop the row.
      const next = { ...projects };
      delete next[key];
      store.projects = next;
    }
    await writeStore(store);
    return {
      movedToInbox: affected.length,
      taskIds: affected.map((t) => t.id),
      canonical: key ?? name,
    };
  });

  // Drop the deleted project from the config name lists (favorites / ordering) —
  // otherwise a deleted project keeps a phantom star and an ordering slot.
  await migrateProjectInConfigLists(canonical, null);

  if (taskIds.length > 0) {
    bus.emit(EventNames.TASK_UPDATED, {
      task: null,
      taskIds,
      oldProject: canonical,
      newProject: '',
      count: taskIds.length,
    }, ['web-ui', 'main-agent'], { source: 'task-manager' });
  }

  log.task.info('project deleted', { project: canonical, movedToInbox });
  return { movedToInbox };
}

/**
 * Cascade-delete a provider-claimed project: delete the REMOTE side first
 * (via the plugin's optional `deleteProjectRemote` hook), then apply the
 * matching local transition, then drop the registry row. Local tasks are
 * NEVER deleted — the cascade removes the container/grouping, not the data.
 *
 * The hook's result picks the local transition (see integration-types.ts):
 *   - 'container-deleted'  → remote twins died with the container: local tasks
 *     DETACH (source='local', ext cleared, project='' = Inbox).
 *   - 'grouping-removed'   → remote tasks survive, only the grouping marker was
 *     stripped: local tasks MOVE to the plugin's fallbackProject KEEPING their
 *     provider binding, so the next pull is a no-op instead of a dup-import.
 *
 * Throws ProjectRemoteDeleteUnsupportedError when the claiming plugin doesn't
 * implement the hook (routes map it to 409, same dead-end as before — but now
 * the error names the actual gap instead of pointing at a non-existent UI).
 *
 * ORDER (crash-safety):
 *   1. Snapshot tasks WITH ext (the plugin needs remote ids for tombstones).
 *   2. Plugin deletes the remote side FIRST. If it throws, nothing local
 *      changed — the project is intact and the operation is retryable.
 *   3. Only then apply the local transition + drop the row (single store
 *      transaction). Between 2 and 3 a concurrent pull sees the remote side
 *      already changed — harmless: tombstones/strips from step 2 stop
 *      re-imports of the old grouping.
 * The inverse order would strand step-1 detached local tasks if the remote
 * call failed, and a mid-flight reconcile could mass-delete provider tasks
 * whose container was gone but whose rows still claimed the provider.
 */
export class ProjectRemoteDeleteUnsupportedError extends Error {
  public readonly project: string;
  public readonly source: string;
  constructor(project: string, source: string) {
    super(
      `Project "${project}" is claimed by ${source}, and that integration does not support ` +
      `remote container deletion (no deleteProjectRemote hook). Delete the remote container ` +
      `in the provider's own app, then delete the project here.`,
    );
    this.name = 'ProjectRemoteDeleteUnsupportedError';
    this.project = project;
    this.source = source;
  }
}

export async function deleteProjectCascade(project: string): Promise<{
  movedToInbox: number;
  /** Tasks moved to a surviving fallback project ('grouping-removed'), with binding kept. */
  movedToProject?: { project: string; count: number };
  remoteDeleted: boolean;
  source: string;
}> {
  const name = (project ?? '').trim();
  if (!name) throw new Error('Inbox is not a project — nothing to delete.');
  await ensureInit();

  const record = await getProjectRecord(name);
  if (!record) throw new Error(`No project "${name}" found`);

  // Local claim → plain delete (no remote side to cascade to).
  if (record.source === 'local') {
    const result = await deleteProject(record.name);
    return { ...result, remoteDeleted: false, source: 'local' };
  }

  const plugin = registry.get(record.source);
  const remoteDelete = plugin?.sync.deleteProjectRemote;
  if (!remoteDelete) {
    throw new ProjectRemoteDeleteUnsupportedError(record.name, record.source);
  }

  // Snapshot the project's tasks WITH ext intact — the plugin tombstones their
  // remote ids so a mid-flight pull can't re-import them.
  const lower = record.name.toLowerCase();
  const snapshot = (await listTasks({})).filter(
    (t) => (t.project || '').toLowerCase() === lower,
  );

  const remoteList = typeof record.metadata?.remote_list === 'string'
    ? record.metadata.remote_list
    : undefined;

  // Remote side first — a failure here leaves everything local untouched.
  const remoteResult = await remoteDelete({ project: record.name, remoteList, tasks: snapshot });

  // 'grouping-removed' survivors keep their binding and move to the plugin's
  // fallback project; 'container-deleted' twins are gone → detach to Inbox.
  const survivorProject = remoteResult.outcome === 'grouping-removed'
    ? (remoteResult.fallbackProject ?? '').trim()
    : '';
  if (remoteResult.outcome === 'grouping-removed' && !survivorProject) {
    // A provider task can't live in Inbox — a plugin returning an empty
    // fallback is a contract bug; fail before mutating anything local.
    throw new Error(
      `Plugin ${record.source} returned grouping-removed with an empty fallbackProject for "${record.name}".`,
    );
  }
  if (survivorProject) {
    // Register the fallback row (same claim) BEFORE moving tasks onto it.
    await ensureProject(survivorProject, record.source);
  }

  // Apply the local transition + drop the row in one store transaction.
  const { movedCount, taskIds, newProjectName } = await withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    const projects = store.projects ?? {};
    // Canonical spelling of the fallback row (ensureProject may have matched an
    // existing row with different casing).
    const survivorKey = survivorProject
      ? Object.keys(projects).find((k) => k.toLowerCase() === survivorProject.toLowerCase()) ?? survivorProject
      : '';
    const affected = store.tasks.filter((t) => (t.project || '').toLowerCase() === lower);
    for (const task of affected) {
      if (survivorKey) {
        task.project = survivorKey; // binding kept — remote twin survives
      } else {
        task.project = '';
        task.source = 'local';
        task.ext = undefined;
        task.external_url = undefined;
        task.sync_error = undefined;
      }
      task.updated_at = now;
    }
    const key = Object.keys(projects).find((k) => k.toLowerCase() === lower);
    if (key) {
      const next = { ...projects };
      delete next[key];
      store.projects = next;
    }
    await writeStore(store);
    return {
      movedCount: affected.length,
      taskIds: affected.map((t) => t.id),
      newProjectName: survivorKey,
    };
  });

  await migrateProjectInConfigLists(record.name, null);

  if (taskIds.length > 0) {
    bus.emit(EventNames.TASK_UPDATED, {
      task: null,
      taskIds,
      oldProject: record.name,
      newProject: newProjectName,
      count: taskIds.length,
    }, ['web-ui', 'main-agent'], { source: 'task-manager' });
  }

  log.task.info('project cascade-deleted', {
    project: record.name, source: record.source, outcome: remoteResult.outcome,
    moved: movedCount, movedTo: newProjectName || 'Inbox',
  });
  return {
    movedToInbox: newProjectName ? 0 : movedCount,
    ...(newProjectName ? { movedToProject: { project: newProjectName, count: movedCount } } : {}),
    remoteDeleted: true,
    source: record.source,
  };
}

/**
 * Merged settings for a project — the registry row's `metadata` blob (default_cwd,
 * default_host, summary, remote_list, legacy_category, …). Null for Inbox or an
 * unregistered name.
 */
export async function getProjectMetadata(project: string): Promise<{
  default_host?: string;
  default_cwd?: string;
  [key: string]: unknown;
} | null> {
  const record = await getProjectRecord(project);
  if (!record?.metadata || Object.keys(record.metadata).length === 0) return null;
  return record.metadata as { default_host?: string; default_cwd?: string; [key: string]: unknown };
}

/**
 * Merge `settings` into a project's registry metadata, creating the row when
 * absent. Returns the merged object. Inbox can't hold settings (no row).
 */
export async function setProjectMetadata(
  project: string,
  settings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = (project ?? '').trim();
  if (!raw) throw new Error('Inbox has no project settings — pass a project name.');

  // Create the row first (outside the metadata write lock — ensureProject takes
  // the same lock and would self-deadlock). Use the CANONICAL spelling it returns
  // for the lookup below: `WHERE name = ?` leans on NOCASE, which is ASCII-only,
  // so a unicode-case variant would otherwise miss its own row.
  const { name } = await ensureProject(raw);

  return withWriteLock(async () => {
    const db = getDb()!;
    const row = db
      .prepare('SELECT name, metadata FROM task_projects WHERE name = ?')
      .get(name) as { name: string; metadata: string | null } | undefined;
    if (!row) throw new Error(`Project "${name}" not found`);
    const existing = parseProjectMetadataJson(row.metadata, row.name) ?? {};
    const merged = { ...existing, ...settings };
    db.prepare('UPDATE task_projects SET metadata = ? WHERE name = ?').run(
      Object.keys(merged).length > 0 ? JSON.stringify(merged) : null,
      row.name,
    );
    return merged;
  });
}

export interface SyncResult {
  success: boolean;
  error?: string;
}

/**
 * Push a specific field update to the task's plugin.
 * Fire-and-forget with sync_error tracking.
 */
async function pushToPlugin(
  task: Task,
  method: keyof import('./integration-types.js').IntegrationSync,
  ...args: unknown[]
): Promise<SyncResult> {
  try {
    const plugin = registry.get(task.source);
    if (!plugin) return { success: true }; // Unknown source, skip silently

    const syncFn = plugin.sync[method] as (...a: unknown[]) => Promise<unknown>;
    const result = await syncFn(task, ...args);

    // If createTask returned ExtData, merge into task.ext
    if (method === 'createTask' && result) {
      await withWriteLock(async () => {
        const store = await readStore();
        const found = store.tasks.find(t => t.id === task.id);
        if (found) {
          found.ext = { ...found.ext, ...result as Record<string, unknown> };
          found.sync_error = undefined;
          // Derive external_url from plugin display metadata if not already set
          if (!found.external_url && plugin.display?.getExternalUrl) {
            const url = plugin.display.getExternalUrl(found);
            if (url) found.external_url = url;
          }
          await writeStore(store);
          bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
        }
      });
    }

    // Clear sync_error on success
    if (task.sync_error) {
      await withWriteLock(async () => {
        const store = await readStore();
        const found = store.tasks.find(t => t.id === task.id);
        if (found && found.sync_error) {
          found.sync_error = undefined;
          await writeStore(store);
          bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
        }
      });
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.task.warn('plugin sync failed', { taskId: task.id, source: task.source, method, error: message });

    // Set sync_error
    await withWriteLock(async () => {
      const store = await readStore();
      const found = store.tasks.find(t => t.id === task.id);
      if (found && found.sync_error !== message) {
        found.sync_error = message;
        await writeStore(store);
        bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
      }
    });

    return { success: false, error: message };
  }
}

/**
 * Per-task push mutex: prevents concurrent pushes of the same task.
 * When multiple callers try to push the same task (e.g. parallel field updates
 * from updateTask fire-and-forget), the second caller awaits the first's promise.
 */
const pushInflight = new Map<string, Promise<SyncResult>>();
const pushDirty = new Set<string>();

/** Check if a push is currently inflight for a given task ID.
 *  Used by sync-reconciler and ctx.updateTask to skip pull updates during push. */
export function isPushInflight(taskId: string): boolean {
  return pushInflight.has(taskId);
}

/**
 * Full task push — calls createTask for new tasks or pushes all fields for existing.
 * Replaces the old integration-specific autoPushIfConfigured().
 * Per-task mutex prevents concurrent pushes (Layer 1).
 *
 * Trailing-write coalescing: if a push is already inflight, mark the task dirty
 * instead of dropping the update. When the inflight push completes, if dirty,
 * re-push once with the latest state. Without this, the inflight push lands with
 * stale data while local has advanced — the remote timestamp ends up newer than
 * local updated_at, causing the next pull to overwrite local with stale remote.
 */
export async function autoPushIfConfigured(task: Task): Promise<SyncResult> {
  if (task.source === 'local') return { success: true };

  // If a push is already inflight, mark dirty so the finally block re-pushes
  const existing = pushInflight.get(task.id);
  if (existing) {
    pushDirty.add(task.id);
    return existing;
  }

  const promise = autoPushIfConfiguredImpl(task);
  pushInflight.set(task.id, promise);
  try { return await promise; }
  finally {
    pushInflight.delete(task.id);
    // If task was updated while push was inflight, re-push with fresh state
    if (pushDirty.delete(task.id)) {
      const freshTask = await getTask(task.id).catch(() => null);
      if (freshTask) {
        autoPushIfConfigured(freshTask).catch(err => {
          log.task.warn('trailing push failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
        });
      }
    }
  }
}

async function autoPushIfConfiguredImpl(task: Task): Promise<SyncResult> {
  const plugin = registry.get(task.source);
  if (!plugin) {
    // Plugin not loaded — set sync_error so the user sees something went wrong
    const message = `Plugin "${task.source}" not loaded — task not synced`;
    log.task.warn('sync skipped: plugin not loaded', { taskId: task.id, source: task.source });
    await withWriteLock(async () => {
      const store = await readStore();
      const found = store.tasks.find(t => t.id === task.id);
      if (found && found.sync_error !== message) {
        found.sync_error = message;
        await writeStore(store);
        bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
      }
    });
    return { success: false, error: message };
  }

  // For new tasks without ext data, do a full create
  const hasRemoteId = task.ext && Object.keys(task.ext).length > 0;
  if (!hasRemoteId) {
    return pushToPlugin(task, 'createTask');
  }

  // Layer 2: detect list migration BEFORE parallel field pushes.
  // If the task's project changed (list changed), do a single push first
  // to handle DELETE+CREATE atomically, then do parallel field updates (PATCH path).
  const needsListMigration = await detectListMigration(task);
  if (needsListMigration) {
    // Single push handles DELETE old + CREATE new + updates ext in memory
    const migrateResult = await pushToPlugin(task, 'updateTitle', task.title);
    if (!migrateResult.success) return migrateResult;

    // Persist ext to disk immediately so parallel pushes see new list_id
    await persistTaskExt(task);

    // Re-read task from store to get fresh ext data for subsequent pushes
    const freshTask = await withWriteLock(async () => {
      const store = await readStore();
      return store.tasks.find(t => t.id === task.id);
    });
    if (freshTask) {
      Object.assign(task, freshTask);
    }
  }

  // For existing tasks, use plugin's pushTask (full push with server timestamp for echo detection)
  try {
    const pushResult = await plugin.sync.pushTask(task);

    // Persist ext changes + _syncedAt in a single write
    await withWriteLock(async () => {
      const store = await readStore();
      const found = store.tasks.find(t => t.id === task.id);
      if (found) {
        // Store server timestamp for echo detection on pull
        found._syncedAt = pushResult.serverTimestamp;
        // Merge ext data if plugin returned any
        if (pushResult.ext) {
          found.ext = { ...found.ext, ...pushResult.ext };
        }
        // Also persist any ext mutations the plugin made in memory
        if (task.ext && Object.keys(task.ext).length > 0) {
          found.ext = { ...found.ext, ...task.ext };
        }
        // Clear sync_error on success
        if (found.sync_error) {
          found.sync_error = undefined;
        }
        // Derive external_url from plugin display metadata if not already set
        if (!found.external_url && plugin.display?.getExternalUrl) {
          const url = plugin.display.getExternalUrl(found);
          if (url) found.external_url = url;
        }
        await writeStore(store);
        bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
      }
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.task.warn('pushTask failed', { taskId: task.id, source: task.source, error: message });

    // Set sync_error
    await withWriteLock(async () => {
      const store = await readStore();
      const found = store.tasks.find(t => t.id === task.id);
      if (found && found.sync_error !== message) {
        found.sync_error = message;
        await writeStore(store);
        bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
      }
    });

    return { success: false, error: message };
  }
}

/**
 * Detect if a task's target MS To-Do list has changed (Layer 2).
 * Compares the stored list_id in ext with the list_id resolved from the task's
 * current project (via remoteListNameFor → the remote_list alias or the name).
 */
async function detectListMigration(task: Task): Promise<boolean> {
  if (task.source !== 'ms-todo') return false;
  const currentListId = (task.ext?.['ms-todo'] as Record<string, unknown>)?.list_id as string | undefined;
  if (!currentListId) return false;
  try {
    const { resolveListIdForTask } = await import('../integrations/microsoft-todo.js');
    const targetListId = await resolveListIdForTask(task);
    return currentListId !== targetListId;
  } catch (err) {
    log.task.debug('failed to detect list migration', {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Persist a task's ext data to disk immediately (Layer 5).
 * Used after pushTask modifies ext in memory to prevent data loss on crash.
 */
async function persistTaskExt(task: Task): Promise<void> {
  await withWriteLock(async () => {
    const store = await readStore();
    const found = store.tasks.find(t => t.id === task.id);
    if (found && task.ext) {
      found.ext = { ...found.ext, ...task.ext };
      await writeStore(store);
    }
  });
}

/**
 * Fire-and-forget: mark all sessions linked to a completed task as completed.
 * Uses dynamic import to avoid circular dependency with session-tracker.
 */
function autoCompleteTaskSessions(task: Task): void {
  if (!task.session_ids?.length) return;
  import('./session-tracker.js')
    .then(({ completeTaskSessions }) => completeTaskSessions(task.session_ids))
    .then((count) => {
      if (count > 0) {
        log.task.info('auto-completed sessions for task', { taskId: task.id, count });
        bus.emit(EventNames.SESSION_ENDED, { taskId: task.id, autoCompleted: count }, ['web-ui']);
      }
    })
    .catch((err) => {
      log.task.warn('failed to auto-complete task sessions', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * One-time migration: scan all COMPLETE tasks and mark their linked sessions as completed.
 * Safe to call multiple times — skips sessions already in terminal state.
 * Returns the total number of sessions updated.
 */
export async function migrateCompletedTaskSessions(): Promise<number> {
  const store = await readStore();
  const completeTasks = store.tasks.filter((t) => t.phase === 'COMPLETE' && t.session_ids?.length);
  if (completeTasks.length === 0) return 0;

  const allSessionIds = new Set<string>();
  for (const t of completeTasks) {
    for (const sid of t.session_ids) allSessionIds.add(sid);
  }

  const { completeTaskSessions } = await import('./session-tracker.js');
  const count = await completeTaskSessions([...allSessionIds]);
  if (count > 0) {
    log.task.info('migrated stale sessions from completed tasks', { count, tasks: completeTasks.length });
  }
  return count;
}

/**
 * Create a new task. Returns the created task.
 */
export async function addTask(input: AddTaskInput): Promise<{ task: Task; syncResult: SyncResult }> {
  // Read-modify-write under lock; sync push happens outside to avoid holding lock during network I/O
  const { task, createdProject } = await withWriteLock(async () => {
    const config = await getConfig();
    const store = await readStore();

    const now = new Date().toISOString();

    // If parent_task_id is set, inherit project/source from parent
    let parentTask: Task | undefined;
    if (input.parent_task_id) {
      const matches = store.tasks.filter((t) => t.id.startsWith(input.parent_task_id!));
      if (matches.length === 0) {
        throw new Error(`Parent task not found: ${input.parent_task_id}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous parent_task_id prefix: ${input.parent_task_id}`);
      }
      parentTask = matches[0];
    }

    // Project resolution: explicit input → parent's project → config default → Inbox.
    // An explicit '' means "Inbox, on purpose" and must NOT fall through to the
    // config default (`??` alone can't express that — updateTask already honors
    // '' as Inbox, so create and update would otherwise disagree on the same value).
    const requestedProject = (
      input.project !== undefined
        ? input.project
        : (parentTask?.project ?? config.defaults.project ?? '')
    ).trim();

    const projects = store.projects ?? {};
    const registryKey = requestedProject
      ? Object.keys(projects).find((k) => k.toLowerCase() === requestedProject.toLowerCase())
      : undefined;
    // A name about to mint a NEW registry row must pass the shape gate here —
    // this store.projects write bypasses ensureProject, and the name later
    // becomes a path segment (memory/projects/<name>/). An EXISTING row is
    // exempt so a legacy name that predates the validator stays usable.
    if (requestedProject && !registryKey) assertValidProjectName(requestedProject);
    // Canonical spelling wins so two casings can't split one project.
    const project = registryKey ?? requestedProject;
    const registrySource: TaskSource | undefined = registryKey ? projects[registryKey].source : undefined;

    // Source chain: parent → registry row → caller override → plugin claim.
    // Inbox is structurally local-only: no registry row exists for '' and no
    // provider may claim it, so a provider-sourced task MUST name a project.
    let source: TaskSource;
    if (!project) {
      const demanded = parentTask?.source ?? input.source;
      if (demanded && demanded !== 'local') {
        throw new Error(
          `Cannot create a ${demanded} task in Inbox — provider-synced tasks need a project. Pass a project name.`,
        );
      }
      source = 'local';
    } else {
      // The registry row OUTRANKS input.source deliberately: the project's claim
      // is the source of record, so a caller naming a claimed project gets that
      // provider rather than a 409 (the task has to be pushable to live there).
      // input.source only decides a project that has no row yet. A conflict is
      // therefore only reachable through parent inheritance — a child whose
      // parent belongs to provider A can't be filed under provider B's project.
      source = parentTask?.source
        ?? registrySource
        ?? input.source
        ?? (await registry.getForProject(project)).id;
    }

    // Validate project-source consistency
    const validation = validateProjectSource(project, source, config, projects);
    if (!validation.ok) {
      throw new ProjectSourceConflictError(validation.error, project, source, validation.existingSource);
    }

    const newTask: Task = {
      id: generateId(),
      title: input.title,
      status: 'todo',
      phase: 'TODO',
      priority: sanitizePriority(input.priority ?? config.defaults.priority),
      project,
      source,
      session_ids: [],
      description: input.description ?? '',
      summary: '',
      note: '',
      created_at: now,
      updated_at: now,
      due_date: input.due_date,
      ...(input.start_date ? { start_date: input.start_date } : {}),
      ...(input.end_date ? { end_date: input.end_date } : {}),
      ...(parentTask ? { parent_task_id: parentTask.id } : {}),
      ...(input.tags?.length ? { tags: [...new Set(input.tags)] } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.sprint ? { sprint: input.sprint } : {}),
    };

    // Validate and attach depends_on before pushing to store
    if (input.depends_on?.length) {
      const deduped = [...new Set(input.depends_on)];
      validateDependencyIds(store, newTask.id, deduped);
      // No cycle check needed for new tasks — they can't be depended on yet
      newTask.depends_on = deduped;
    }

    // Plugin content validation (before writing to store)
    if (!input._skipPluginOps) {
      runPluginContentValidation(newTask, 'title', newTask.title);
      if (newTask.description) runPluginContentValidation(newTask, 'description', newTask.description);
    }

    store.tasks.push(newTask);

    // Auto-ensure the registry row for a brand-new project name. Done through
    // store.projects (not ensureProjectRowLocked) because writeStore rewrites the
    // whole registry from this snapshot right after.
    let createdProject: { name: string; source: TaskSource } | undefined;
    if (project && !registryKey) {
      store.projects = { ...projects, [project]: { source } };
      createdProject = { name: project, source };
    }

    await writeStore(store);

    return { task: newTask, createdProject };
  });

  if (createdProject) emitProjectCreated(createdProject.name, createdProject.source);

  // Local-source tasks never push, so async vs sync is moot — skip the branch.
  if (input._skipPluginOps || task.source === 'local') {
    return { task, syncResult: { success: true } as SyncResult };
  }

  // Async push: write-locally-then-push. Return the local task immediately; the push
  // runs in the background and reconciles ext/external_url/sync_error via TASK_UPDATED.
  // This is what makes web quick-add feel instant even when the target is external.
  if (input.asyncPush) {
    autoPushIfConfigured(task).catch((err) => {
      log.task.warn('async task push failed', {
        taskId: task.id, source: task.source,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // syncResult is "accepted, pending" — the caller doesn't block on the round-trip.
    return { task, syncResult: { success: true } as SyncResult };
  }

  // Synchronous push (programmatic callers that report syncResult): push to sync target
  // and capture result (outside lock to avoid holding it during network I/O).
  const syncResult = await autoPushIfConfigured(task);

  // Re-read the task from the store to pick up ext fields set by the push (e.g. plugin ext data).
  // autoPushIfConfigured writes these to the store but the local `task` object is stale.
  if (syncResult.success) {
    const updatedStore = await readStore();
    const fresh = updatedStore.tasks.find((t) => t.id === task.id);
    if (fresh) Object.assign(task, fresh);
  }

  return { task, syncResult };
}

export interface ListTasksFilter {
  status?: string;
  /** Exact project match. '' filters to Inbox; undefined = no project filter. */
  project?: string;
}

/**
 * List tasks, optionally filtered by status and/or project.
 */
export async function listTasks(filter: ListTasksFilter = {}): Promise<Task[]> {
  const store = await readStore();
  let tasks = store.tasks;

  if (filter.status) {
    tasks = tasks.filter((t) => t.status === filter.status);
  }
  if (filter.project !== undefined) {
    tasks = tasks.filter((t) => (t.project || '') === filter.project);
  }

  return tasks;
}

/**
 * Slim variant of Task: note/conversation_log stripped, with boolean presence
 * flags. Shape MUST match the post-process strip at /api/tasks slim path so
 * the frontend (TodoPanel.tsx:841-843) sees the exact same keys.
 *
 * In `minimal` mode (the home list payload) the heavy `summary`/`description`/
 * `ext` fields are ALSO dropped — the list view never renders them (verified:
 * only the detail pane + kebab menu read them), and the detail pane lazy-loads
 * the full task via fetchTask(id) on focus. has_summary/has_description/has_ext
 * are then present so the UI knows to trigger that lazy load.
 */
export type SlimTask = Omit<Task, 'note' | 'conversation_log'> & {
  has_note: boolean;
  has_conversation_log: boolean;
  // Only populated in minimal mode; undefined on the regular slim path (where
  // summary/description/ext are still inlined).
  has_summary?: boolean;
  has_description?: boolean;
  has_ext?: boolean;
  // Precomputed `!!task.ext?.[task.source]` so the kebab menu's synced/unsynced
  // badge survives ext being dropped from the minimal payload.
  has_synced?: boolean;
};

export interface ListTasksSlimFilter extends ListTasksFilter {
  source?: string;
  /**
   * Minimal projection for the home list: additionally omit summary,
   * description, and ext (~2.6MB of a 4MB payload) and return presence flags
   * instead. The detail pane lazy-loads the full content on focus.
   */
  minimal?: boolean;
}

/**
 * Slim list — omits `note` and `conversation_log` at the storage layer so we
 * don't materialize their strings in memory when the caller only needs
 * presence booleans. SELECT skips the heavy columns; has_note /
 * has_conversation_log are computed in SQL.
 */
export async function listTasksSlim(filter: ListTasksSlimFilter = {}): Promise<SlimTask[]> {
  await ensureInit();

  const db = getDb()!;
  const minimal = filter.minimal === true;
  // Column list mirrors EXPLICIT_TASK_COLUMNS minus note/conversation_log.
  // Keep `payload` so custom fields (Task type additions without a dedicated
  // column) still round-trip, matching rowToTask's payload-merge behavior.
  // In minimal mode, additionally drop summary/description/ext — the list view
  // never renders them; they're lazy-loaded on focus via fetchTask(id).
  const heavyCols = ['summary', 'description', 'ext'];
  const selectCols = [
    'id', 'title', 'project', 'status', 'phase', 'priority', 'source',
    'parent_task_id', 'due_date', 'start_date', 'created_at', 'updated_at', 'completed_at',
    'sprint', 'focus_tier', 'pinned', 'ext', 'tags', 'depends_on', 'session_ids',
    'summary', 'description', 'sync_error', '_synced_at', 'payload',
  ].filter((c) => !(minimal && heavyCols.includes(c)));
  // has_note mirrors JS `!!task.note` (string column; empty string is falsy).
  // has_conversation_log mirrors `!!task.conversation_log` where the column
  // holds the JSON-encoded form (taskToRow JSON.stringifys it). So falsy JS
  // values '' / null / undefined encode to NULL / '""' / 'null' — explicitly
  // reject all three.
  let sqlCols = selectCols.join(', ')
    + ', (note IS NOT NULL AND note != \'\') AS has_note'
    + ', (conversation_log IS NOT NULL AND conversation_log != \'\''
    + ' AND conversation_log != \'""\' AND conversation_log != \'null\') AS has_conversation_log';
  // In minimal mode the heavy columns are not SELECT'd, so compute presence
  // flags in SQL for the lazy-load trigger. ext is a JSON column; '{}' / 'null'
  // / '""' encode an effectively-empty value — reject those alongside NULL.
  // has_synced mirrors the kebab menu's `!!task.ext?.[task.source]` so dropping
  // ext from the list payload doesn't lose the synced/unsynced status badge:
  // json_extract(ext, '$.<source>') is non-null when that source has synced.
  if (minimal) {
    sqlCols += ', (summary IS NOT NULL AND summary != \'\') AS has_summary'
      + ', (description IS NOT NULL AND description != \'\') AS has_description'
      + ', (ext IS NOT NULL AND ext != \'\' AND ext != \'{}\''
      + ' AND ext != \'null\' AND ext != \'""\') AS has_ext'
      + ', (source IS NOT NULL AND source != \'local\''
      + ' AND ext IS NOT NULL AND json_valid(ext)'
      + ' AND json_extract(ext, \'$.\' || source) IS NOT NULL) AS has_synced';
  }

  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filter.status) { where.push('status = @status'); params.status = filter.status; }
  if (filter.project !== undefined) {
    // project is nullable in SQL; '' (Inbox) must match both NULL and ''.
    if (filter.project === '') {
      where.push("(project IS NULL OR project = '')");
    } else {
      where.push('project = @project');
      params.project = filter.project;
    }
  }
  if (filter.source) { where.push('source = @source'); params.source = filter.source; }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const sql = `SELECT ${sqlCols} FROM tasks${whereSql} ORDER BY updated_at DESC`;
  const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
  return rows.map((r) => rowToSlimTask(r, minimal));
}

/**
 * Row → SlimTask. Mirrors rowToTask but skips note/conversation_log columns
 * (they aren't SELECT'd) and carries through the SQL-computed presence flags
 * as proper booleans (SQLite returns 0/1 for boolean expressions).
 */
function rowToSlimTask(row: Record<string, any>, minimal = false): SlimTask {
  // Feed the row into rowToTask minus note/conversation_log so we reuse the
  // payload merge, JSON parsing, pinned coercion, and _syncedAt aliasing.
  // Since note/conversation_log aren't in the row, rowToTask's defaulting
  // logic will set note='' (but we strip it right after) and leave
  // conversation_log undefined — exactly what we want for a slim object.
  const base = rowToTask(row) as Partial<Task> & Record<string, unknown>;
  // rowToTask defaults note to '' even when absent; remove it so the SlimTask
  // shape doesn't accidentally carry an empty `note` alongside `has_note`.
  delete base.note;
  delete base.conversation_log;
  if (minimal) {
    // Heavy columns weren't SELECT'd, so rowToTask defaulted them (summary=''
    // / description='' / ext={}). Strip those empty placeholders on the Partial
    // `base` (before the SlimTask spread) so the minimal payload omits them
    // entirely; the SQL-computed presence flags drive the detail pane's
    // lazy-load on focus. (delete is type-legal on the Partial<Task> base.)
    delete base.summary;
    delete base.description;
    delete base.ext;
  }
  const slim: SlimTask = {
    ...(base as Omit<Task, 'note' | 'conversation_log'>),
    has_note: row.has_note === 1 || row.has_note === true,
    has_conversation_log: row.has_conversation_log === 1 || row.has_conversation_log === true,
  };
  if (minimal) {
    slim.has_summary = row.has_summary === 1 || row.has_summary === true;
    slim.has_description = row.has_description === 1 || row.has_description === true;
    slim.has_ext = row.has_ext === 1 || row.has_ext === true;
    slim.has_synced = row.has_synced === 1 || row.has_synced === true;
  }
  return slim;
}

// ── Dependency helpers (used inside withWriteLock) ──

/**
 * Validate dependency IDs exist (full match, not prefix) and are not self-referencing.
 * Throws on validation failure.
 */
function validateDependencyIds(store: TaskStore, taskId: string, depIds: string[]): void {
  const taskMap = new Map(store.tasks.map(t => [t.id, t]));
  for (const depId of depIds) {
    if (depId === taskId) {
      throw new Error('A task cannot depend on itself.');
    }
    if (!taskMap.has(depId)) {
      throw new Error(`Dependency target not found: "${depId}". Use full task IDs for depends_on.`);
    }
  }
}

/**
 * BFS cycle detection: check if adding depIds to taskId would create a cycle.
 * Walks the transitive depends_on graph from each depId and checks if any path
 * leads back to taskId.
 */
function checkCircularDependency(store: TaskStore, taskId: string, depIds: string[]): void {
  const taskMap = new Map(store.tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const queue = [...depIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) {
      // depIds[0] is used as the "culprit" in the error message. The previous
      // depIds.find(d => depIds.includes(d)) was a tautology — the predicate
      // matches the first element, so it always returned depIds[0]. Tracking
      // which specific dep triggered the cycle would require a different
      // algorithm (per-dep traversal). For now, report the first one.
      throw new CircularDependencyError(taskId, depIds[0]);
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const depTask = taskMap.get(current);
    if (depTask?.depends_on) {
      for (const next of depTask.depends_on) {
        if (!visited.has(next)) queue.push(next);
      }
    }
  }
}

/**
 * Apply dependency mutations (add/remove/set) to a task, with validation.
 * Must be called inside withWriteLock.
 */
function applyDependencyMutations(
  store: TaskStore,
  task: Task,
  updates: Pick<UpdateTaskInput, 'add_depends_on' | 'remove_depends_on' | 'set_depends_on'>,
): void {
  if (updates.set_depends_on !== undefined) {
    // Replace all
    const deduped = [...new Set(updates.set_depends_on)];
    if (deduped.length > 0) {
      validateDependencyIds(store, task.id, deduped);
      checkCircularDependency(store, task.id, deduped);
      task.depends_on = deduped;
    } else {
      delete task.depends_on;
    }
  } else {
    if (updates.add_depends_on?.length) {
      validateDependencyIds(store, task.id, updates.add_depends_on);
      const existing = new Set(task.depends_on ?? []);
      const newDeps = updates.add_depends_on.filter(d => !existing.has(d));
      if (newDeps.length > 0) {
        checkCircularDependency(store, task.id, newDeps);
        for (const d of newDeps) existing.add(d);
        task.depends_on = [...existing];
      }
    }
    if (updates.remove_depends_on?.length) {
      const toRemove = new Set(updates.remove_depends_on);
      const remaining = (task.depends_on ?? []).filter(d => !toRemove.has(d));
      if (remaining.length > 0) {
        task.depends_on = remaining;
      } else {
        delete task.depends_on;
      }
    }
  }
}

/**
 * Check if a task is blocked: has depends_on entries where any referenced task is not COMPLETE.
 */
export function isTaskBlocked(task: Task, allTasks: Task[]): boolean {
  if (!task.depends_on?.length) return false;
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  return task.depends_on.some(depId => {
    const dep = taskMap.get(depId);
    return dep && dep.phase !== 'COMPLETE';
  });
}

/**
 * Guard: block completing a parent task that still has active (non-COMPLETE) children.
 * Call inside withWriteLock where the store is already loaded.
 */
function guardActiveChildren(store: TaskStore, task: Task): void {
  const activeChildren = store.tasks.filter(
    (t) => t.parent_task_id === task.id && t.phase !== 'COMPLETE',
  );
  if (activeChildren.length > 0) {
    throw new ActiveChildrenError(task.title, activeChildren);
  }
}

/**
 * Complete a task by partial ID match. Returns the completed task.
 * Throws if no match or ambiguous match.
 */
export async function completeTask(idPrefix: string): Promise<{ task: Task }> {
  // Lock-internal phase: write local store. Push runs OUTSIDE the lock because
  // autoPushIfConfigured() acquires the same lock when setting sync_error;
  // holding the lock during the await would self-deadlock the whole task system.
  const { task, oldPhase } = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    const oldPhase = t.phase;
    guardActiveChildren(store, t);
    applyPhase(t, 'COMPLETE');
    // Auto-unpin completed tasks so they don't linger in Focus Bar
    if (t.pinned) {
      t.pinned = false;
      delete t.pin_order;
      delete t.focus_tier;
      // Compact remaining pin orders
      const pinned = store.tasks.filter((x) => x.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
      pinned.forEach((x, i) => { x.pin_order = i; });
    }
    t.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task: t, oldPhase };
  });

  // Sync push (outside lock). Failure propagates to caller — plugin tasks must
  // round-trip to the remote store, so a silent failure is worse than blocking.
  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  autoCompleteTaskSessions(task);
  emitPhaseChanged(task, oldPhase, 'api');

  return { task };
}

/**
 * Toggle a task between todo and done states by partial ID match.
 */
export async function toggleComplete(idPrefix: string): Promise<{ task: Task }> {
  // Lock-internal: write local store. Push runs outside the lock to avoid
  // self-deadlock (autoPushIfConfigured re-acquires the same lock on plugin
  // not loaded → set sync_error).
  const { task, oldPhase } = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    const oldPhase = t.phase;
    if (t.phase === 'COMPLETE') {
      applyPhase(t, 'TODO');
    } else {
      guardActiveChildren(store, t);
      applyPhase(t, 'COMPLETE');
      // Auto-unpin completed tasks
      if (t.pinned) {
        t.pinned = false;
        delete t.pin_order;
        delete t.focus_tier;
        const pinned = store.tasks.filter((x) => x.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
        pinned.forEach((x, i) => { x.pin_order = i; });
      }
    }
    t.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task: t, oldPhase };
  });

  // Sync push (outside lock). Failure propagates to caller — toggle should not
  // silently desync.
  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  if (task.phase === 'COMPLETE') autoCompleteTaskSessions(task);

  const eventName = task.phase === 'COMPLETE' ? EventNames.TASK_COMPLETED : EventNames.TASK_UPDATED;
  bus.emit(eventName, { task }, ['web-ui', 'main-agent'], { source: 'internal' });
  emitPhaseChanged(task, oldPhase, 'api');
  return { task };
}

/** One task's outcome in a batch op: applied, or skipped with a reason. */
export interface BatchTaskOutcome {
  id: string;
  title?: string;
  ok: boolean;
  /** Present when ok=false — human-readable reason (active children, active sessions, …). */
  error?: string;
}

export interface BatchPhaseResult {
  /** Tasks whose phase actually changed and was persisted locally. */
  changed: Task[];
  /** Tasks NOT applied — guard rejection (active children), unknown/ambiguous id. */
  failed: BatchTaskOutcome[];
  /**
   * Tasks applied locally whose EXTERNAL sync push failed. Deliberately separate
   * from `failed`: the local write committed, so the row genuinely is complete and
   * the client must not roll it back or report "could not complete". Folding these
   * into `failed` made a fully-successful batch report total failure whenever the
   * tasks belonged to a plugin-claimed project with no plugin loaded.
   */
  syncFailed: BatchTaskOutcome[];
}

/**
 * Set the phase of MANY tasks in ONE store write (multi-select "Complete" /
 * "Reopen"). Deliberately NOT a loop over completeTask(): that would take the
 * write lock + rewrite the whole store per task, so completing 10 tasks meant 10
 * full-store rewrites and 10 separate WS events (the UI then flickered row by row).
 *
 * Per-task guards are still enforced INDIVIDUALLY — a task with active children
 * can't be completed — but a guard failure only skips THAT task and is reported in
 * `failed`; the rest still apply. Partial success is the right semantics here: the
 * user picked 10 rows and one being un-completable must not void the other 9.
 *
 * Completing also auto-unpins (same rule as completeTask) so done tasks don't
 * linger in the Focus bar, and pin_order is compacted once for the whole batch.
 * External-sync push + session auto-complete run OUTSIDE the lock, per task, the
 * same way completeTask does (autoPushIfConfigured re-enters the lock).
 */
export async function setPhaseBulk(
  idPrefixes: string[],
  phase: TaskPhase,
): Promise<BatchPhaseResult> {
  if (!idPrefixes.length) return { changed: [], failed: [], syncFailed: [] };
  if (!VALID_PHASES.has(phase)) throw new Error(`Invalid phase "${phase}"`);

  const { changed, failed, oldPhases } = await withWriteLock(async () => {
    const store = await readStore();
    const applied: Task[] = [];
    const skipped: BatchTaskOutcome[] = [];
    const priorPhases = new Map<string, TaskPhase>();
    const now = new Date().toISOString();

    for (const prefix of [...new Set(idPrefixes)]) {
      const matches = store.tasks.filter((t) => t.id.startsWith(prefix));
      if (matches.length === 0) {
        skipped.push({ id: prefix, ok: false, error: `No task found matching ID prefix "${prefix}"` });
        continue;
      }
      if (matches.length > 1) {
        skipped.push({ id: prefix, ok: false, error: `Ambiguous ID prefix "${prefix}" matches ${matches.length} tasks` });
        continue;
      }
      const t = matches[0];
      if (t.phase === phase) continue; // already there — not a failure, just a no-op
      if (phase === 'COMPLETE') {
        // Guard per task, not per batch: one blocked parent must not void the rest.
        // Children already inside THIS batch count as being completed, so selecting
        // a parent together with its children succeeds (the natural user intent).
        const activeChildren = store.tasks.filter(
          (c) => c.parent_task_id === t.id
            && c.phase !== 'COMPLETE'
            && !applied.some((a) => a.id === c.id),
        );
        if (activeChildren.length > 0) {
          skipped.push({
            id: t.id,
            title: t.title,
            ok: false,
            error: new ActiveChildrenError(t.title, activeChildren).message,
          });
          continue;
        }
      }
      priorPhases.set(t.id, t.phase);
      applyPhase(t, phase);
      if (phase === 'COMPLETE' && t.pinned) {
        t.pinned = false;
        delete t.pin_order;
        delete t.focus_tier;
      }
      t.updated_at = now;
      applied.push(t);
    }

    if (applied.length === 0) return { changed: applied, failed: skipped, oldPhases: priorPhases };

    // Compact pin orders ONCE for the whole batch (completeTask does this per call).
    if (phase === 'COMPLETE') {
      const pinned = store.tasks.filter((x) => x.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
      pinned.forEach((x, i) => { x.pin_order = i; });
    }
    await writeStore(store);
    return { changed: applied, failed: skipped, oldPhases: priorPhases };
  });

  // Outside the lock (autoPushIfConfigured re-acquires it → self-deadlock).
  // Unlike completeTask a sync failure does NOT throw and is NOT merged into
  // `failed`: the local write already committed for every task in `changed`, so the
  // phase change is real. Reporting it as a failure would make the client roll back
  // (or warn about) rows that genuinely did change — which is exactly what happens
  // for any plugin-sourced task whose plugin isn't loaded.
  const syncFailed: BatchTaskOutcome[] = [];
  for (const task of changed) {
    const syncResult = await autoPushIfConfigured(task);
    if (!syncResult.success) {
      syncFailed.push({ id: task.id, title: task.title, ok: false, error: `Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}` });
    }
    if (task.phase === 'COMPLETE') autoCompleteTaskSessions(task);
    const prior = oldPhases.get(task.id);
    if (prior !== undefined) emitPhaseChanged(task, prior, 'bulk');
  }

  return { changed, failed, syncFailed };
}

export interface UpdateTaskInput {
  title?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  phase?: TaskPhase;
  due_date?: string;
  start_date?: string;      // When to start working (empty string clears)
  end_date?: string;        // When the working block ends (empty string clears)
  /** Move the task to another project. '' moves it to Inbox. */
  project?: string;
  starred?: boolean;
  /** Read/unread marker. false = the human has seen the latest agent output. */
  unread?: boolean;
  parent_task_id?: string;  // Set or change parent. Empty string = remove parent.
  sprint?: string;          // Set sprint name (empty string clears)
  add_tags?: string[];      // Idempotent add
  remove_tags?: string[];   // Remove specific tags
  set_tags?: string[];      // Replace all tags (overwrite)
  add_depends_on?: string[];      // Add dependency IDs (idempotent)
  remove_depends_on?: string[];   // Remove specific dependency IDs
  set_depends_on?: string[];      // Replace all dependencies (overwrite)
  cwd?: string;                   // Task-level cwd override. Empty string clears.
  cwd_missing?: boolean;          // Flag when the cwd no longer exists on disk.
}

// ── Cross-source migration ──

interface MigratedTask {
  task: Task;
  oldSource: TaskSource;
  oldExt: Record<string, unknown> | undefined;
  oldTitle: string;
}

/**
 * Migrate a task (and same-source children) to a new project + source.
 * Called inside withWriteLock — mutates store in place (no writeStore call).
 * Returns the list of migrated tasks with their old state snapshots.
 */
function migrateTaskSource(
  store: TaskStore,
  task: Task,
  newProject: string,
  newSource: TaskSource,
): MigratedTask[] {
  const now = new Date().toISOString();
  const oldSource = task.source;
  const results: MigratedTask[] = [];

  // Migrate the parent task
  const oldExt = task.ext ? structuredClone(task.ext) : undefined;
  const oldTitle = task.title;
  task.source = newSource;
  task.project = newProject;
  task.ext = undefined;
  task.external_url = undefined;
  task.sync_error = undefined;
  task.updated_at = now;
  results.push({ task, oldSource, oldExt, oldTitle });

  // Migrate same-source children (they inherit parent's source)
  const children = store.tasks.filter(
    t => t.parent_task_id === task.id && t.source === oldSource,
  );
  for (const child of children) {
    const childOldExt = child.ext ? structuredClone(child.ext) : undefined;
    const childOldTitle = child.title;
    child.source = newSource;
    // Children keep their own project — only change source + ext
    child.ext = undefined;
    child.external_url = undefined;
    child.sync_error = undefined;
    child.updated_at = now;
    results.push({ task: child, oldSource, oldExt: childOldExt, oldTitle: childOldTitle });
  }

  // Register the destination project (Inbox never gets a row).
  if (newProject) {
    const projects = store.projects ?? {};
    const key = Object.keys(projects).find((k) => k.toLowerCase() === newProject.toLowerCase());
    // Preserve the existing row's order_index/metadata; only the claim changes.
    const existing = key ? projects[key] : undefined;
    store.projects = {
      ...projects,
      ...(key ? { [key]: { ...existing!, source: newSource } } : { [newProject]: { source: newSource } }),
    };
  }

  return results;
}

/**
 * Update fields on a task by partial ID match.
 */
export async function updateTask(
  idPrefix: string,
  updates: UpdateTaskInput,
  eventOptions?: { source?: string; extraTargets?: string[]; ifPhase?: TaskPhase; asyncPush?: boolean },
): Promise<{ task: Task }> {
  // Lock-internal phase: validate + mutate + persist. Returns enough state for
  // the post-lock push. Push runs OUTSIDE the lock because autoPushIfConfigured
  // re-acquires the lock when stamping sync_error → self-deadlock if held.
  const { task, oldPhase, migrationResult, parentChangeAction, cwdChanged, oldCwd, createdProject } = await withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  const oldPhase = task.phase;
  let migrationResult: MigratedTask[] | undefined;

  if (updates.title !== undefined) {
    runPluginContentValidation(task, 'title', updates.title);
    task.title = updates.title;
  }
  if (updates.priority !== undefined) task.priority = sanitizePriority(updates.priority);
  // Project move. '' = Inbox (structurally local-only, never claimed), so a
  // provider-sourced task moved there migrates to source='local'.
  let createdProject: { name: string; source: TaskSource } | undefined;
  if (updates.project !== undefined) {
    const requested = updates.project.trim();
    const projects = store.projects ?? {};
    const registryKey = requested
      ? Object.keys(projects).find((k) => k.toLowerCase() === requested.toLowerCase())
      : undefined;
    // Same shape gate as addTask: only a name minting a NEW row is validated
    // (the store.projects write below bypasses ensureProject).
    if (requested && !registryKey) assertValidProjectName(requested);
    const newProject = registryKey ?? requested;  // canonical spelling wins
    let assigned = false;

    if (newProject.toLowerCase() !== (task.project || '').toLowerCase()) {
      const config = await getConfig();
      const targetSource: TaskSource | undefined = !newProject
        ? 'local'
        : registryKey ? projects[registryKey].source : undefined;

      if (targetSource !== undefined && targetSource !== task.source) {
        // Auto-migrate: the task adopts the destination project's claim (or
        // 'local' for Inbox). Ext/external_url are dropped — the remote twin is
        // marked moved by the post-lock cleanup.
        migrationResult = migrateTaskSource(store, task, newProject, targetSource);
        assigned = true;
        log.task.info('cross-source migration triggered', {
          taskId: task.id, oldSource: migrationResult[0].oldSource,
          newSource: targetSource, newProject,
          childrenMigrated: migrationResult.length - 1,
        });
      } else {
        const validation = validateProjectSource(newProject, task.source, config, projects);
        if (!validation.ok) {
          migrationResult = migrateTaskSource(store, task, newProject, validation.existingSource);
          assigned = true;
          log.task.info('cross-source migration triggered', {
            taskId: task.id, oldSource: migrationResult[0].oldSource,
            newSource: validation.existingSource, newProject,
            childrenMigrated: migrationResult.length - 1,
          });
        } else if (newProject && !registryKey) {
          // Brand-new project name — auto-create its registry row.
          store.projects = { ...projects, [newProject]: { source: task.source } };
          createdProject = { name: newProject, source: task.source };
        }
      }
    }

    if (!assigned) task.project = newProject;
  }
  if (updates.phase !== undefined && VALID_PHASES.has(updates.phase)) {
    // CAS guard: if caller specified ifPhase, only apply phase change if current phase matches
    if (eventOptions?.ifPhase && task.phase !== eventOptions.ifPhase) {
      log.task.warn('ifPhase CAS guard: skipping phase change — task phase has moved on', {
        taskId: task.id, currentPhase: task.phase, ifPhase: eventOptions.ifPhase, requestedPhase: updates.phase,
        source: eventOptions?.source,
      });
      // Skip phase change but allow other fields to update
    } else {
    // Terminal phase guard: only human-initiated sources can overwrite COMPLETE/HUMAN_VERIFIED
    const source = eventOptions?.source ?? 'internal';
    const isHumanSource = source === 'api' || source === 'user';
    if (TERMINAL_PHASES.has(task.phase) && !TERMINAL_PHASES.has(updates.phase) && !isHumanSource) {
      log.task.warn('terminal phase guard: blocked non-human phase change', {
        taskId: task.id, currentPhase: task.phase, requestedPhase: updates.phase, source,
      });
    } else {
      if (updates.phase === 'COMPLETE') guardActiveChildren(store, task);
      applyPhase(task, updates.phase);
    }
    }
  } else if (updates.status !== undefined) {
    // Legacy: status without phase → derive phase from status
    const derivedPhase = phaseFromStatus(updates.status);
    const source = eventOptions?.source ?? 'internal';
    const isHumanSource = source === 'api' || source === 'user';
    if (TERMINAL_PHASES.has(task.phase) && !TERMINAL_PHASES.has(derivedPhase) && !isHumanSource) {
      log.task.warn('terminal phase guard: blocked non-human status change', {
        taskId: task.id, currentPhase: task.phase, requestedPhase: derivedPhase, source,
      });
    } else {
      if (derivedPhase === 'COMPLETE') guardActiveChildren(store, task);
      applyPhase(task, derivedPhase);
    }
  }
  // '' means "clear" for both dates — normalize to undefined so the store never
  // holds an empty string (downstream code checks truthiness AND !== undefined).
  if (updates.due_date !== undefined) task.due_date = updates.due_date || undefined;
  if (updates.start_date !== undefined) task.start_date = updates.start_date || undefined;
  if (updates.end_date !== undefined) task.end_date = updates.end_date || undefined;
  if (updates.starred !== undefined) task.starred = updates.starred;
  if (updates.unread !== undefined) task.unread = updates.unread;
  // Track parent change for plugin notification (fired after writeStore)
  let parentChangeAction: (() => void) | undefined;
  if (updates.parent_task_id !== undefined) {
    if (updates.parent_task_id === '') {
      // Remove parent
      const oldParent = store.tasks.find(t => t.id === task.parent_task_id);
      delete task.parent_task_id;
      if (oldParent) {
        const capturedOldParent = { ...oldParent };
        const capturedTask = { ...task };
        parentChangeAction = () => {
          pushToPlugin(capturedTask, 'disassociateSubtask', capturedOldParent, capturedTask).catch(() => {});
        };
      }
    } else {
      // Resolve parent by prefix
      const parentMatches = store.tasks.filter((t) => t.id.startsWith(updates.parent_task_id!));
      if (parentMatches.length === 0) {
        throw new Error(`Parent task not found: ${updates.parent_task_id}`);
      }
      if (parentMatches.length > 1) {
        throw new Error(`Ambiguous parent_task_id prefix: ${updates.parent_task_id}`);
      }
      const parentTask = parentMatches[0];
      if (parentTask.id === task.id) {
        throw new Error('A task cannot be its own parent.');
      }
      // Prevent circular references: walk up from parent to ensure task.id is not an ancestor
      let cursor: string | undefined = parentTask.parent_task_id;
      while (cursor) {
        if (cursor === task.id) {
          throw new Error('Circular reference: the target parent is a descendant of this task.');
        }
        const ancestor = store.tasks.find((t) => t.id === cursor);
        cursor = ancestor?.parent_task_id;
      }
      task.parent_task_id = parentTask.id;
      const capturedParent = { ...parentTask };
      const capturedTask = { ...task };
      parentChangeAction = () => {
        pushToPlugin(capturedTask, 'associateSubtask', capturedParent, capturedTask).catch(() => {});
      };
    }
  }

  // Sprint: direct field or via sprint:* tag convention
  if (updates.sprint !== undefined) {
    task.sprint = updates.sprint || undefined;
  }

  // Task-level cwd override
  const oldCwd = task.cwd;
  let cwdChanged = false;
  if (updates.cwd !== undefined) {
    const newCwd = updates.cwd || undefined;  // empty string clears
    if (newCwd !== oldCwd) {
      task.cwd = newCwd;
      cwdChanged = true;
      // If cwd is being set to a new value, clear the stale cwd_missing flag.
      // The spawn-time pre-flight will re-flag it if the new path also doesn't exist.
      if (task.cwd_missing && newCwd) task.cwd_missing = undefined;
    }
  }
  if (updates.cwd_missing !== undefined) {
    task.cwd_missing = updates.cwd_missing || undefined;
  }

  // Intercept sprint:* convention tags → redirect to task.sprint field
  if (updates.add_tags?.length) {
    const normalTags: string[] = [];
    for (const tag of updates.add_tags) {
      if (tag.startsWith('sprint:')) {
        task.sprint = tag.slice(7) || undefined; // last one wins
      } else {
        normalTags.push(tag);
      }
    }
    updates.add_tags = normalTags.length > 0 ? normalTags : undefined;
  }
  if (updates.set_tags?.length) {
    const normalTags: string[] = [];
    for (const tag of updates.set_tags) {
      if (tag.startsWith('sprint:')) {
        task.sprint = tag.slice(7) || undefined;
      } else {
        normalTags.push(tag);
      }
    }
    updates.set_tags = normalTags;
  }
  if (updates.remove_tags?.length) {
    const normalRemove: string[] = [];
    for (const tag of updates.remove_tags) {
      if (tag.startsWith('sprint:')) {
        task.sprint = undefined; // clear sprint
      } else {
        normalRemove.push(tag);
      }
    }
    updates.remove_tags = normalRemove.length > 0 ? normalRemove : undefined;
  }

  // Tag mutations
  if (updates.set_tags !== undefined) {
    // Replace all
    const deduped = [...new Set(updates.set_tags)];
    if (deduped.length > 0) {
      task.tags = deduped;
    } else {
      delete task.tags;
    }
  } else {
    if (updates.add_tags?.length) {
      const existing = new Set(task.tags ?? []);
      for (const tag of updates.add_tags) existing.add(tag);
      task.tags = [...existing];
    }
    if (updates.remove_tags?.length) {
      const toRemove = new Set(updates.remove_tags);
      const remaining = (task.tags ?? []).filter(t => !toRemove.has(t));
      if (remaining.length > 0) {
        task.tags = remaining;
      } else {
        delete task.tags;
      }
    }
  }

  // Dependency mutations (same pattern as tags)
  const hasDeps = updates.add_depends_on !== undefined ||
    updates.remove_depends_on !== undefined ||
    updates.set_depends_on !== undefined;
  if (hasDeps) {
    applyDependencyMutations(store, task, updates);
  }

  // The read marker (`unread`) is metadata about the VIEWER, not task content.
  // Clearing it when the user opens the task must NOT bump updated_at —
  // otherwise the task jumps to the top of any updated_at-ordered list a few
  // seconds after the user merely selects it.
  const changedKeys = Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined);
  const onlyReadMarker = changedKeys.length > 0 && changedKeys.every((k) => READ_MARKER_KEYS.includes(k));
  if (!onlyReadMarker) task.updated_at = new Date().toISOString();

  await writeStore(store);

  return { task, oldPhase, migrationResult, parentChangeAction, cwdChanged, oldCwd, createdProject };
  });

  // ── Post-lock phase: push to plugin (network I/O) + side effects ──
  // All operations below run OUTSIDE the write lock so re-entrant lock acquisitions
  // inside autoPushIfConfigured (e.g. sync_error stamping) don't self-deadlock.

  if (createdProject) emitProjectCreated(createdProject.name, createdProject.source);

  if (migrationResult) {
    // Cross-source migration: handle old backend cleanup + new backend push per migrated task
    for (const m of migrationResult) {
      // 1. Mark old remote as moved (rename + complete) — AWAITED to prevent sync
      //    from re-importing the still-active remote task as a duplicate.
      if (m.oldSource !== 'local' && m.oldExt) {
        const oldPlugin = registry.get(m.oldSource);
        if (oldPlugin) {
          const movedTitle = `[Moved] ${m.oldTitle} [open-walnut:${m.task.id}]`;
          const snapshot = { ...m.task, source: m.oldSource, ext: m.oldExt } as Task;
          try {
            await oldPlugin.sync.updateTitle(snapshot, movedTitle);
            await oldPlugin.sync.updatePhase(snapshot, 'COMPLETE');
          } catch (err) {
            log.task.warn('cross-source migration: old backend mark-moved failed (non-fatal)', {
              taskId: m.task.id, oldSource: m.oldSource,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // 2. Push to new backend — AWAITED so failures (e.g. plugin rejects CJK
      //    content at the push gate) propagate to the caller. The AI/tool sees
      //    the error synchronously and can fix + retry, instead of a silent
      //    fire-and-forget that reports success while the push actually failed.
      const migSync = await autoPushIfConfigured(m.task);
      if (!migSync.success) {
        throw new Error(`Sync to ${m.task.source} failed: ${migSync.error ?? 'unknown error'}`);
      }

      // 3. Notify UI for each migrated task (primary task gets a second emit from the centralized
      //    emission below — harmless because the frontend mergeTask is idempotent).
      bus.emit(EventNames.TASK_UPDATED, { task: m.task }, ['web-ui'], { source: 'migration' });
    }
  } else if (eventOptions?.asyncPush) {
    // Async push (same contract as addTask's asyncPush): the local write is already
    // durable, so ack the caller now and reconcile the external round-trip in the
    // background. autoPushIfConfigured stamps sync_error + emits TASK_UPDATED on
    // failure, so the UI still learns about a failed push — just not by blocking
    // the HTTP response on a 2-3s network round-trip. 2026-07-31 incident: awaited
    // pushes saturated the browser's 6-connection pool and cascaded every other
    // request into 15s client timeouts.
    autoPushIfConfigured(task).catch((err) => {
      log.task.warn('async task push failed', {
        taskId: task.id, source: task.source,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    // Normal (non-migration) sync push — propagate failure to caller. Calls that
    // wrote to plugin-backed tasks must surface push errors (plugin not loaded,
    // remote rejection, network) so callers see "task didn't actually sync."
    const syncResult = await autoPushIfConfigured(task);
    if (!syncResult.success) {
      throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
    }
  }
  if (parentChangeAction) parentChangeAction();
  if (task.phase === 'COMPLETE') autoCompleteTaskSessions(task);

  // Centralized event emission — every updateTask() call notifies the UI.
  // All other task-mutating functions (addNote, updateDescription, toggleComplete,
  // etc.) also auto-emit internally. Only updateTaskRaw() is silent (by design).
  const targets = ['web-ui', ...(eventOptions?.extraTargets ?? [])];
  bus.emit(EventNames.TASK_UPDATED, { task }, targets, { source: eventOptions?.source ?? 'internal' });
  emitPhaseChanged(task, oldPhase, eventOptions?.source ?? 'internal');

  // When a task's cwd changes, migrate JSONL history for each linked session so
  // `claude --resume` still finds the conversation under the new cwd-encoded dir.
  // Fire-and-forget: session hooks + UI callers don't await updateTask's internal
  // side-effects, and blocking on filesystem moves would stall unrelated TASK_UPDATED
  // propagation. Remote sessions skipped — their JSONL lives on the remote host and
  // requires a daemon-side fs.rename RPC (future work).
  if (cwdChanged && oldCwd && task.cwd) {
    const capturedOldCwd = oldCwd;
    const capturedNewCwd = task.cwd;
    const capturedTaskId = task.id;
    (async () => {
      try {
        const { getSessionsForTask } = await import('./session-tracker.js');
        const { migrateSessionJsonlForCwd } = await import('./session-jsonl-migration.js');
        const { updateSessionRecord } = await import('./session-tracker.js');
        const sessions = await getSessionsForTask(capturedTaskId);
        for (const s of sessions) {
          if (s.archived) continue;
          if (s.host) continue;
          if (!s.claudeSessionId) continue;
          await migrateSessionJsonlForCwd(
            s.claudeSessionId, capturedOldCwd, capturedNewCwd,
          ).catch(err => log.task.warn('session JSONL migration failed', {
            sessionId: s.claudeSessionId, taskId: capturedTaskId,
            error: err instanceof Error ? err.message : String(err),
          }));
          // Keep SessionRecord.cwd in sync so resume uses the new path.
          if (s.cwd === capturedOldCwd) {
            await updateSessionRecord(s.claudeSessionId, { cwd: capturedNewCwd })
              .catch(err => log.task.warn('session-record cwd sync failed', {
                sessionId: s.claudeSessionId, taskId: capturedTaskId,
                error: err instanceof Error ? err.message : String(err),
              }));
          }
        }
      } catch (err) {
        log.task.warn('post-cwd-change JSONL migration failed', {
          taskId: capturedTaskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  return { task };
}

/**
 * Add a note to a task by partial ID match.
 */
export async function addNote(idPrefix: string, content: string): Promise<{ task: Task }> {
  // Lock-internal: validate + persist. Push is moved outside the lock to prevent
  // self-deadlock (autoPushIfConfigured re-acquires this same lock).
  const task = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    runPluginContentValidation(t, 'note', content);
    t.note = t.note ? t.note + '\n\n' + content : content;
    t.updated_at = new Date().toISOString();

    await writeStore(store);
    return t;
  });

  // Sync push (outside lock). Failure propagates to caller.
  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }

  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
  return { task };
}

/**
 * Build the `### YYYY-MM-DD HH:MM` heading prepended to both conversation_log and
 * milestone entries. The format is shared on purpose so the UI can reverse/render
 * both with the same helper — keep it here as the single source of truth so a tweak
 * can't drift the two logs apart (which would silently break that shared render).
 */
function logTimestampHeading(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `### ${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Append an entry to a task's conversation_log by partial ID match.
 * Auto-prepends a timestamp heading (### YYYY-MM-DD HH:MM).
 */
export async function appendConversationLog(idPrefix: string, entry: string): Promise<{ task: Task }> {
  // Lock-internal: validate + persist. Push moved outside lock to avoid self-deadlock.
  const task = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    runPluginContentValidation(t, 'conversation_log', entry);
    const now = new Date();
    const fullEntry = `${logTimestampHeading(now)}\n${entry}`;

    t.conversation_log = t.conversation_log
      ? t.conversation_log + '\n\n' + fullEntry
      : fullEntry;
    t.updated_at = now.toISOString();

    await writeStore(store);
    return t;
  });

  // Sync push (outside lock). Failure propagates to caller.
  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }

  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
  return { task };
}

// appendMilestone was removed 2026-07-18: the note's Work Log section (session
// self-report) replaced the milestones field. See docs/decision/summarizer-self-report.md.

/**
 * Replace the entire note blob on a task by partial ID match.
 */
export async function updateNote(idPrefix: string, content: string): Promise<{ task: Task }> {
  // Lock-internal: validate + persist. Push moved outside lock to avoid self-deadlock.
  const task = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    runPluginContentValidation(t, 'note', content);
    t.note = content;
    t.updated_at = new Date().toISOString();

    await writeStore(store);
    return t;
  });

  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
  return { task };
}

export interface CompareAndSetNoteResult {
  updated: boolean;
  task: Task;
}

/**
 * Replace a task note only when it still equals the caller's merge base.
 * The comparison and write happen under the task-store lock so self-report
 * persistence cannot overwrite a human or another session's concurrent edit.
 */
export async function compareAndSetNote(
  idPrefix: string,
  expectedContent: string,
  content: string,
): Promise<CompareAndSetNoteResult> {
  const result = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));
    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    if ((task.note ?? '').trim() !== expectedContent.trim()) {
      return { updated: false, task };
    }
    runPluginContentValidation(task, 'note', content);
    task.note = content;
    task.updated_at = new Date().toISOString();
    await writeStore(store);
    return { updated: true, task };
  });

  if (!result.updated) return result;
  const syncResult = await autoPushIfConfigured(result.task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${result.task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui'], { source: 'internal' });
  return result;
}

/**
 * Set/update the description field on a task by partial ID match.
 */
export async function updateDescription(idPrefix: string, content: string): Promise<{ task: Task }> {
  // Lock-internal: validate + persist. Push moved outside lock to avoid self-deadlock.
  const task = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    runPluginContentValidation(t, 'description', content);
    t.description = content;
    t.updated_at = new Date().toISOString();

    await writeStore(store);
    return t;
  });

  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
  return { task };
}

/**
 * Set/update the summary field on a task by partial ID match.
 */
export async function updateSummary(idPrefix: string, content: string): Promise<{ task: Task }> {
  // Lock-internal: validate + persist. Push moved outside lock to avoid self-deadlock.
  const task = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const t = matches[0];
    runPluginContentValidation(t, 'summary', content);
    t.summary = content;
    t.updated_at = new Date().toISOString();

    await writeStore(store);
    return t;
  });

  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
  return { task };
}

/**
 * Get a single task by partial ID match.
 */
/**
 * Batch lookup by exact ids, predicate pushed into SQL. For periodic callers
 * (health monitor) that only need the tasks referenced by their active session
 * set — avoids materializing the whole store per tick.
 */
export async function listTasksByIds(ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  await ensureInit();
  const db = getDb()!;
  const out: Task[] = [];
  // SQLite parameter limit is 999; chunk defensively.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...chunk) as Record<string, any>[];
    for (const row of rows) out.push(rowToTask(row));
  }
  return out;
}

export async function getTask(idPrefix: string): Promise<Task> {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  return matches[0];
}

/**
 * Error thrown when a task's source conflicts with the target project's claim —
 * e.g. adding an ms-todo task to a project another plugin owns. Same shape as
 * the retired category-level conflict error so the 409 payload is unchanged.
 */
export class ProjectSourceConflictError extends Error {
  public readonly project: string;
  public readonly intendedSource: TaskSource;
  public readonly existingSource: TaskSource;
  constructor(message: string, project: string, intendedSource: TaskSource, existingSource: TaskSource) {
    super(message);
    this.name = 'ProjectSourceConflictError';
    this.project = project;
    this.intendedSource = intendedSource;
    this.existingSource = existingSource;
  }
}

/**
 * Validate that a task's source is consistent with the target project's claim.
 *
 * Rules, in priority order:
 *  1. Inbox ('') is structurally local-only — no registry row exists for it and
 *     no provider can claim it. This replaces the old config-level local
 *     reservation entirely (an unclaimable bucket is now a property of the model,
 *     not a config field the user has to maintain).
 *  2. A `plugins.<id>.project` reservation is a HARD block for any other source.
 *  3. The registry row's `source` is the claim of record — a mismatch is a SOFT
 *     conflict, i.e. updateTask migrates the task onto the project's source.
 *
 * Note it does NOT scan tasks: with a NOCASE registry the row is authoritative,
 * and pull-created drift (sync bypasses validation) must not block new creates.
 */
export type ProjectValidationReason = 'inbox_local_only' | 'config_plugin' | 'registry';

export function validateProjectSource(
  project: string,
  intendedSource: TaskSource,
  config: unknown,
  storeProjects?: Record<string, { source: TaskSource }>,
): { ok: true } | { ok: false; error: string; existingSource: TaskSource; reason: ProjectValidationReason } {
  const name = (project ?? '').trim();
  const cfg = config as Record<string, unknown>;

  if (!name) {
    if (intendedSource !== 'local') {
      return {
        ok: false,
        error: `Inbox cannot be claimed by ${intendedSource} — provider-synced tasks need a project. Pass a project name.`,
        existingSource: 'local',
        reason: 'inbox_local_only',
      };
    }
    return { ok: true };
  }

  const lower = name.toLowerCase();

  // Plugin config reservation — a hard block (user-explicit constraint).
  const plugins = (cfg?.plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, pluginCfg] of Object.entries(plugins)) {
    if (pluginId === intendedSource) continue;
    const reserved = pluginCfg?.project as string | undefined;
    if (reserved && lower === reserved.toLowerCase()) {
      return {
        ok: false,
        error: `Project "${name}" is reserved for ${pluginId} sync (plugins.${pluginId}.project). Only ${pluginId} tasks can use this project.`,
        existingSource: pluginId,
        reason: 'config_plugin',
      };
    }
  }

  // Registry claim — soft (migratable) conflict.
  if (storeProjects) {
    const key = Object.keys(storeProjects).find((k) => k.toLowerCase() === lower);
    if (key && storeProjects[key].source !== intendedSource) {
      return {
        ok: false,
        error: `Project "${name}" is claimed by ${storeProjects[key].source}. Cannot add a ${intendedSource} task to it.`,
        existingSource: storeProjects[key].source,
        reason: 'registry',
      };
    }
  }

  return { ok: true };
}

/**
 * Error thrown when attempting to delete a task that has active sessions.
 */
export class ActiveSessionError extends Error {
  public readonly activeSessionIds: string[];
  constructor(taskId: string, activeSessionIds: string[]) {
    super(
      `Cannot delete task "${taskId}": has ${activeSessionIds.length} active session(s): ${activeSessionIds.join(', ')}`,
    );
    this.name = 'ActiveSessionError';
    this.activeSessionIds = activeSessionIds;
  }
}

/**
 * Error thrown when attempting to complete a parent task that has active (non-COMPLETE) children.
 */
export class ActiveChildrenError extends Error {
  public readonly childTitles: string[];
  public readonly activeCount: number;
  constructor(taskTitle: string, activeChildren: { title: string }[]) {
    const count = activeChildren.length;
    const titles = activeChildren.slice(0, 5).map((t) => t.title);
    super(
      `Cannot complete task "${taskTitle}": ${count} child task(s) are still active (${titles.join(', ')}). Complete or delete them first.`,
    );
    this.name = 'ActiveChildrenError';
    this.childTitles = titles;
    this.activeCount = count;
  }
}

/**
 * Error thrown when a dependency mutation would create a circular dependency chain.
 */
export class CircularDependencyError extends Error {
  public readonly taskId: string;
  public readonly depId: string;
  constructor(taskId: string, depId: string) {
    super(`Circular dependency detected: adding dependency on "${depId}" from task "${taskId}" creates a cycle.`);
    this.name = 'CircularDependencyError';
    this.taskId = taskId;
    this.depId = depId;
  }
}

/**
 * Delete a task by partial ID match.
 * Throws ActiveSessionError if the task has active sessions.
 * Fire-and-forget deletes from MS To-Do / external plugins if applicable.
 */
export async function deleteTask(idPrefix: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];

  // Block deletion if task has active session slots
  const activeIds = [task.session_id, task.plan_session_id, task.exec_session_id].filter(Boolean) as string[];
  if (activeIds.length > 0) {
    throw new ActiveSessionError(task.id, activeIds);
  }

  // Remove from store
  const deletedGroupId = task.group_id;
  store.tasks = store.tasks.filter((t) => t.id !== task.id);
  // A group survives down to 1 member; deleting the LAST member empties it — prune at 0.
  if (deletedGroupId) pruneVirtualGroup(store, deletedGroupId);
  await writeStore(store);

  // Fire-and-forget: delete from remote provider via plugin
  pushToPlugin(task, 'deleteTask').catch((err) => {
    log.task.warn('failed to delete task from remote', {
      taskId: task.id,
      source: task.source,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { task };
  });
}

export interface BatchDeleteResult {
  deleted: Task[];
  failed: BatchTaskOutcome[];
}

/**
 * Delete MANY tasks in ONE store write (multi-select "Delete"). Same reasoning as
 * setPhaseBulk: a loop over deleteTask() would take the write lock and rewrite the
 * whole store per task.
 *
 * Per-task active-session guard is enforced individually and only skips that task
 * (reported in `failed`) — partial success, so one busy task doesn't void the rest.
 * `force` mirrors DELETE /api/tasks/:id?force=true: stop the task's sessions first,
 * then delete. Emptied groups are pruned once at the end.
 */
export async function deleteTasksByIds(
  idPrefixes: string[],
  opts?: { force?: boolean },
): Promise<BatchDeleteResult> {
  if (!idPrefixes.length) return { deleted: [], failed: [] };

  // Resolve first (read-only) so force-mode can stop sessions BEFORE taking the
  // write lock — completeTaskSessions/clearSessionSlot re-enter it.
  const resolved = await withWriteLock(async () => {
    const store = await readStore();
    const found: Task[] = [];
    const skipped: BatchTaskOutcome[] = [];
    for (const prefix of [...new Set(idPrefixes)]) {
      const matches = store.tasks.filter((t) => t.id.startsWith(prefix));
      if (matches.length === 0) {
        skipped.push({ id: prefix, ok: false, error: `No task found matching ID prefix "${prefix}"` });
        continue;
      }
      if (matches.length > 1) {
        skipped.push({ id: prefix, ok: false, error: `Ambiguous ID prefix "${prefix}" matches ${matches.length} tasks` });
        continue;
      }
      found.push(matches[0]);
    }
    return { found, skipped };
  });

  const failed = [...resolved.skipped];
  const targets: Task[] = [];
  for (const task of resolved.found) {
    const activeIds = [task.session_id, task.plan_session_id, task.exec_session_id].filter(Boolean) as string[];
    if (activeIds.length === 0) { targets.push(task); continue; }
    if (!opts?.force) {
      failed.push({ id: task.id, title: task.title, ok: false, error: new ActiveSessionError(task.id, activeIds).message });
      continue;
    }
    // Force: stop the sessions and clear the slots, then the task is deletable.
    const { completeTaskSessions } = await import('./session-tracker.js');
    await completeTaskSessions(activeIds);
    for (const sid of activeIds) {
      try { await clearSessionSlot(task.id, sid); } catch { /* best-effort */ }
    }
    targets.push(task);
  }

  if (targets.length === 0) return { deleted: [], failed };

  const deleted = await withWriteLock(async () => {
    const store = await readStore();
    const targetIds = new Set(targets.map((t) => t.id));
    const removed = store.tasks.filter((t) => targetIds.has(t.id));
    const touchedGroups = new Set(removed.map((t) => t.group_id).filter(Boolean) as string[]);
    store.tasks = store.tasks.filter((t) => !targetIds.has(t.id));
    // A group survives down to 1 member; prune only the ones left with 0.
    for (const gid of touchedGroups) pruneVirtualGroup(store, gid);
    await writeStore(store);
    return removed;
  });

  // Fire-and-forget remote deletes (same as deleteTask).
  for (const task of deleted) {
    pushToPlugin(task, 'deleteTask').catch((err) => {
      log.task.warn('failed to delete task from remote', {
        taskId: task.id,
        source: task.source,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return { deleted, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Virtual task groups (local-only)
//
// A "group" is a lightweight visual grouping: tasks sharing a `group_id` render
// boxed together in the list, ordered after the group's lead (top-sorted member).
// This is NOT a parent/subtask relationship — grouped tasks stay flat and fully
// independent (separate lifecycles, no inherited fields, never moved). A group is
// purely a visual cluster: ANY tasks can be grouped together regardless of their
// project (there is no scope restriction — the box just renders them as a
// unit, anchored at the lead's position in whatever list is showing them). The
// group_id lives on each task (round-trips via the SQLite payload blob); the
// human-readable name lives in store.task_groups. Nothing here is ever pushed to
// external sync backends.
//
// Invariant: CREATING a group needs ≥2 tasks, but once created a group survives
// down to a SINGLE member — a 1-member group is valid and keeps rendering (it can
// act like a tag/label on one task). A group is only dissolved when it hits ZERO
// members (the last member removed/deleted) or when the user explicitly dissolves
// it (ungroups all members at once). This is why pruneVirtualGroup only prunes at 0.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-place: if `groupId` has NO live members left, dissolve it — remove the
 * name-registry entry. A group with ≥1 member is kept (a lone member is a valid
 * group that still renders, like a tag). Mutates `store`. Caller is responsible
 * for writeStore(). Returns true if the group was pruned (i.e. it had 0 members).
 */
function pruneVirtualGroup(store: TaskStore, groupId: string): boolean {
  const members = store.tasks.filter((t) => t.group_id === groupId);
  if (members.length >= 1) return false;
  if (store.task_groups?.[groupId]) {
    delete store.task_groups[groupId];
    if (Object.keys(store.task_groups).length === 0) delete store.task_groups;
  }
  return true;
}

/** Resolve a list of id-prefixes to full tasks, erroring on miss/ambiguity. */
function resolveTasksByPrefix(store: TaskStore, idPrefixes: string[]): Task[] {
  const resolved: Task[] = [];
  for (const prefix of idPrefixes) {
    const matches = store.tasks.filter((t) => t.id.startsWith(prefix));
    if (matches.length === 0) throw new Error(`No task found matching ID prefix "${prefix}"`);
    if (matches.length > 1) throw new Error(`Ambiguous ID prefix "${prefix}" matches ${matches.length} tasks. Be more specific.`);
    resolved.push(matches[0]);
  }
  return resolved;
}

export interface GroupResult {
  group_id: string;
  label: string;
  member_ids: string[];
}

/**
 * Create a new virtual group from ≥2 tasks (by id or prefix). Tasks may belong to
 * any project — a group is a pure visual cluster with no scope rule. If
 * any task is already in a group, its existing group is merged in (all those
 * members are absorbed into the new group) — this is what lets a multi-select that
 * mixes already-grouped and ungrouped tasks "add to the existing group" rather than
 * fragment it. The label is set synchronously to the provided value, or a
 * placeholder (the lead task's title) the caller can refine asynchronously via
 * summarizeGroupLabel + renameGroup (see the fork handler / the task_group agent
 * tool). Returns the new group id + member ids.
 */
export async function groupTasks(idPrefixes: string[], label?: string): Promise<GroupResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const seed = resolveTasksByPrefix(store, [...new Set(idPrefixes)]);
    if (seed.length < 2) throw new Error('A group needs at least 2 tasks.');

    // Absorb any pre-existing groups the seed tasks belong to (merge semantics).
    const absorbedGroupIds = new Set(seed.map((t) => t.group_id).filter(Boolean) as string[]);
    const memberSet = new Set(seed.map((t) => t.id));
    for (const t of store.tasks) {
      if (t.group_id && absorbedGroupIds.has(t.group_id)) memberSet.add(t.id);
    }
    const members = store.tasks.filter((t) => memberSet.has(t.id));

    const groupId = `g_${generateId()}`;
    for (const t of members) t.group_id = groupId;
    // Drop absorbed group name entries (their members now live under groupId).
    if (store.task_groups) {
      for (const old of absorbedGroupIds) delete store.task_groups[old];
    }
    const resolvedLabel = (label?.trim()) || members[0].title;
    store.task_groups = { ...(store.task_groups ?? {}), [groupId]: { label: resolvedLabel } };

    await writeStore(store);
    return { group_id: groupId, label: resolvedLabel, member_ids: members.map((t) => t.id) };
  });
}

/**
 * Add tasks to an existing group. Tasks may belong to any project (a
 * group has no scope rule). No-op-safe: tasks already in the group are skipped.
 */
export async function addToGroup(groupId: string, idPrefixes: string[]): Promise<GroupResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const existing = store.tasks.filter((t) => t.group_id === groupId);
    if (existing.length === 0 && !store.task_groups?.[groupId]) {
      throw new Error(`Group "${groupId}" not found.`);
    }
    const toAdd = resolveTasksByPrefix(store, [...new Set(idPrefixes)]);
    // Capture any groups we're stealing tasks from so we can prune a donor that
    // drops below 2 members (otherwise it'd keep a lone member + stale registry).
    const donorGroups = new Set(
      toAdd.map((t) => t.group_id).filter((g): g is string => !!g && g !== groupId),
    );
    for (const t of toAdd) t.group_id = groupId;
    for (const donor of donorGroups) pruneVirtualGroup(store, donor);
    const members = store.tasks.filter((t) => t.group_id === groupId);
    const label = store.task_groups?.[groupId]?.label ?? members[0]?.title ?? groupId;
    if (!store.task_groups?.[groupId]) {
      store.task_groups = { ...(store.task_groups ?? {}), [groupId]: { label } };
    }
    await writeStore(store);
    return { group_id: groupId, label, member_ids: members.map((t) => t.id) };
  });
}

/**
 * Remove tasks from their group (clears group_id). If a group drops below 2
 * members it is dissolved. Returns the affected group ids.
 */
export async function removeFromGroup(idPrefixes: string[]): Promise<{ removed_ids: string[]; dissolved_group_ids: string[] }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const tasks = resolveTasksByPrefix(store, [...new Set(idPrefixes)]);
    const touchedGroups = new Set<string>();
    const removedIds: string[] = [];
    for (const t of tasks) {
      if (t.group_id) {
        touchedGroups.add(t.group_id);
        delete t.group_id;
        removedIds.push(t.id);
      }
    }
    const dissolved: string[] = [];
    for (const gid of touchedGroups) {
      if (pruneVirtualGroup(store, gid)) dissolved.push(gid);
    }
    await writeStore(store);
    return { removed_ids: removedIds, dissolved_group_ids: dissolved };
  });
}

/** Rename a group's label. */
export async function renameGroup(groupId: string, label: string): Promise<{ group_id: string; label: string }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const trimmed = label.trim();
    if (!trimmed) throw new Error('Group label cannot be empty.');
    const hasMembers = store.tasks.some((t) => t.group_id === groupId);
    if (!hasMembers && !store.task_groups?.[groupId]) throw new Error(`Group "${groupId}" not found.`);
    store.task_groups = { ...(store.task_groups ?? {}), [groupId]: { label: trimmed } };
    await writeStore(store);
    return { group_id: groupId, label: trimmed };
  });
}

/**
 * Show/hide a group in the Focus (pinned) area. Hiding is a pure rendering flag —
 * membership and the tasks themselves are untouched, and the group still renders on
 * the /tasks page. Unhide via the same call with hidden=false (surfaced in a
 * member's kebab menu). Returns the group id + resulting hidden state.
 */
export async function setGroupHidden(groupId: string, hidden: boolean): Promise<{ group_id: string; hidden: boolean }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const hasMembers = store.tasks.some((t) => t.group_id === groupId);
    const existing = store.task_groups?.[groupId];
    if (!hasMembers && !existing) throw new Error(`Group "${groupId}" not found.`);
    // Preserve the label; default it to the lead member's title if somehow missing.
    const label = existing?.label ?? store.tasks.find((t) => t.group_id === groupId)?.title ?? groupId;
    store.task_groups = { ...(store.task_groups ?? {}), [groupId]: { label, ...(hidden ? { hidden: true } : {}) } };
    await writeStore(store);
    return { group_id: groupId, hidden };
  });
}

/** List all groups with their labels + hidden flag + member ids (members with ≥1 task only). */
export async function listGroups(): Promise<Array<{ group_id: string; label: string; hidden: boolean; member_ids: string[] }>> {
  const store = await readStore();
  const byGroup = new Map<string, string[]>();
  for (const t of store.tasks) {
    if (t.group_id) {
      if (!byGroup.has(t.group_id)) byGroup.set(t.group_id, []);
      byGroup.get(t.group_id)!.push(t.id);
    }
  }
  const out: Array<{ group_id: string; label: string; hidden: boolean; member_ids: string[] }> = [];
  for (const [gid, ids] of byGroup) {
    const rec = store.task_groups?.[gid];
    out.push({ group_id: gid, label: rec?.label ?? ids[0], hidden: !!rec?.hidden, member_ids: ids });
  }
  return out;
}

/**
 * Link a session to a task's typed slot (plan or exec).
 * Also pushes to session_ids history. Replaces old linkActiveSession().
 */
export async function linkSessionSlot(
  idPrefix: string,
  sessionId: string,
  slot: 'plan' | 'exec',
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  if (slot === 'plan') {
    task.plan_session_id = sessionId;
  } else {
    task.exec_session_id = sessionId;
  }
  if (!task.session_ids.includes(sessionId)) {
    task.session_ids.push(sessionId);
  }
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  return { task };
  });
}

/**
 * Clear a session slot from a task by partial ID match.
 * If sessionId is provided, only clears the slot if it matches that session.
 * If slot is omitted, clears whichever slot matches the sessionId.
 * If neither sessionId nor slot is provided, clears both slots.
 */
export async function clearSessionSlot(
  idPrefix: string,
  sessionId?: string,
  slot?: 'plan' | 'exec',
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];

  if (sessionId) {
    // Clear the specific session from whichever slot it occupies
    if (task.plan_session_id === sessionId && (!slot || slot === 'plan')) {
      task.plan_session_id = undefined;
    }
    if (task.exec_session_id === sessionId && (!slot || slot === 'exec')) {
      task.exec_session_id = undefined;
    }
  } else if (slot) {
    // Clear a specific slot
    if (slot === 'plan') task.plan_session_id = undefined;
    else task.exec_session_id = undefined;
  } else {
    // Clear both slots
    task.plan_session_id = undefined;
    task.exec_session_id = undefined;
  }
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  return { task };
  });
}

/**
 * Add a session ID to task.session_ids for UI visibility, WITHOUT occupying
 * a session slot (plan/exec). Used by embedded subagent sessions that should
 * appear in the task's session list but not block new CLI sessions.
 */
export async function addSessionToHistory(
  idPrefix: string,
  sessionId: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    if (!task.session_ids.includes(sessionId)) {
      task.session_ids.push(sessionId);
    }
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task };
  });
}

/**
 * Replace one logical session's provider ID across every task link atomically.
 * Used when ACP session/load fails and the provider issues a fresh thread ID.
 */
export async function replaceSessionIdLinks(
  idPrefix: string,
  oldSessionId: string,
  newSessionId: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));
    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    const linked = task.session_id === oldSessionId
      || task.plan_session_id === oldSessionId
      || task.exec_session_id === oldSessionId
      || (task.session_ids ?? []).includes(oldSessionId);
    if (task.session_id === oldSessionId) task.session_id = newSessionId;
    if (task.plan_session_id === oldSessionId) task.plan_session_id = newSessionId;
    if (task.exec_session_id === oldSessionId) task.exec_session_id = newSessionId;
    task.session_ids = [...new Set(
      (task.session_ids ?? []).map((id) => id === oldSessionId ? newSessionId : id),
    )];
    if (linked && !task.session_ids.includes(newSessionId)) {
      task.session_ids.push(newSessionId);
    }
    task.updated_at = new Date().toISOString();
    await writeStore(store);
    return { task };
  });
}

/**
 * Link a session to the task's single session slot (new 1-slot model).
 * Also pushes to session_ids history.
 */
export async function linkSession(
  idPrefix: string,
  sessionId: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    task.session_id = sessionId;
    if (!task.session_ids) task.session_ids = [];
    if (!task.session_ids.includes(sessionId)) {
      task.session_ids.push(sessionId);
    }
    // Separate from updated_at: updated_at is bumped by any field change (plugin sync,
    // notes, phase changes) which would pollute "Recent" sort. last_session_update only
    // tracks actual user session interactions.
    task.last_session_update = new Date().toISOString();
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task };
  });
}

/**
 * Lightweight touch: update last_session_update without full updateTask() validation.
 * Used on session resume (handleSend) to keep "Recent" sort accurate.
 *
 * INVARIANT: session activity updates ONLY this timestamp — it must never
 * change pin_order or focus_tier. Pinned order is the user's hand ordering;
 * the old "chatting bumps the task to its tier front" behavior was removed
 * deliberately (it kept shuffling the manually-ordered sprint). Don't re-add it.
 */
export async function touchLastSessionUpdate(taskIdPrefix: string): Promise<void> {
  return withWriteLock(async () => {
    const store = await readStore();
    const task = store.tasks.find((t) => t.id.startsWith(taskIdPrefix));
    if (!task) return;
    task.last_session_update = new Date().toISOString();
    await writeStore(store);
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-touch' });
  });
}

/**
 * Clear the task's single session slot (new 1-slot model).
 * If sessionId is provided, only clears if it matches.
 */
export async function clearSession(
  idPrefix: string,
  sessionId?: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    if (sessionId) {
      if (task.session_id === sessionId) {
        task.session_id = undefined;
      }
    } else {
      task.session_id = undefined;
    }
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task };
  });
}

/**
 * Get child tasks of a parent task by partial ID match.
 */
export async function getChildTasks(taskIdPrefix: string): Promise<Task[]> {
  const parent = await getTask(taskIdPrefix);
  const store = await readStore();
  return store.tasks.filter((t) => t.parent_task_id === parent.id);
}

/**
 * Get dashboard summary data.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const store = await readStore();
  const tasks = store.tasks;

  const active = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const urgent = active.filter((t) => t.priority === 'immediate');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayTasks = active.filter((t) => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date);
    return d >= today && d < tomorrow;
  });

  const doneTasks = tasks
    .filter((t) => t.status === 'done')
    // Null-safe: legacy rows (JSON→SQLite migration) can have an undefined
    // updated_at; coalesce so the sort never throws on a missing field.
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, 5);

  const stats = {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };

  return {
    urgent_tasks: urgent,
    today_tasks: todayTasks,
    recent_tasks: doneTasks,
    recent_sessions: [],
    stats,
  };
}

/**
 * Toggle the starred state on a task by partial ID match.
 */
export async function toggleStar(idPrefix: string): Promise<{ task: Task; starred: boolean }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  task.starred = !task.starred;
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  return { task, starred: !!task.starred };
  });
}

// ── Pin helpers (task-level pin state) ──

/**
 * Toggle pin on a task (by exact ID). Returns ordered list of pinned task IDs.
 * When pinning: sets pinned=true, pin_order = min existing - 1 (surfaces at top of its tier).
 * When unpinning: clears pinned & pin_order, compacts remaining orders.
 */
export async function togglePin(taskId: string): Promise<{ pinned: boolean; pinned_tasks: string[] }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Reject pinning completed tasks — only unpin is allowed
    if (!task.pinned && (task.phase === 'COMPLETE' || task.status === 'done')) {
      throw new Error(`Cannot pin a completed task: ${task.title}`);
    }

    const now = new Date().toISOString();
    if (task.pinned) {
      // Unpin
      task.pinned = false;
      delete task.pin_order;
      delete task.focus_tier;
      task.updated_at = now;
      // Compact remaining pin orders
      const pinned = store.tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
      pinned.forEach((t, i) => { t.pin_order = i; });
    } else {
      // Pin — new pins surface at the TOP of their tier (lowest pin_order sorts first).
      // pin_order is only a relative sort key, so going below 0 (and drifting more
      // negative each pin) is intentional and harmless — the unpin branch above and
      // reorderPins() re-compact to 0..n whenever the set changes.
      const orders = store.tasks.filter((t) => t.pinned).map((t) => t.pin_order ?? 0);
      const minOrder = orders.length ? Math.min(...orders) : 0;
      task.pinned = true;
      task.pin_order = minOrder - 1;
      task.updated_at = now;
    }

    await writeStore(store);
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
    const ordered = store.tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    return { pinned: !!task.pinned, pinned_tasks: ordered.map((t) => t.id) };
  });
}

/**
 * Reorder pinned tasks. Sets pin_order = index for each ID in the array.
 * IDs not in the list keep their current pin state.
 *
 * Returns the FULL tier snapshot (not just pinned_tasks). A reorder never
 * touches focus_tier, but the client's applyFocusData() treats any missing
 * tier array as "empty" — so returning a pinned-only payload made it wipe
 * every task's focus_tier to satellite (Focus/Wait tasks silently vanished
 * until refetch). Returning the complete split keeps the client's snapshot
 * apply lossless.
 */
export async function reorderPins(orderedIds: string[]): Promise<TierResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    for (let i = 0; i < orderedIds.length; i++) {
      const task = store.tasks.find((t) => t.id === orderedIds[i]);
      if (task && task.pinned) {
        task.pin_order = i;
        task.updated_at = now;
      }
    }
    await writeStore(store);
    return splitTiers(store);
  });
}

/**
 * Return pinned tasks sorted by pin_order.
 */
export async function getPinnedTasks(): Promise<Task[]> {
  const store = await readStore();
  // Defense-in-depth: exclude completed tasks even if they have pinned=true
  return store.tasks
    .filter((t) => t.pinned && t.phase !== 'COMPLETE' && t.status !== 'done')
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
}

// Focus tiers: focus (current sprint) → satellite (needs doing soon; the
// default) → backlog (someday, still pinned) → wait (parked/blocked), plus
// user-defined custom tiers (ct_* ids, managed below).
// No cap on tasks per tier — users decide how many tasks per tier.

export interface TierResult {
  pinned_tasks: string[];
  focus_tasks: string[];
  satellite_tasks: string[];
  backlog_tasks: string[];
  wait_tasks: string[];
  /** Per registered custom tier id: pinned task ids in that tier (pin_order). */
  custom_tier_tasks: Record<string, string[]>;
}

// Non-default built-in focus_tier values (satellite = the undefined default).
const BUILTIN_TIER_VALUES = ['focus', 'backlog', 'wait'];

/** Helper: split pinned tasks into tier arrays (includes pinned_tasks for full state sync). */
function splitTiers(store: TaskStore): TierResult {
  const pinned = store.tasks
    .filter((t) => t.pinned && t.phase !== 'COMPLETE' && t.status !== 'done')
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
  const customIds = new Set((store.custom_tiers ?? []).map((t) => t.id));
  const customTierTasks: Record<string, string[]> = {};
  for (const id of customIds) {
    customTierTasks[id] = pinned.filter((t) => t.focus_tier === id).map((t) => t.id);
  }
  return {
    pinned_tasks: pinned.map((t) => t.id),
    focus_tasks: pinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id),
    // Satellite is the default tier: anything not a non-default built-in and not
    // a REGISTERED custom tier (incl. the retired 'next' value on legacy tasks
    // and stale ids of deleted custom tiers) falls here.
    satellite_tasks: pinned
      .filter((t) => !(t.focus_tier && (BUILTIN_TIER_VALUES.includes(t.focus_tier) || customIds.has(t.focus_tier))))
      .map((t) => t.id),
    backlog_tasks: pinned.filter((t) => t.focus_tier === 'backlog').map((t) => t.id),
    wait_tasks: pinned.filter((t) => t.focus_tier === 'wait').map((t) => t.id),
    custom_tier_tasks: customTierTasks,
  };
}

/** Read-only tier snapshot for the GET /api/focus/tasks route — one definition
 *  of the four-bucket split (satellite excludes REGISTERED custom ids only). */
export async function getTierSplit(): Promise<TierResult> {
  return splitTiers(await readStore());
}

// ── Custom tier registry ──
// User-defined pin tiers alongside the built-ins. Registry lives in the
// custom_tiers table (store.custom_tiers, ordered); membership lives on
// tasks.focus_tier as the tier's ct_* id.

const CUSTOM_TIER_MAX = 20;
const CUSTOM_TIER_LABEL_MAX = 40;
const BUILTIN_TIER_LABELS = ['focus', 'satellite', 'backlog', 'wait'];

/** Generate a fresh `ct_` + 8 random [a-z0-9] chars id, avoiding collisions.
 *  The id FORMAT is a cross-layer contract — change it and the frontend breaks:
 *  the `ct_` prefix is the web client's type discriminator (startsWith checks in
 *  TodoPanel/TodoSectionTabs/task-meta-constants), the id must contain no ':'
 *  (group drag sentinels are `group:<gid>:<tier>` and parseGroupSentinelGid
 *  splits on colons), and it's embedded raw in localStorage keys + CSS classes. */
function generateCustomTierId(existing: CustomTierRecord[]): string {
  const taken = new Set(existing.map((t) => t.id));
  for (;;) {
    let suffix = '';
    for (let i = 0; i < 8; i++) {
      suffix += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
    }
    const id = `ct_${suffix}`;
    if (!taken.has(id)) return id;
  }
}

// Frontend section tabs the tier tabs share a strip with (TodoSectionTabs) — a
// custom tier named "Recent" would render two identical tabs.
const RESERVED_SECTION_LABELS = ['all', 'recent', 'tasks', 'pinned', 'notes'];

/** Validate a custom tier label. Returns the trimmed label; throws on violation. */
function validateTierLabel(label: string, existing: CustomTierRecord[], excludeId?: string): string {
  // Collapse ALL whitespace (incl. newlines/tabs) to single spaces: labels are
  // interpolated into the quick-parse system prompt line-by-line, so an embedded
  // newline would break its rule structure.
  const trimmed = (label ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Tier label cannot be empty');
  if (trimmed.length > CUSTOM_TIER_LABEL_MAX) {
    throw new Error(`Tier label too long (max ${CUSTOM_TIER_LABEL_MAX} chars)`);
  }
  const lower = trimmed.toLowerCase();
  // Not just UI hygiene: the agent tool (tools.ts) and quick-task parse resolve
  // tiers BY LABEL with built-ins matched first — a custom tier named "Focus"
  // would be permanently shadowed and unreachable on those paths.
  if (BUILTIN_TIER_LABELS.includes(lower)) {
    throw new Error(`Tier label "${trimmed}" conflicts with a built-in tier`);
  }
  if (RESERVED_SECTION_LABELS.includes(lower)) {
    throw new Error(`Tier label "${trimmed}" is a reserved section name`);
  }
  // A label shaped like a tier ID would collide with the id space in the agent
  // tool's id-or-label resolution (ids match first — such a label would be
  // unreachable) — reject the whole ct_ prefix.
  if (lower.startsWith('ct_')) {
    throw new Error(`Tier label "${trimmed}" cannot start with the reserved prefix "ct_"`);
  }
  if (existing.some((t) => t.id !== excludeId && t.label.trim().toLowerCase() === lower)) {
    throw new Error(`Tier label "${trimmed}" already exists`);
  }
  return trimmed;
}

/** List registered custom tiers (ordered). */
export async function getCustomTiers(): Promise<CustomTierRecord[]> {
  const store = await readStore();
  return store.custom_tiers ?? [];
}

/** Create a custom tier. Appends to the end of the registry. */
export async function createCustomTier(label: string): Promise<{ tier: CustomTierRecord; tiers: CustomTierRecord[] }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const existing = store.custom_tiers ?? [];
    if (existing.length >= CUSTOM_TIER_MAX) {
      throw new Error(`Too many custom tiers (max ${CUSTOM_TIER_MAX})`);
    }
    const trimmed = validateTierLabel(label, existing);
    const tier: CustomTierRecord = { id: generateCustomTierId(existing), label: trimmed };
    store.custom_tiers = [...existing, tier];
    await writeStore(store);
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_tiers' }, ['web-ui']);
    return { tier, tiers: store.custom_tiers };
  });
}

/** Rename a custom tier. Same label validation as create (excluding self). */
export async function renameCustomTier(id: string, label: string): Promise<{ tier: CustomTierRecord; tiers: CustomTierRecord[] }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const existing = store.custom_tiers ?? [];
    const tier = existing.find((t) => t.id === id);
    if (!tier) throw new Error(`Tier not found: ${id}`);
    tier.label = validateTierLabel(label, existing, id);
    store.custom_tiers = existing;
    await writeStore(store);
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_tiers' }, ['web-ui']);
    return { tier, tiers: existing };
  });
}

/**
 * Delete a custom tier. Every task in it self-heals to satellite (focus_tier
 * cleared). Returns the remaining registry and how many tasks were moved.
 */
export async function deleteCustomTier(id: string): Promise<{ tiers: CustomTierRecord[]; moved: number }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const existing = store.custom_tiers ?? [];
    if (!existing.some((t) => t.id === id)) throw new Error(`Tier not found: ${id}`);
    store.custom_tiers = existing.filter((t) => t.id !== id);

    const now = new Date().toISOString();
    const movedTasks: Task[] = [];
    for (const task of store.tasks) {
      if (task.focus_tier === id) {
        delete task.focus_tier;
        task.updated_at = now;
        movedTasks.push(task);
      }
    }

    await writeStore(store);
    // Three event channels, each with a distinct consumer — don't "simplify":
    // per-task TASK_UPDATED patches this client's task objects immediately;
    // focus_tiers makes every client refetch the REGISTRY (its handler returns
    // without pulling the pinned snapshot — see useFocusBar); focus_bar is what
    // drives cross-client membership/pin_order convergence. Delete is the only
    // registry op that changes membership, hence the extra emits vs create/rename.
    for (const task of movedTasks) {
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
    }
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_tiers' }, ['web-ui']);
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui']);
    return { tiers: store.custom_tiers, moved: movedTasks.length };
  });
}

/**
 * Set the focus tier for a pinned task.
 * 'focus' = current sprint, 'satellite' = needs doing soon (the default),
 * 'backlog' = someday/low-priority, 'wait' = parked; a registered custom tier
 * id (ct_*) is also accepted. Anything else — including stale ids of deleted
 * custom tiers — self-heals to satellite (lenient by design: internal copy
 * paths like session fork pass through stale values and must not throw).
 */
export async function setFocusTier(taskId: string, tier: string): Promise<TierResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.pinned) throw new Error(`Task is not pinned: ${task.title}`);

    const isCustom = (store.custom_tiers ?? []).some((t) => t.id === tier);
    if (BUILTIN_TIER_VALUES.includes(tier) || isCustom) {
      task.focus_tier = tier;
    } else {
      if (tier !== 'satellite') {
        log.task.warn('setFocusTier: unknown tier, self-healing to satellite', {
          taskId, tier,
        });
      }
      delete task.focus_tier;
    }
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui']);

    return splitTiers(store);
  });
}

// ── Tag helpers ──

/**
 * Scan all tasks and return unique tags sorted by frequency (for autocomplete).
 */
export async function getAllTags(): Promise<{ tag: string; count: number }[]> {
  const store = await readStore();
  const tagCounts = new Map<string, number>();
  for (const task of store.tasks) {
    if (task.tags) {
      for (const tag of task.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  return [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Reorder methods ──

/**
 * Reorder tasks within one project group ('' = Inbox).
 * `orderedIds` must contain exactly the IDs of all tasks matching the group.
 * Tasks are rearranged in-place at their original index slots in the store array.
 */
export async function reorderTasks(
  project: string,
  orderedIds: string[],
): Promise<void> {
  return withWriteLock(async () => {
  const store = await readStore();

  // Find tasks belonging to this group, preserving their store indices.
  // Case-INSENSITIVE: project identity ignores case everywhere else (NOCASE PK),
  // so an exact match here silently resolved to zero entries whenever the caller's
  // spelling differed from the stored one — and the reorder became a no-op.
  const groupKey = (project || '').trim().toLowerCase();
  const groupEntries: { index: number; task: Task }[] = [];
  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    if ((t.project || '').trim().toLowerCase() === groupKey) {
      groupEntries.push({ index: i, task: t });
    }
  }

  if (groupEntries.length === 0 && orderedIds.length > 0) {
    // Was a silent no-op: ids were supplied but nothing matched the group, so the
    // user's drag simply didn't persist and nothing said why.
    log.task.warn('reorderTasks: no tasks matched the project group, reorder dropped', {
      project, requestedIds: orderedIds.length,
    });
    return;
  }

  const groupIds = new Set(groupEntries.map((e) => e.task.id));

  // Deduplicate orderedIds (keep first occurrence)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of orderedIds) {
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }

  // Self-healing: reconcile orderedIds with actual group instead of throwing.
  // This handles transient inconsistencies from concurrent operations, race
  // conditions between frontend optimistic updates and backend state, etc.
  // - Drop IDs from orderedIds that aren't in the group (stale/removed tasks)
  // - Append group IDs missing from orderedIds at the end (newly added tasks)
  const reconciledIds: string[] = [];
  for (const id of deduped) {
    if (groupIds.has(id)) {
      reconciledIds.push(id);
    }
  }
  const reconciledSet = new Set(reconciledIds);
  for (const entry of groupEntries) {
    if (!reconciledSet.has(entry.task.id)) {
      reconciledIds.push(entry.task.id);
    }
  }

  if (reconciledIds.length !== groupEntries.length) {
    // Should never happen after reconciliation, but guard just in case
    log.task.warn('reorderTasks: reconciliation mismatch, skipping reorder', {
      project, reconciledCount: reconciledIds.length, groupCount: groupEntries.length,
    });
    return;
  }

  // Build a map from id → task for quick lookup
  const taskById = new Map(groupEntries.map((e) => [e.task.id, e.task]));

  // Place reordered tasks back into their original index slots
  const indices = groupEntries.map((e) => e.index);
  for (let i = 0; i < reconciledIds.length; i++) {
    store.tasks[indices[i]] = taskById.get(reconciledIds[i])!;
  }

  await writeStore(store);
  });
}

// ── Sync adapter methods ──

/**
 * Add a fully-formed task (used by sync pull to create local tasks from remote).
 * Bypasses defaults — caller provides all fields. Does NOT trigger auto-push.
 * Plugins use task.ext for deduplication via a lookup key convention.
 */
export async function addTaskFull(taskData: Omit<Task, 'id'>): Promise<Task> {
  return withWriteLock(async () => {
  // Guard: never create tasks with missing or empty titles (e.g. from partial delta responses)
  if (!taskData.title || taskData.title.trim() === '') {
    throw new Error('addTaskFull: refusing to create task with empty title');
  }
  // PERMANENT guard: the `.metadata_project` / `.metadata_category` sentinel task
  // shape is retired — project settings live in the task_projects registry row's
  // metadata blob. The v5 migration absorbed and DELETED those rows, but the
  // remote twins still exist in providers' lists, so every pull would re-import
  // them as phantom tasks. Refusing here (not filtering at read time) keeps the
  // shape uncreatable for good. Callers on the pull path already log-and-skip
  // a create rejection, which is exactly the desired outcome.
  if (isRetiredSentinelTitle(taskData.title)) {
    log.task.warn('addTaskFull: refusing retired .metadata sentinel task', {
      title: taskData.title, source: taskData.source, project: taskData.project,
    });
    throw new Error(
      `addTaskFull: refusing to create retired sentinel task "${taskData.title}" — ` +
      `project settings live in the task_projects registry, not a .metadata task`,
    );
  }

  const store = await readStore();

  // Plugin-generic dedup: find an existing task with matching ext data.
  // Plugins store a unique remote ID in task.ext (e.g. ext['ms-todo'].id).
  // If the incoming taskData.ext has keys, try to match against existing tasks.
  if (taskData.ext && Object.keys(taskData.ext).length > 0) {
    const existing = store.tasks.find((t) => {
      if (t.source !== taskData.source || !t.ext) return false;
      // Match on first shared key with equal value
      for (const [key, val] of Object.entries(taskData.ext!)) {
        if (val != null && t.ext[key] != null && t.ext[key] === val) return true;
      }
      return false;
    });
    if (existing) {
      const priorPhase = existing.phase;
      existing.title = taskData.title;
      if (taskData.phase) {
        applyPhase(existing, taskData.phase);
      } else if (taskData.status) {
        applyPhase(existing, phaseFromStatus(taskData.status));
      }
      existing.priority = sanitizePriority(taskData.priority);
      // Guarded like the date fields below: a pull partial with no/empty project
      // (e.g. mapToLocal's '' for an Inbox-routed list) must not move an existing
      // synced task to Inbox — '' is structurally local-only, so that write would
      // strand the task (pushTask refuses Inbox) with sync_error on every tick.
      if (taskData.project !== undefined && taskData.project.trim()) {
        existing.project = taskData.project.trim();
      }
      existing.ext = { ...existing.ext, ...taskData.ext };
      // Dedup-merge is a sync-pull write path too — a full pull re-imports the
      // remote twin, so the same day-precision echo guard applies here.
      if (taskData.due_date !== undefined &&
          !isDayPrecisionEcho(existing.due_date, taskData.due_date)) {
        existing.due_date = taskData.due_date;
      }
      if (taskData.start_date !== undefined &&
          !isDayPrecisionEcho(existing.start_date, taskData.start_date)) {
        existing.start_date = taskData.start_date;
      }
      if (taskData.end_date !== undefined &&
          !isDayPrecisionEcho(existing.end_date, taskData.end_date)) {
        existing.end_date = taskData.end_date;
      }
      if (taskData.completed_at !== undefined) existing.completed_at = taskData.completed_at;
      if (taskData.external_url) existing.external_url = taskData.external_url;
      existing.updated_at = taskData.updated_at ?? new Date().toISOString();
      await writeStore(store);
      emitPhaseChanged(existing, priorPhase, 'sync');
      return existing;
    }
  }

  // Race-condition guard: title + project + source match → update ext
  if (taskData.ext && Object.keys(taskData.ext).length > 0) {
    // Project identity is case-insensitive everywhere else (NOCASE PK) — a
    // remote casing change must not defeat this dedup and mint a duplicate.
    const dup = store.tasks.find((t) =>
      t.source === taskData.source &&
      t.title === taskData.title &&
      (t.project || '').trim().toLowerCase() === (taskData.project || '').trim().toLowerCase(),
    );
    if (dup) {
      dup.ext = { ...dup.ext, ...taskData.ext };
      if (taskData.external_url) dup.external_url = taskData.external_url;
      dup.updated_at = taskData.updated_at ?? new Date().toISOString();
      await writeStore(store);
      return dup;
    }
  }

  // Pull-guard, re-keyed to the project registry: a sync pull must not create a
  // task inside a project another provider owns (e.g. ms-todo rows landing in a
  // project reserved for a different plugin). Inbox is local-only by rule.
  const incomingProject = (taskData.project ?? '').trim();
  // Retired grouping names ('Quick Start'/'Inbox') are Inbox, never projects —
  // same rule as routePulledListToProject. Without this, a provider whose
  // remote side still carries the retired tag re-mints the registry row here
  // on every pull (observed 2026-08-05: 7 tasks + a claimed 'Quick Start' row
  // resurrected minutes after the v5 data repair deleted them).
  if (incomingProject &&
      (isRetiredQuickStartGroup(incomingProject) || isLegacyInboxGroup(incomingProject))) {
    throw new Error(
      `addTaskFull: refusing to create task "${taskData.title}" under retired group "${incomingProject}" — ` +
      `that name is Inbox now, and provider-synced tasks need a real project`,
    );
  }
  if (!incomingProject) {
    if (taskData.source !== 'local') {
      throw new Error(
        `addTaskFull: refusing to create ${taskData.source} task "${taskData.title}" in Inbox — ` +
        `provider-synced tasks need a project`,
      );
    }
  } else if (store.projects) {
    const key = Object.keys(store.projects).find(
      (k) => k.toLowerCase() === incomingProject.toLowerCase(),
    );
    if (key && store.projects[key].source !== taskData.source) {
      throw new Error(
        `addTaskFull: project "${incomingProject}" is claimed by ${store.projects[key].source}, ` +
        `refusing to create ${taskData.source} task "${taskData.title}" in it`,
      );
    }
  }

  const task: Task = {
    id: generateId(),
    ...taskData,
    project: incomingProject,
    priority: sanitizePriority(taskData.priority),
  };

  // Register a project a pull just introduced, so its claim is recorded and the
  // UI/butler see it as a real project rather than an implicit one.
  let createdProject: { name: string; source: TaskSource } | undefined;
  if (incomingProject) {
    const projects = store.projects ?? {};
    const key = Object.keys(projects).find((k) => k.toLowerCase() === incomingProject.toLowerCase());
    if (key) {
      // Canonical spelling wins so a remote casing change can't split the project.
      task.project = key;
    } else {
      store.projects = { ...projects, [incomingProject]: { source: task.source } };
      createdProject = { name: incomingProject, source: task.source };
    }
  }

  store.tasks.push(task);
  await writeStore(store);
  if (createdProject) emitProjectCreated(createdProject.name, createdProject.source);
  return task;
  });
}

/** Compare update fields against current task state. */
function hasFieldChanges(task: Task, updates: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id') continue;
    const current = (task as any)[key];
    // Fast path: identical references or both primitive-equal
    if (current === value) continue;
    // null and undefined both mean "field absent" (a patch uses null as the
    // explicit-clear marker; the store never holds it) — not a real change.
    if ((current === undefined || current === null) && (value === undefined || value === null)) continue;
    // Deep compare for objects (handles key-order differences in ext, etc.)
    if (typeof current === 'object' && typeof value === 'object') {
      if (stableStringify(current) !== stableStringify(value)) return true;
    } else {
      return true; // primitives that aren't === are different
    }
  }
  return false;
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(v as Record<string, unknown>).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Post-Object.assign cleanup: a patch uses `null` as the explicit-clear marker
 * (written through to SQL NULL by taskToRow), but the in-memory Task contract
 * is "absent field = undefined". Keep the returned/emitted object consistent
 * with what rowToTask would produce on the next read.
 */
function normalizeNullClears(task: Task): void {
  const rec = task as unknown as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (rec[key] === null) delete rec[key];
  }
}

/**
 * True when an incoming day-precision date (due_date OR start_date) is just
 * the existing time-level value truncated to its UTC date part. External task
 * trackers only store day precision, so every push of a time-level value comes
 * back on the next pull as `YYYY-MM-DD` — an echo, not a user edit. Applying
 * it would strip the time the user set (e.g. the "8h" quick pill); for
 * start_date that instantly un-defers the task from the Now view.
 */
function isDayPrecisionEcho(existing: string | undefined, incoming: unknown): boolean {
  return typeof incoming === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(incoming) &&
    typeof existing === 'string' && existing.includes('T') &&
    existing.slice(0, 10) === incoming;
}

/**
 * Apply the terminal-phase guard + dirty check + phase↔status derivation to a
 * task/updates pair. Returns the canonicalized update dict that should be
 * persisted, or `null` if the update is a no-op (nothing changed).
 *
 * Extracted from the old updateTaskRaw body so both the single-row path and
 * the bulk path can reuse identical semantics. Must NEVER mutate `task` or
 * `updates` — it works on a shallow copy of the patch.
 */
function prepareRawUpdate(task: Task, updates: Partial<Task>): Partial<Task> | null {
  const { id: _ignoreId, ...safeUpdates } = updates as Record<string, unknown>;
  if (safeUpdates.priority !== undefined) {
    safeUpdates.priority = sanitizePriority(safeUpdates.priority as string);
  }
  // Day-precision echo guard: sync pull must not downgrade a time-level
  // due_date/start_date to its own truncated day (a genuinely different day
  // still applies). Human edits go through updateTask() and are unaffected.
  if (isDayPrecisionEcho(task.due_date, safeUpdates.due_date)) {
    delete safeUpdates.due_date;
  }
  if (isDayPrecisionEcho(task.start_date, safeUpdates.start_date)) {
    delete safeUpdates.start_date;
  }
  if (isDayPrecisionEcho(task.end_date, safeUpdates.end_date)) {
    delete safeUpdates.end_date;
  }
  // Terminal phase guard: sync pull cannot overwrite COMPLETE/HUMAN_VERIFIED
  // (only humans can reopen completed tasks, via updateTask with source='api')
  const incomingPhase = (safeUpdates.phase as TaskPhase | undefined)
    ?? (safeUpdates.status ? phaseFromStatus(safeUpdates.status as TaskStatus) : undefined);
  if (TERMINAL_PHASES.has(task.phase) && incomingPhase && !TERMINAL_PHASES.has(incomingPhase)) {
    log.task.warn('terminal phase guard (raw): blocked sync phase change', {
      taskId: task.id, currentPhase: task.phase, requestedPhase: incomingPhase,
    });
    delete safeUpdates.phase;
    delete safeUpdates.status;
    delete safeUpdates.completed_at;
  }

  // Dirty check: skip disk write + event if nothing actually changed
  if (!hasFieldChanges(task, safeUpdates)) {
    return null;
  }

  // Derive phase↔status consistency when only one side is provided. We don't
  // know the merged task's phase/status without applying the patch first, so
  // do a cheap Object.assign into a local copy to resolve the derivation.
  const merged: Task = { ...task, ...(safeUpdates as Partial<Task>) };
  if (safeUpdates.status && !safeUpdates.phase) {
    merged.phase = phaseFromStatus(merged.status);
    safeUpdates.phase = merged.phase;
  } else if (safeUpdates.phase && !safeUpdates.status) {
    merged.status = deriveStatusFromPhase(merged.phase);
    safeUpdates.status = merged.status;
  }
  return safeUpdates as Partial<Task>;
}

/**
 * Update a task by exact ID with raw partial fields. O(1) single-row UPDATE —
 * no full-store rewrite (unlike updateTask).
 *
 * By default it is silent (no TASK_UPDATED event, no plugin push) so sync-pull
 * callers don't trigger sync loops. Pass `opts.emitEvent`/`opts.push` to opt in:
 * used by applySessionPhase so hot-path phase transitions stay O(1) yet still
 * notify the UI and sync to external trackers.
 *
 * Returns { changed, task } — `task` is the post-update row when changed.
 */
export async function updateTaskRaw(
  id: string,
  updates: Partial<Task>,
  opts?: { emitEvent?: boolean; push?: boolean; source?: string },
): Promise<{ changed: boolean; task?: Task }> {
  await ensureInit();
  let rawOldPhase: TaskPhase | undefined;
  const updated = await withWriteLock(async () => {
    const db = getDb()!;
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    const task = rowToTask(row);
    rawOldPhase = task.phase;

    const prepared = prepareRawUpdate(task, updates);
    if (!prepared) return undefined;

    // Build the UPDATE dynamically from the fields that actually changed.
    // taskToRow() already handles column mapping + JSON encoding + payload spill.
    const patchRow = taskToRow(prepared);
    // payload is a SINGLE column holding ALL non-column fields (group_id,
    // unread, …). taskToRow(prepared) rebuilds it from the PATCH alone,
    // so a patch that touches any payload field (e.g. session phase transitions
    // set the read marker) would overwrite the whole column and silently drop
    // every untouched payload field — notably group_id, which made grouped
    // session tasks "lose" their group. Recompute payload from the fully-merged
    // task so untouched payload fields survive the partial update.
    // `?? null` is safe: a full merged Task never carries a literal `payload` key,
    // so taskToRow().payload is only ever a JSON string (has spill fields) or
    // undefined (none) — never an explicit-clear null we'd be collapsing.
    if ('payload' in patchRow) {
      patchRow.payload = taskToRow({ ...task, ...prepared }).payload ?? null;
    }
    const cols = Object.keys(patchRow);
    if (cols.length === 0) return undefined;

    const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
    const bound: Record<string, unknown> = { ...patchRow, id };
    dbTransaction((handle) => {
      handle.prepare(`UPDATE tasks SET ${setClause} WHERE id = @id`).run(bound);
    });
    invalidateRowShadow(); // targeted write on our own connection — see invalidateRowShadow
    // Return the merged post-update task so callers can emit / push without re-reading.
    Object.assign(task, prepared);
    normalizeNullClears(task);
    return task;
  });

  if (!updated) return { changed: false };

  // Optional side-effects (outside the lock — push re-acquires it). Defaults off
  // to preserve the silent contract for sync-pull callers.
  // Fire-and-forget (unlike updateTask which awaits + throws): callers here are
  // hot-path phase transitions that must not block on network. Push failures
  // stay visible because autoPushIfConfigured stamps task.sync_error and emits
  // its own TASK_UPDATED internally on every failure path — the UI still shows
  // "didn't sync" even though we swallow the rejection here.
  if (opts?.push && updated.source !== 'local') {
    autoPushIfConfigured(updated).catch(() => { /* sync_error already stamped inside */ });
  }
  if (opts?.emitEvent) {
    const eventName = updated.phase === 'COMPLETE' ? EventNames.TASK_COMPLETED : EventNames.TASK_UPDATED;
    bus.emit(eventName, { task: updated }, ['web-ui', 'main-agent'], { source: opts.source ?? 'internal' });
    if (rawOldPhase !== undefined) emitPhaseChanged(updated, rawOldPhase, opts.source ?? 'session');
  }

  return { changed: true, task: updated };
}

// ── Plugin-declared task fields (manifest taskFields) ──────────────────────

/**
 * Set a plugin-declared per-task field (see TaskFieldSpec). The value lands on
 * the core column when the spec binds one (`coreField: 'sprint'`), otherwise in
 * ext.<pluginId>.<key>. `value: null` clears. Emits TASK_UPDATED and triggers
 * the plugin push (async — UI must not wait on the external round-trip).
 * Throws if the plugin/field isn't declared, so arbitrary ext writes are
 * impossible through this path.
 */
export async function setPluginTaskField(
  idPrefix: string,
  pluginId: string,
  fieldKey: string,
  value: string | null,
): Promise<{ task: Task }> {
  const plugin = registry.get(pluginId);
  const spec = plugin?.taskFields?.find(f => f.key === fieldKey);
  if (!plugin || !spec) {
    throw new Error(`Plugin "${pluginId}" does not declare task field "${fieldKey}"`);
  }
  if (spec.clearable === false && (value === null || value === '')) {
    throw new Error(`Field "${fieldKey}" of plugin "${pluginId}" is not clearable`);
  }

  if (spec.coreField === 'sprint') {
    // Reuse the full updateTask path — sprint has existing semantics (tag
    // intercepts, projections) that must stay in one place.
    return updateTask(idPrefix, { sprint: value ?? '' }, { source: 'api', asyncPush: true });
  }

  const full = await getTask(idPrefix); // resolves prefix + throws on ambiguity
  const prevExt = (full.ext?.[pluginId] ?? {}) as Record<string, unknown>;
  const nextExt = { ...prevExt };
  if (value === null || value === '') delete nextExt[fieldKey];
  else nextExt[fieldKey] = value;
  const { changed, task } = await updateTaskRaw(
    full.id,
    { ext: { ...full.ext, [pluginId]: nextExt } },
    { emitEvent: true, push: true, source: 'api' },
  );
  return { task: changed && task ? task : full };
}

// ── Bulk APIs ───────────────────────────────────────────────────────────────
// sync-reconciler.applyDiff (task #3) and startPluginSyncPolling (task #7)
// used to call updateTaskRaw N times per tick, paying N full withWriteLock +
// writeStore cycles. The bulk APIs coalesce all changes into a single
// withWriteLock + single db.transaction, so the hot loop's main-thread cost
// scales with "number of changed rows" rather than "N × full-store write".
//
// Per-item semantics are identical to the single-row calls: terminal-phase
// guard, dirty check, phase↔status derivation all run inside the transaction.

/**
 * Apply raw field patches to many tasks in a single transaction.
 * Missing IDs are silently skipped. Returns only the tasks whose rows were
 * actually modified (dirty-check passed + write succeeded).
 */
export async function updateTasksBulk(
  updates: Array<{ id: string; patch: Partial<Task> }>,
): Promise<{ changed: Task[] }> {
  if (!updates.length) return { changed: [] };
  await ensureInit();
  return withWriteLock(async () => {
    const changedTasks: Task[] = [];
    // Collect per-row work inside the transaction — read-modify-write for
    // each id, stopping the first time a patch turns out to be a no-op for
    // that id. One transaction, O(k) prepared statements where k = changed.
    dbTransaction((handle) => {
      const sel = handle.prepare('SELECT * FROM tasks WHERE id = ?');
      for (const { id, patch } of updates) {
        const row = sel.get(id) as Record<string, any> | undefined;
        if (!row) continue;
        const task = rowToTask(row);
        const prepared = prepareRawUpdate(task, patch);
        if (!prepared) continue;
        const patchRow = taskToRow(prepared);
        // See updateTaskRaw: recompute the payload column from the merged task so
        // a patch touching one payload field doesn't wipe the others (group_id …).
        if ('payload' in patchRow) {
          patchRow.payload = taskToRow({ ...task, ...prepared }).payload ?? null;
        }
        const cols = Object.keys(patchRow);
        if (cols.length === 0) continue;
        const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
        handle.prepare(`UPDATE tasks SET ${setClause} WHERE id = @id`).run({ ...patchRow, id });
        // Apply the patch to the in-memory task object so callers see the
        // post-update view in the returned array.
        Object.assign(task, prepared);
        normalizeNullClears(task);
        changedTasks.push(task);
      }
    });
    if (changedTasks.length) invalidateRowShadow(); // see invalidateRowShadow
    return { changed: changedTasks };
  });
}

/**
 * Insert many tasks in a single transaction. Assigns an id when the caller
 * didn't supply one (matches generateId() semantics the single-row code
 * path uses). Returns the inserted tasks in input order.
 *
 * NOTE: Unlike addTask(), this helper is for bulk-pull paths (sync-reconciler,
 * plugin import). It does NOT run the create-time validation chain
 * (project claim conflict, parent lookup, plugin content validation). Callers that
 * need those checks should use addTask() per row.
 */
export async function addTasksBulk(
  tasks: Array<Omit<Task, 'id'> & { id?: string }>,
): Promise<Task[]> {
  if (!tasks.length) return [];
  await ensureInit();
  return withWriteLock(async () => {
    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT OR REPLACE INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    const created: Task[] = [];
    dbTransaction((handle) => {
      const stmt = handle.prepare(insertSql);
      for (const td of tasks) {
        if (!td.title || td.title.trim() === '') continue;
        // Same permanent refusal as addTaskFull — the reconciler's fullPull is the
        // other pull path that would otherwise re-import remote sentinel twins.
        if (isRetiredSentinelTitle(td.title)) {
          log.task.warn('addTasksBulk: skipping retired .metadata sentinel task', {
            title: td.title, source: td.source,
          });
          continue;
        }
        const task: Task = {
          id: td.id ?? generateId(),
          ...td,
          priority: sanitizePriority(td.priority),
        } as Task;
        const partial = taskToRow(task);
        const bound: Record<string, unknown> = {};
        for (const col of insertCols) {
          bound[col] = partial[col] === undefined ? null : partial[col];
        }
        stmt.run(bound);
        created.push(task);
      }
    });
    if (created.length) invalidateRowShadow(); // see invalidateRowShadow
    return created;
  });
}

/**
 * Delete many tasks by id in a single transaction. Returns the tasks that
 * were actually present and removed (missing ids silently skipped).
 */
export async function deleteTasksBulk(ids: string[]): Promise<{ deleted: Task[] }> {
  if (!ids.length) return { deleted: [] };
  await ensureInit();
  return withWriteLock(async () => {
    const deleted: Task[] = [];
    dbTransaction((handle) => {
      const sel = handle.prepare('SELECT * FROM tasks WHERE id = ?');
      const del = handle.prepare('DELETE FROM tasks WHERE id = ?');
      for (const id of ids) {
        const row = sel.get(id) as Record<string, any> | undefined;
        if (!row) continue;
        deleted.push(rowToTask(row));
        del.run(id);
      }
    });
    if (deleted.length) invalidateRowShadow(); // see invalidateRowShadow
    return { deleted };
  });
}

// ── Plugin ext-id lookup ────────────────────────────────────────────────────
// Plugin sync ticks used to rebuild a 6000-entry per-plugin Map every tick by
// iterating listTasks() and reading ext. findTaskByExtId replaces that with a
// single indexed SELECT per remote delta row. Indexes are declared by each
// plugin via PluginApi.registerExtIndex and opened by task-db.ensureExtIndexes
// at load time — this module only reads the resulting registry.

/** Prepared-statement cache, keyed on `${source}|${jsonPath}` so multiple
 *  plugins (and multiple paths per plugin) share one cache without colliding. */
const findByExtIdStmts: Map<string, ReturnType<import('better-sqlite3').Database['prepare']>> = new Map();

function getFindByExtIdStmt(source: string, jsonPath: string) {
  const cacheKey = `${source}|${jsonPath}`;
  const cached = findByExtIdStmts.get(cacheKey);
  if (cached) return cached;
  const db = getDb()!;
  // source and jsonPath were validated when the spec was registered (see
  // PluginApi.registerExtIndex / ensureExtIndexes). The extId value is bound
  // through `?`, never interpolated.
  const sourceLiteral = source.replace(/'/g, "''");
  const pathLiteral = jsonPath.replace(/'/g, "''");
  const sql =
    `SELECT * FROM tasks WHERE source = '${sourceLiteral}' ` +
    `AND json_extract(ext, '${pathLiteral}') = ? LIMIT 1`;
  const stmt = db.prepare(sql);
  findByExtIdStmts.set(cacheKey, stmt);
  return stmt;
}

/**
 * Look up a single task by an id its owning plugin persists into `ext`.
 *
 * The plugin must have called `PluginApi.registerExtIndex` at load time to
 * declare the json paths it owns. This function tries each declared path in
 * order and returns the first row that matches.
 *
 * Returns undefined if the source has no registered ext-index (e.g. a local
 * task whose source is `local`), if extId is empty, or if no row matches.
 *
 * Hot path — called once per remote delta row inside every plugin's sync tick.
 */
export async function findTaskByExtId(source: string, extId: string): Promise<Task | undefined> {
  if (!extId) return undefined;
  await ensureInit();

  const spec = getExtIndexSpec(source);
  if (!spec) return undefined;

  for (const p of spec.paths) {
    const row = getFindByExtIdStmt(source, p.json).get(extId) as Record<string, any> | undefined;
    if (row) return rowToTask(row);
  }
  return undefined;
}

// ── Plugin sync tick helpers ────────────────────────────────────────────────
// startPluginSyncPolling's two retry loops used to call `await listTasks()`
// and filter in JS. These two helpers push the filter into SQL so the sync
// tick no longer materializes the full task table.

/** The "primary" json path inside `ext` owned by the plugin — used by the
 *  unsynced/error retry loops as the "is this row pushed yet?" probe. By
 *  convention this is the first entry in the plugin's registered ext-index
 *  paths; multi-path plugins (e.g. one with both id and short_id) should put
 *  the canonical id first. */
function pluginPrimaryExtPath(source: string): string {
  const spec = getExtIndexSpec(source);
  if (!spec || spec.paths.length === 0) {
    throw new Error(
      `listUnsyncedTasks/listSyncErrorTasks: no ext-index registered for source "${source}". ` +
      `The plugin must call PluginApi.registerExtIndex during load.`,
    );
  }
  return spec.paths[0].json;
}

/**
 * Tasks owned by `pluginId` that haven't been pushed yet (the plugin's primary
 * ext path is null or missing) and are still open. Used by the unsynced retry
 * loop inside startPluginSyncPolling — was previously `listTasks().filter(…)`.
 */
export async function listUnsyncedTasks(pluginId: string): Promise<Task[]> {
  await ensureInit();
  const extPath = pluginPrimaryExtPath(pluginId);

  const db = getDb()!;
  // extPath came from the plugin's registered spec — validated at registration time.
  const pathLiteral = extPath.replace(/'/g, "''");
  const sql = `SELECT * FROM tasks WHERE source = ? AND status != 'done'
    AND (ext IS NULL OR json_extract(ext, '${pathLiteral}') IS NULL)`;
  const rows = db.prepare(sql).all(pluginId) as Record<string, any>[];
  return rows.map(rowToTask);
}

/**
 * Tasks owned by `pluginId` that have a non-null `sync_error`, are still open,
 * and have been pushed at least once. Used by the errorRetries loop inside
 * startPluginSyncPolling.
 */
export async function listSyncErrorTasks(pluginId: string): Promise<Task[]> {
  await ensureInit();
  const extPath = pluginPrimaryExtPath(pluginId);

  const db = getDb()!;
  const pathLiteral = extPath.replace(/'/g, "''");
  const sql = `SELECT * FROM tasks WHERE source = ? AND status != 'done'
    AND sync_error IS NOT NULL
    AND json_extract(ext, '${pathLiteral}') IS NOT NULL`;
  const rows = db.prepare(sql).all(pluginId) as Record<string, any>[];
  return rows.map(rowToTask);
}

/**
 * Run a bulk mutation over the task array, persisting the result via SQLite.
 * Used by one-shot plugin migrations at startup — the caller receives a
 * snapshot of all tasks, returns the (possibly mutated) list, and the write
 * is held under the normal write lock to serialize with other writers.
 * Returns true if anything changed (by shallow JSON compare).
 */
export async function bulkMigrateTasks(
  mutate: (tasks: Task[]) => Promise<Task[]> | Task[],
): Promise<boolean> {
  return withWriteLock(async () => {
    const store = await readStore();
    const before = JSON.stringify(store.tasks);
    const next = await mutate(store.tasks);
    store.tasks = next;
    const after = JSON.stringify(store.tasks);
    if (before === after) return false;
    await writeStore(store);
    return true;
  });
}
