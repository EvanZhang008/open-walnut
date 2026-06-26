import fsSync from 'node:fs';
import { TASKS_FILE } from '../constants.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';
import { generateId, parseGroupFromCategory } from '../utils/format.js';
import { initDirectories } from './init.js';
import { getConfig, updateConfig } from './config-manager.js';
import { bus, EventNames } from './event-bus.js';
import { VALID_PRIORITIES as VALID_PRIORITIES_ARRAY, type Task, type TaskStore, type TaskStatus, type TaskPhase, type TaskPriority, type TaskSource, type DashboardData, type CategoryRecord, type TaskGroupRecord } from './types.js';
import { applyPhase, deriveStatusFromPhase, phaseFromStatus, VALID_PHASES, TERMINAL_PHASES } from './phase.js';
import { registry } from './integration-registry.js';
import { getDb, rowToTask, taskToRow, TASK_COLUMNS, transaction as dbTransaction, TASK_DB_PATH } from './task-db.js';
import { runMigrationIfNeeded } from './task-db-migration.js';
import { getExtIndexSpec } from './ext-index-registry.js';
import yaml from 'js-yaml';

// CJK detection regex — used only for log enrichment so that "plugin not loaded"
// warnings flag the cases that an external sync plugin's validateContent would
// have rejected.
const CJK_DETECT_REGEX = /[一-鿿㐀-䶿぀-ヿ]/;

/** Ask the task's plugin to validate content before writing. Throws on rejection. */
function runPluginContentValidation(task: { source: string; id?: string }, field: string, value: string): void {
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
    return;
  }
  if (!plugin.sync.validateContent) return;
  const error = plugin.sync.validateContent(task as Task, field, value);
  if (error) {
    log.task.info('content validation rejected', { source: task.source, field, taskId: (task as Task).id, error });
    throw new Error(error);
  }
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

/** Drop the cached whole-store snapshot. Called from withWriteLock.finally. */
function invalidateTaskStoreCache(): void {
  taskStoreCache = null;
}

/** Reset internal flags for test isolation (call in beforeEach). */
export function _resetForTesting(): void {
  initialized = false;
  taskStoreCache = null;
}

// ── Write lock: serializes all read-modify-write operations ──
// Two layers: in-process promise chain + cross-process file lock.
// The promise chain prevents concurrent async operations within the server.
// The file lock prevents races with hook child processes (on-stop, on-compact).
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  // Invalidate the whole-store read cache after EVERY locked mutation. All
  // writers — single-row, per-row fast paths (updateTaskRaw/*Bulk), and
  // writeStore — funnel through this lock, so this one hook keeps the cache
  // correct without enumerating writers.
  return prev
    .then(() => withFileLock(TASKS_FILE, fn))
    .finally(() => {
      invalidateTaskStoreCache();
      resolve!();
    });
}

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await initDirectories();
    // Open the SQLite handle (creates schema on first touch) and run the
    // one-shot JSON→SQLite migration if the DB is still empty. Both are
    // idempotent no-ops on subsequent calls.
    getDb();
    await runMigrationIfNeeded();
    await seedCategoriesFromConfig();
    initialized = true;
  }
}

/**
 * Idempotently seed task_categories rows that must exist:
 *   - 'Local' built-in for Quick Start (always seeded with source=local)
 *   - every category in config.local.categories (source=local)
 *   - every plugins.*.category reservation (source=<plugin id>)
 *   - every distinct category already present on existing tasks (source derived
 *     from that task's source) — keeps behavior of the old
 *     migrateToV3Categories intact for restores that dropped the categories
 *     table but kept task rows.
 *
 * Config / plugin reservations take precedence over task-derived sources; if
 * a category name is already in the table we leave it alone.
 */
async function seedCategoriesFromConfig(): Promise<void> {
  const db = getDb()!;
  const existingRows = db.prepare('SELECT name, source FROM task_categories').all() as
    { name: string; source: string }[];
  const existing = new Map<string, string>();
  for (const row of existingRows) existing.set(row.name.toLowerCase(), row.name);

  const config = await getConfig();
  const desired: Array<{ name: string; source: TaskSource }> = [];
  const seen = new Set<string>();
  const addIfNew = (name: string, source: TaskSource) => {
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (existing.has(key)) return;
    desired.push({ name, source });
  };

  addIfNew('Local', 'local');
  for (const cat of config.local?.categories ?? []) addIfNew(cat, 'local');
  const plugins = (config.plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, cfg] of Object.entries(plugins)) {
    const cat = (cfg as Record<string, unknown>).category;
    if (typeof cat === 'string' && cat) addIfNew(cat, pluginId as TaskSource);
  }

  // Task-derived categories: any distinct (category, source) pair on existing
  // tasks that isn't already registered. Matches the legacy V3 migration.
  const taskRows = db
    .prepare("SELECT DISTINCT category, source FROM tasks WHERE category IS NOT NULL AND category != ''")
    .all() as { category: string; source: string }[];
  for (const row of taskRows) {
    if (row.category.startsWith('.metadata')) continue;
    addIfNew(row.category, (row.source as TaskSource) ?? 'local');
  }

  if (desired.length === 0) return;
  const nextOrder = (db
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM task_categories')
    .get() as { next: number }).next;
  const stmt = db.prepare(
    'INSERT INTO task_categories (name, source, order_index) VALUES (?, ?, ?)'
  );
  let idx = nextOrder;
  for (const { name, source } of desired) {
    stmt.run(name, source, idx);
    idx += 1;
  }
  log.task.info('seeded task_categories', { added: desired.length });
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
// categories{}) so the helper functions below can keep using
// store.tasks.filter / store.categories without restructuring. Per-row hot
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
 * (shallow per task object + fresh array/categories) is far cheaper than the
 * `SELECT *` + per-row rowToTask JSON.parse this cache replaces.
 *
 * NOTE: the cache addresses the REPETITION of the scan, not the scan itself —
 * see the DESIGN DEBT note above for the proper per-call-site SQL-pushdown fix.
 */
async function readStore(): Promise<TaskStore> {
  await ensureInit();
  if (STORE_CACHE_ENABLED && taskStoreCache !== null) {
    return cloneTaskStore(taskStoreCache);
  }
  const db = getDb()!;
  const taskRows = db.prepare('SELECT * FROM tasks').all() as Record<string, any>[];
  const tasks = taskRows.map(rowToTask);

  const catRows = db
    .prepare('SELECT name, source FROM task_categories ORDER BY order_index ASC')
    .all() as { name: string; source: string }[];
  const categories: Record<string, CategoryRecord> = {};
  for (const row of catRows) {
    categories[row.name] = { source: row.source as CategoryRecord['source'] };
  }

  const groupRows = db
    .prepare('SELECT id, label FROM task_groups')
    .all() as { id: string; label: string }[];
  const taskGroups: Record<string, TaskGroupRecord> = {};
  for (const row of groupRows) {
    taskGroups[row.id] = { label: row.label };
  }

  const store: TaskStore = {
    tasks,
    ...(Object.keys(categories).length > 0 ? { categories } : {}),
    ...(Object.keys(taskGroups).length > 0 ? { task_groups: taskGroups } : {}),
  };
  if (STORE_CACHE_ENABLED) {
    taskStoreCache = store;
    return cloneTaskStore(store);
  }
  return store;
}

/**
 * Shallow-clone a TaskStore so callers can mutate freely without touching the
 * cached canonical copy. Each task is spread into a fresh object; the array and
 * categories map are rebuilt.
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
    ...(store.categories ? { categories: { ...store.categories } } : {}),
    ...(store.task_groups ? { task_groups: { ...store.task_groups } } : {}),
  };
}

/**
 * Replace the task + category tables with the full `store` snapshot.
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

  dbTransaction((handle) => {
    const existingIds = (handle.prepare('SELECT id FROM tasks').all() as { id: string }[])
      .map((r) => r.id);
    const newIds = new Set<string>();
    for (const t of store.tasks) {
      if (t && typeof t.id === 'string') newIds.add(t.id);
    }
    const toDelete = existingIds.filter((id) => !newIds.has(id));

    const deleteStmt = handle.prepare('DELETE FROM tasks WHERE id = ?');
    for (const id of toDelete) deleteStmt.run(id);

    const insertStmt = handle.prepare(insertSql);
    for (const task of store.tasks) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string') continue;
      const partial = taskToRow(task);
      const bound: Record<string, unknown> = {};
      for (const col of insertCols) {
        bound[col] = partial[col] === undefined ? null : partial[col];
      }
      insertStmt.run(bound);
    }

    handle.prepare('DELETE FROM task_categories').run();
    const catInsert = handle.prepare(
      'INSERT INTO task_categories (name, source, order_index) VALUES (@name, @source, @order_index)'
    );
    let idx = 0;
    for (const [name, rec] of Object.entries(store.categories ?? {})) {
      catInsert.run({ name, source: rec?.source ?? 'local', order_index: idx });
      idx += 1;
    }

    // Full-snapshot rewrite of the group-name registry (mirrors categories).
    // Membership lives on tasks.group_id; this table only holds labels.
    handle.prepare('DELETE FROM task_groups').run();
    const groupInsert = handle.prepare(
      'INSERT INTO task_groups (id, label) VALUES (@id, @label)'
    );
    for (const [id, rec] of Object.entries(store.task_groups ?? {})) {
      if (rec?.label) groupInsert.run({ id, label: rec.label });
    }
  });
}

export interface AddTaskInput {
  title: string;
  priority?: TaskPriority;
  category?: string;
  project?: string;
  due_date?: string;
  parent_task_id?: string;
  description?: string;
  tags?: string[];
  depends_on?: string[];
  cwd?: string;
  sprint?: string;
  /** Explicit source override. Only needed for the first task in a new category (e.g. source='local'). */
  source?: TaskSource;
  /** Don't block the return on the external sync push. The task is written locally and
   *  returned immediately; the push to the external target runs in the background and
   *  backfills ext/external_url/sync_error via a TASK_UPDATED event. Set by the web
   *  create path so the UI is instant. Programmatic callers that report syncResult
   *  (agent task_create, CLI) leave this off and keep synchronous semantics. */
  asyncPush?: boolean;
  /** Skip plugin content-validation & auto-push (fork children are internal). */
  _skipPluginOps?: boolean;
  /** Skip near-duplicate detection. Set by internal callers that legitimately
   * create rapid same-parent tasks (e.g. batch import). Normal agent task_create
   * leaves this off so the dedup safety net applies. */
  _skipDedup?: boolean;
}

// ── Near-duplicate task detection (fix #2: dedup safety net) ──
//
// Context: a blind-trimmed triage turn used to re-call task_create with a
// slightly-reworded title, spawning ~17 near-identical "CIS FE re-query …"
// tasks under the same parent within minutes. Fix #1 (read-only triage tools)
// removes the primary trigger; this is the defense-in-depth backstop so ANY
// caller that hammers task_create with a reworded title in a short window is
// collapsed onto the first task instead of breeding.

/** Window within which a same-parent, near-identical title is treated as a dup. */
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
/** Jaccard threshold on normalized title token sets (0..1). */
const DEDUP_TITLE_JACCARD = 0.8;
/** Minimum significant tokens before a title is distinctive enough to dedup on.
 * Below this, the signal is too weak (e.g. "Todo 1" / "Fix bug" normalize to a
 * single token and would false-match), so we never collapse such short titles. */
const DEDUP_MIN_TOKENS = 3;

/** Generic/boilerplate words that carry no identity — stripped before comparing
 * so "re-query plan first" vs "query plan" don't dilute the real signal. */
const DEDUP_TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'by',
  'plan', 'first', 'query', 're', 'requery', 'v2', 'task', 'please',
]);

/** Light stem: drop a trailing plural 's' so "account" and "accounts" match.
 * Keeps short tokens and "ss" endings (e.g. "access") intact. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Normalize a title to a set of significant lowercase word tokens (word order
 * insensitive). Splits on non-alphanumerics, drops stopwords and 1-char tokens,
 * and stems trailing plurals so singular/plural variants collapse together. */
function titleTokenSet(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !DEDUP_TITLE_STOPWORDS.has(t))
    .map(stem);
  return new Set(tokens);
}

/** Jaccard similarity of two token sets: |∩| / |∪|. Empty-vs-empty → 1. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Find an existing task that is a near-duplicate of a proposed new task:
 * same scope (same parent, or same category+project when both are top-level),
 * created within DEDUP_WINDOW_MS, and title token-set Jaccard ≥ threshold.
 * Returns the matched task, or undefined if none. Completed/terminal tasks are
 * ignored — re-creating after completion is intentional.
 */
function findNearDuplicate(
  tasks: Task[],
  proposed: { title: string; parentId?: string; category: string; project: string },
  nowMs: number,
): Task | undefined {
  const proposedTokens = titleTokenSet(proposed.title);
  // Too few distinctive tokens → unreliable, never dedup (avoids "Todo 1"/"Todo 2" false-match).
  if (proposedTokens.size < DEDUP_MIN_TOKENS) return undefined;
  for (const t of tasks) {
    // Only collapse onto a still-active task; a finished one (done / terminal phase)
    // re-created later is a deliberate new request, not breeding.
    if (t.status === 'done' || TERMINAL_PHASES.has(t.phase)) continue;
    // Same scope: prefer parent match; otherwise both must be top-level in the same list.
    const sameScope = proposed.parentId
      ? t.parent_task_id === proposed.parentId
      : !t.parent_task_id && t.category === proposed.category && t.project === proposed.project;
    if (!sameScope) continue;
    const createdMs = Date.parse(t.created_at ?? '');
    if (!Number.isFinite(createdMs) || nowMs - createdMs > DEDUP_WINDOW_MS) continue;
    const candidateTokens = titleTokenSet(t.title);
    if (candidateTokens.size < DEDUP_MIN_TOKENS) continue;
    if (jaccard(proposedTokens, candidateTokens) >= DEDUP_TITLE_JACCARD) return t;
  }
  return undefined;
}

/**
 * Build the MS To-Do list name from category and project fields.
 * "Work" + "HomeLab" → "Work / HomeLab"
 * If category === project (e.g. "Inbox"), returns just the category.
 */
export function buildListName(category: string, project: string): string {
  if (!category || !project || category === project) return category || project;
  return `${category} / ${project}`;
}

// ── Category as first-class entity ──

/**
 * Create a new category in store.categories.
 * Only 'local' and 'ms-todo' can be created explicitly.
 * Plugin-reserved categories are created by their respective sync configuration.
 */
export async function createCategory(name: string, source: TaskSource): Promise<{ name: string; source: TaskSource }> {
  if (!name || !name.trim()) throw new Error('Category name must be a non-empty string');

  return withWriteLock(async () => {
    const store = await readStore();
    const categories = store.categories ?? {};
    const nameLower = name.toLowerCase();

    // Case-insensitive uniqueness check
    const existing = Object.keys(categories).find(k => k.toLowerCase() === nameLower);
    if (existing) {
      throw new Error(`Category "${existing}" already exists (case-insensitive match for "${name}")`);
    }

    // Validate against config reservations
    const config = await getConfig();
    const validation = validateCategorySource(store.tasks, name, source, config);
    if (!validation.ok) {
      throw new CategorySourceConflictError(validation.error, name, source, validation.existingSource);
    }

    categories[name] = { source };
    store.categories = categories;
    await writeStore(store);

    bus.emit(EventNames.CATEGORY_CREATED, { name, source }, ['web-ui', 'main-agent'], { source: 'task-manager' });
    log.task.info('category created', { name, source });
    return { name, source };
  });
}

/**
 * Create a project within an existing category.
 * Category must exist in store.categories.
 */
export async function createProject(category: string, project: string): Promise<{ category: string; project: string; source: TaskSource }> {
  if (!category || !category.trim()) throw new Error('Category name must be a non-empty string');
  if (!project || !project.trim()) throw new Error('Project name must be a non-empty string');

  const store = await readStore();
  const categories = store.categories ?? {};
  const catLower = category.toLowerCase();
  const catKey = Object.keys(categories).find(k => k.toLowerCase() === catLower);
  if (!catKey) {
    throw new Error(`Category "${category}" does not exist. Create it first with task_create type=category.`);
  }

  const source = categories[catKey].source;

  // Create .metadata task for the project
  await setProjectMetadata(catKey, project, {});

  return { category: catKey, project, source };
}

/**
 * Get all categories from the store.
 * Returns store.categories or empty object if not yet migrated.
 */
export async function getStoreCategories(): Promise<Record<string, { source: TaskSource }>> {
  const store = await readStore();
  return store.categories ?? {};
}

/**
 * Update the source of an existing category.
 * Validates that no tasks in the category conflict with the new source.
 */
export async function updateCategorySource(name: string, source: TaskSource): Promise<{ name: string; source: TaskSource }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const categories = store.categories ?? {};
    const nameLower = name.toLowerCase();
    const catKey = Object.keys(categories).find(k => k.toLowerCase() === nameLower);
    if (!catKey) {
      throw new Error(`Category "${name}" does not exist`);
    }

    // Check no conflicting tasks
    const conflicting = store.tasks.find(
      t => t.category.toLowerCase() === nameLower && t.source !== source,
    );
    if (conflicting) {
      throw new CategorySourceConflictError(
        `Category "${name}" has ${conflicting.source} tasks. Cannot change source to ${source}.`,
        name, source, conflicting.source,
      );
    }

    categories[catKey] = { source };
    store.categories = categories;
    await writeStore(store);

    bus.emit(EventNames.CATEGORY_UPDATED, { name: catKey, source }, ['web-ui'], { source: 'task-manager' });
    log.task.info('category source updated', { name: catKey, source });
    return { name: catKey, source };
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
  // If the task's project/category changed (list changed), do a single push first
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
 * Compares the stored list_id in ext with the resolved list_id from current category/project.
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
  const { task, deduped } = await withWriteLock(async () => {
    const config = await getConfig();
    const store = await readStore();

    const now = new Date().toISOString();

    // If parent_task_id is set, inherit category/project/source from parent
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

    let category = input.category ?? parentTask?.category ?? config.defaults.category;
    let project = input.project ?? parentTask?.project;

    // Parse slash-separated "category / project" format
    if (category.includes(' / ')) {
      const parsed = parseGroupFromCategory(category);
      category = parsed.group;
      project = project ?? parsed.listName;
    }

    // Auto-determine source: parent → store.categories → existing tasks → input.source → ms-todo
    const catLower = category.toLowerCase();
    const storeCatKey = Object.keys(store.categories ?? {}).find(k => k.toLowerCase() === catLower);
    const storeCatSource: TaskSource | undefined = storeCatKey ? store.categories![storeCatKey].source : undefined;

    // Fallback: if store.categories doesn't have this category, check existing tasks
    const existingSource = storeCatSource == null
      ? store.tasks.find(t => t.category.toLowerCase() === catLower)?.source
      : undefined;

    const source: TaskSource = parentTask?.source
      ?? storeCatSource
      ?? existingSource
      ?? input.source
      ?? (await registry.getForCategory(category)).id;

    // Validate category-source consistency
    const validation = validateCategorySource(store.tasks, category, source, config, store.categories);
    if (!validation.ok) {
      throw new CategorySourceConflictError(validation.error, category, source, validation.existingSource);
    }

    // Fix #2 (dedup safety net): collapse a near-identical same-scope task created
    // in the last few minutes onto the existing one instead of breeding a duplicate.
    // Returns the existing task so callers stay idempotent (no new id, no sync push).
    if (!input._skipDedup) {
      const dup = findNearDuplicate(
        store.tasks,
        { title: input.title, parentId: parentTask?.id, category, project: project ?? category },
        Date.parse(now),
      );
      if (dup) {
        log.task.warn('task_create deduped: near-identical task created recently', {
          existingId: dup.id, existingTitle: dup.title, proposedTitle: input.title,
          parentTaskId: parentTask?.id, category, project: project ?? category,
        });
        return { task: dup, deduped: true }; // skip push/writeStore — return canonical task
      }
    }

    const newTask: Task = {
      id: generateId(),
      title: input.title,
      status: 'todo',
      phase: 'TODO',
      priority: sanitizePriority(input.priority ?? config.defaults.priority),
      category,
      project: project ?? category,
      source,
      session_ids: [],
      description: input.description ?? '',
      summary: '',
      note: '',
      created_at: now,
      updated_at: now,
      due_date: input.due_date,
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

    // Auto-ensure: if category is not in store.categories, add it
    if (!store.categories) store.categories = {};
    if (!storeCatKey) {
      store.categories[category] = { source };
    }

    await writeStore(store);

    return { task: newTask, deduped: false };
  });

  // Dedup hit: the returned task already exists and is already synced — skip the
  // push + re-read entirely so we stay idempotent and don't touch the sync target.
  if (deduped) {
    return { task, syncResult: { success: true } as SyncResult };
  }

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
  category?: string;
}

/**
 * List tasks, optionally filtered by status and/or category.
 */
export async function listTasks(filter: ListTasksFilter = {}): Promise<Task[]> {
  const store = await readStore();
  let tasks = store.tasks;

  if (filter.status) {
    tasks = tasks.filter((t) => t.status === filter.status);
  }
  if (filter.category) {
    tasks = tasks.filter((t) => t.category === filter.category);
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
    'id', 'title', 'category', 'project', 'status', 'phase', 'priority', 'source',
    'parent_task_id', 'due_date', 'created_at', 'updated_at', 'completed_at',
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
  if (filter.category) { where.push('category = @category'); params.category = filter.category; }
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
    return t;
  });

  // Sync push (outside lock). Failure propagates to caller — plugin tasks must
  // round-trip to the remote store, so a silent failure is worse than blocking.
  const syncResult = await autoPushIfConfigured(task);
  if (!syncResult.success) {
    throw new Error(`Sync to ${task.source} failed: ${syncResult.error ?? 'unknown error'}`);
  }
  autoCompleteTaskSessions(task);

  return { task };
}

/**
 * Toggle a task between todo and done states by partial ID match.
 */
export async function toggleComplete(idPrefix: string): Promise<{ task: Task }> {
  // Lock-internal: write local store. Push runs outside the lock to avoid
  // self-deadlock (autoPushIfConfigured re-acquires the same lock on plugin
  // not loaded → set sync_error).
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
    return t;
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
  return { task };
}

export interface UpdateTaskInput {
  title?: string;
  priority?: TaskPriority;
  category?: string;
  status?: TaskStatus;
  phase?: TaskPhase;
  due_date?: string;
  project?: string;
  starred?: boolean;
  needs_attention?: boolean;
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
 * Migrate a task (and same-source children) to a new source.
 * Called inside withWriteLock — mutates store in place (no writeStore call).
 * Returns the list of migrated tasks with their old state snapshots.
 */
function migrateTaskSource(
  store: TaskStore,
  task: Task,
  newCategory: string,
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
  task.category = newCategory;
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
    // Children keep their own category/project — only change source + ext
    child.ext = undefined;
    child.external_url = undefined;
    child.sync_error = undefined;
    child.updated_at = now;
    results.push({ task: child, oldSource, oldExt: childOldExt, oldTitle: childOldTitle });
  }

  // Update store.categories for the target category
  if (store.categories) {
    const catKey = Object.keys(store.categories).find(
      k => k.toLowerCase() === newCategory.toLowerCase(),
    );
    if (catKey) {
      store.categories[catKey] = { source: newSource };
    } else {
      store.categories[newCategory] = { source: newSource };
    }
  }

  return results;
}

/**
 * Update fields on a task by partial ID match.
 */
export async function updateTask(
  idPrefix: string,
  updates: UpdateTaskInput,
  eventOptions?: { source?: string; extraTargets?: string[]; ifPhase?: TaskPhase },
): Promise<{ task: Task }> {
  // Lock-internal phase: validate + mutate + persist. Returns enough state for
  // the post-lock push. Push runs OUTSIDE the lock because autoPushIfConfigured
  // re-acquires the lock when stamping sync_error → self-deadlock if held.
  const { task, migrationResult, parentChangeAction, cwdChanged, oldCwd } = await withWriteLock(async () => {
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
  let migrationResult: MigratedTask[] | undefined;

  if (updates.title !== undefined) {
    runPluginContentValidation(task, 'title', updates.title);
    task.title = updates.title;
  }
  if (updates.priority !== undefined) task.priority = sanitizePriority(updates.priority);
  if (updates.category !== undefined) {
    // Parse slash-separated "category / project" format once, reuse result
    const hasSlash = updates.category.includes(' / ') && updates.project === undefined;
    const parsed = hasSlash ? parseGroupFromCategory(updates.category) : undefined;
    const newCategoryName = parsed ? parsed.group : updates.category;
    const newProject = parsed ? parsed.listName : (updates.project ?? newCategoryName);
    let skipCategoryAssignment = false;

    // Validate category-source consistency when category is actually changing
    if (newCategoryName.toLowerCase() !== task.category.toLowerCase()) {
      const config = await getConfig();
      const validation = validateCategorySource(store.tasks, newCategoryName, task.source, config, store.categories);
      if (!validation.ok) {
        // Auto-migrate source: the task adopts the target category's source.
        // All conflict reasons (config_local, config_plugin, store_categories,
        // existing_tasks) are migratable — the target category's source is the
        // correct source for the task after the move.
        migrationResult = migrateTaskSource(store, task, newCategoryName, newProject, validation.existingSource);
        skipCategoryAssignment = true; // migrateTaskSource already set category/project
        log.task.info('cross-source migration triggered', {
          taskId: task.id, oldSource: migrationResult[0].oldSource,
          newSource: validation.existingSource, newCategory: newCategoryName,
          childrenMigrated: migrationResult.length - 1,
        });
      }
    }

    if (!skipCategoryAssignment) {
      if (parsed) {
        task.category = parsed.group;
        task.project = parsed.listName;
      } else {
        task.category = updates.category;
      }
    }
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
  if (updates.due_date !== undefined) task.due_date = updates.due_date;
  if (updates.project !== undefined) task.project = updates.project;
  if (updates.starred !== undefined) task.starred = updates.starred;
  if (updates.needs_attention !== undefined) task.needs_attention = updates.needs_attention;
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

  // `needs_attention` is a read/seen marker, not task content. Clearing it on
  // focus must NOT bump updated_at — otherwise the task jumps to the top of any
  // updated_at-ordered list a few seconds after the user merely selects it.
  const changedKeys = Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined);
  const onlyAttentionMarker = changedKeys.length > 0 && changedKeys.every((k) => k === 'needs_attention');
  if (!onlyAttentionMarker) task.updated_at = new Date().toISOString();

  await writeStore(store);

  return { task, migrationResult, parentChangeAction, cwdChanged, oldCwd };
  });

  // ── Post-lock phase: push to plugin (network I/O) + side effects ──
  // All operations below run OUTSIDE the write lock so re-entrant lock acquisitions
  // inside autoPushIfConfigured (e.g. sync_error stamping) don't self-deadlock.

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

/**
 * Append a ONE-LINE milestone to a task's compact milestone log by partial ID match.
 * Auto-prepends the same `### YYYY-MM-DD HH:MM` heading as conversation_log (via
 * logTimestampHeading) so the UI can reuse the same reverse/render helper.
 *
 * Unlike appendConversationLog this is LOCAL UI metadata: it runs no plugin content
 * validation and does not push to external sync — the self-report it's built from can
 * drift to CJK (see CLAUDE.md Opus note) and a milestone is a nice-to-have dashboard
 * line, not something worth failing a turn over. It DOES still throw on empty/no-match/
 * ambiguous input (programmer errors); the best-effort guarantee is the CALLER's job —
 * the sole caller (session-hooks/builtins.ts) wraps it in try/catch + debug-log, so a
 * bad milestone never breaks the flow. New callers must do the same.
 */
export async function appendMilestone(idPrefix: string, entry: string): Promise<{ task: Task }> {
  const oneLine = entry.replace(/\s+/g, ' ').trim();
  if (!oneLine) throw new Error('appendMilestone: empty entry');
  const task = await withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    if (matches.length > 1) throw new Error(`Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`);

    const t = matches[0];
    const now = new Date();
    const fullEntry = `${logTimestampHeading(now)}\n${oneLine}`;

    t.milestones = t.milestones ? t.milestones + '\n\n' + fullEntry : fullEntry;
    t.updated_at = now.toISOString();

    await writeStore(store);
    return t;
  });

  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'internal' });
  return { task };
}

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
 * Error thrown when a task's source conflicts with the target category's source.
 * e.g. trying to add an ms-todo task to a category that already has plugin-reserved tasks.
 */
export class CategorySourceConflictError extends Error {
  public readonly category: string;
  public readonly intendedSource: TaskSource;
  public readonly existingSource: TaskSource;
  constructor(message: string, category: string, intendedSource: TaskSource, existingSource: TaskSource) {
    super(message);
    this.name = 'CategorySourceConflictError';
    this.category = category;
    this.intendedSource = intendedSource;
    this.existingSource = existingSource;
  }
}

/**
 * Validate that a task's source is consistent with the target category.
 * Rules:
 * 1. If store.categories has an entry with a different source → conflict.
 * 2. If any existing task in the category has a different source → conflict.
 * 3. Config reservations (local.categories, plugins.*.category) checked for backward compat.
 * Returns { ok: true } or { ok: false, error, existingSource, reason }.
 * `reason` distinguishes hard config reservations from soft store/existing conflicts:
 *  - 'store_categories' / 'existing_tasks': migratable (task can switch source)
 *  - 'config_local' / 'config_plugin': hard reservation (task cannot move here)
 */
export type CategoryValidationReason = 'store_categories' | 'config_local' | 'config_plugin' | 'existing_tasks';

export function validateCategorySource(
  tasks: Task[],
  category: string,
  intendedSource: TaskSource,
  config: unknown,
  storeCategories?: Record<string, { source: TaskSource }>,
): { ok: true } | { ok: false; error: string; existingSource: TaskSource; reason: CategoryValidationReason } {
  const catLower = category.toLowerCase();
  const cfg = config as Record<string, unknown>;

  // Config reservations checked FIRST — these are hard blocks (user-explicit constraints)
  // that cannot be auto-migrated, and must take priority over store/existing-task conflicts.

  // Check config reservation: config.local.categories are reserved for local tasks only
  const localConfig = cfg.local as { categories?: string[] } | undefined;
  const localCategories = localConfig?.categories;
  if (localCategories?.some(c => c.toLowerCase() === catLower) && intendedSource !== 'local') {
    return {
      ok: false,
      error: `Category "${category}" is reserved for local tasks (config.local.categories). Only local tasks can use this category. Use a different category name for ${intendedSource} tasks.`,
      existingSource: 'local',
      reason: 'config_local',
    };
  }

  // Check plugin config reservations: plugins.*.category or legacy top-level keys
  const plugins = (cfg.plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, pluginCfg] of Object.entries(plugins)) {
    if (pluginId === intendedSource) continue;
    const reservedCat = pluginCfg.category as string | undefined;
    if (reservedCat && catLower === reservedCat.toLowerCase()) {
      return {
        ok: false,
        error: `Category "${category}" is reserved for ${pluginId} sync (plugins.${pluginId}.category). Only ${pluginId} tasks can use this category.`,
        existingSource: pluginId,
        reason: 'config_plugin',
      };
    }
  }

  // Soft conflicts below — these are migratable (updateTask auto-migrates source)

  // Check store.categories (source of truth for v3)
  if (storeCategories) {
    const storeCatKey = Object.keys(storeCategories).find(k => k.toLowerCase() === catLower);
    if (storeCatKey && storeCategories[storeCatKey].source !== intendedSource) {
      return {
        ok: false,
        error: `Category "${category}" is registered as ${storeCategories[storeCatKey].source}. Cannot add a ${intendedSource} task to it.`,
        existingSource: storeCategories[storeCatKey].source,
        reason: 'store_categories',
      };
    }
  }

  // Check existing tasks in the category — but only when store.categories doesn't already
  // confirm this category belongs to intendedSource. store.categories is the source of truth;
  // a few drifted tasks from sync pull (which bypasses validation) shouldn't block creation.
  const storeCatConfirmed = storeCategories && Object.keys(storeCategories).some(
    k => k.toLowerCase() === catLower && storeCategories[k].source === intendedSource,
  );
  if (!storeCatConfirmed) {
    const existing = tasks.find(
      (t) => t.category.toLowerCase() === catLower && t.source !== intendedSource,
    );
    if (existing) {
      return {
        ok: false,
        error: `Category "${category}" already contains ${existing.source} tasks. Cannot add a ${intendedSource} task to it. Use a different category name, or move existing tasks out first.`,
        existingSource: existing.source,
        reason: 'existing_tasks',
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
  // A virtual group needs ≥2 members; deleting one may leave a lone task — prune.
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

// ─────────────────────────────────────────────────────────────────────────────
// Virtual task groups (local-only)
//
// A "group" is a lightweight visual grouping: tasks sharing a `group_id` render
// boxed together in the list, ordered after the group's lead (top-sorted member).
// This is NOT a parent/subtask relationship — grouped tasks stay flat and fully
// independent (separate lifecycles, no inherited fields, never moved). All
// members must share the same category + project. The group_id lives on each
// task (round-trips via the SQLite payload blob); the human-readable name lives
// in store.task_groups. Nothing here is ever pushed to external sync backends.
//
// Invariant: a group has ≥2 members. Any op that would leave <2 members prunes
// the group (clears the lone member's group_id + drops the name registry entry).
// ─────────────────────────────────────────────────────────────────────────────

/** Error thrown when a grouping op violates the same-category+project invariant. */
export class TaskGroupScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskGroupScopeError';
  }
}

/**
 * In-place: if `groupId` has fewer than 2 live members, dissolve it — clear the
 * lone member's group_id and remove the name-registry entry. Mutates `store`.
 * Caller is responsible for writeStore(). Returns true if the group was pruned.
 */
function pruneVirtualGroup(store: TaskStore, groupId: string): boolean {
  const members = store.tasks.filter((t) => t.group_id === groupId);
  if (members.length >= 2) return false;
  for (const m of members) delete m.group_id;
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

/** Assert every task shares the same category + project (the group scope rule). */
function assertSameScope(tasks: Task[]): void {
  if (tasks.length < 2) return;
  const cat = tasks[0].category;
  const proj = tasks[0].project;
  for (const t of tasks) {
    if (t.category !== cat || t.project !== proj) {
      throw new TaskGroupScopeError(
        `All grouped tasks must share the same category + project. ` +
        `"${tasks[0].title}" is in ${cat}/${proj} but "${t.title}" is in ${t.category}/${t.project}.`,
      );
    }
  }
}

export interface GroupResult {
  group_id: string;
  label: string;
  member_ids: string[];
}

/**
 * Create a new virtual group from ≥2 tasks (by id or prefix). All must share the
 * same category + project. If any task is already in a group, its existing group
 * is merged in (all those members are absorbed into the new group). The label is
 * set synchronously to the provided value, or a placeholder (the lead task's
 * title) the caller can refine asynchronously via summarizeGroupLabel +
 * renameGroup (see the fork handler / the task_group agent tool). Returns the
 * new group id + member ids.
 */
export async function groupTasks(idPrefixes: string[], label?: string): Promise<GroupResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const seed = resolveTasksByPrefix(store, [...new Set(idPrefixes)]);
    if (seed.length < 2) throw new Error('A group needs at least 2 tasks.');
    assertSameScope(seed);

    // Absorb any pre-existing groups the seed tasks belong to (merge semantics).
    const absorbedGroupIds = new Set(seed.map((t) => t.group_id).filter(Boolean) as string[]);
    const memberSet = new Set(seed.map((t) => t.id));
    for (const t of store.tasks) {
      if (t.group_id && absorbedGroupIds.has(t.group_id)) memberSet.add(t.id);
    }
    const members = store.tasks.filter((t) => memberSet.has(t.id));
    assertSameScope(members); // absorbed members must also be in-scope

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
 * Add tasks to an existing group. All resulting members must share the same
 * category + project. No-op-safe: tasks already in the group are skipped.
 */
export async function addToGroup(groupId: string, idPrefixes: string[]): Promise<GroupResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const existing = store.tasks.filter((t) => t.group_id === groupId);
    if (existing.length === 0 && !store.task_groups?.[groupId]) {
      throw new Error(`Group "${groupId}" not found.`);
    }
    const toAdd = resolveTasksByPrefix(store, [...new Set(idPrefixes)]);
    assertSameScope([...existing, ...toAdd]);
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

/** List all groups with their labels and member ids (members with ≥1 task only). */
export async function listGroups(): Promise<Array<{ group_id: string; label: string; member_ids: string[] }>> {
  const store = await readStore();
  const byGroup = new Map<string, string[]>();
  for (const t of store.tasks) {
    if (t.group_id) {
      if (!byGroup.has(t.group_id)) byGroup.set(t.group_id, []);
      byGroup.get(t.group_id)!.push(t.id);
    }
  }
  const out: Array<{ group_id: string; label: string; member_ids: string[] }> = [];
  for (const [gid, ids] of byGroup) {
    const label = store.task_groups?.[gid]?.label ?? ids[0];
    out.push({ group_id: gid, label, member_ids: ids });
  }
  return out;
}

/**
 * Rename a category both locally and on the remote.
 * Updates all tasks with the old category and renames the remote lists.
 */
export async function renameCategory(
  oldCategory: string,
  newCategory: string,
): Promise<{ count: number }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const config = await getConfig();
  const now = new Date().toISOString();
  let count = 0;

  // Determine the source of tasks being renamed
  const tasksToRename = store.tasks.filter(
    (t) => t.category.toLowerCase() === oldCategory.toLowerCase(),
  );

  // Allow renaming empty categories if they exist in store.categories
  const oldCatStoreKey = Object.keys(store.categories ?? {}).find(
    k => k.toLowerCase() === oldCategory.toLowerCase(),
  );
  if (tasksToRename.length === 0 && !oldCatStoreKey) {
    throw new Error(`No tasks found with category "${oldCategory}"`);
  }

  // Verify all tasks in the category share the same source
  const renameSource = tasksToRename.length > 0
    ? tasksToRename[0].source
    : (oldCatStoreKey ? store.categories![oldCatStoreKey].source : 'ms-todo');
  const mixedSource = tasksToRename.find((t) => t.source !== renameSource);
  if (mixedSource) {
    throw new Error(
      `Category "${oldCategory}" has mixed sources (${renameSource} and ${mixedSource.source}). Clean up the category before renaming.`,
    );
  }

  // Check 1: target category name is reserved by a plugin config
  const pluginsConfig = ((config as unknown as Record<string, unknown>).plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, pluginCfg] of Object.entries(pluginsConfig)) {
    if (pluginId === renameSource) continue;
    const reservedCat = pluginCfg.category as string | undefined;
    if (reservedCat && newCategory.toLowerCase() === reservedCat.toLowerCase()) {
      throw new CategorySourceConflictError(
        `Cannot rename to "${newCategory}" — it is configured as the ${pluginId} sync category. Only ${pluginId} tasks can use this category name.`,
        newCategory,
        renameSource,
        pluginId,
      );
    }
  }
  // Check 2: target category in store.categories has a different source
  if (store.categories) {
    const targetCatKey = Object.keys(store.categories).find(
      k => k.toLowerCase() === newCategory.toLowerCase() && k.toLowerCase() !== oldCategory.toLowerCase(),
    );
    if (targetCatKey && store.categories[targetCatKey].source !== renameSource) {
      throw new CategorySourceConflictError(
        `Cannot rename "${oldCategory}" to "${newCategory}" — category "${newCategory}" is registered as ${store.categories[targetCatKey].source} but "${oldCategory}" tasks sync to ${renameSource}. Choose a different target name.`,
        newCategory,
        renameSource,
        store.categories[targetCatKey].source,
      );
    }
  }

  // Check 3: target category already has tasks with a different source
  const targetConflict = store.tasks.find(
    (t) =>
      t.category.toLowerCase() === newCategory.toLowerCase() &&
      t.category.toLowerCase() !== oldCategory.toLowerCase() &&
      t.source !== renameSource,
  );
  if (targetConflict) {
    throw new CategorySourceConflictError(
      `Cannot rename "${oldCategory}" to "${newCategory}" — category "${newCategory}" already has ${targetConflict.source} tasks but "${oldCategory}" tasks sync to ${renameSource}. Choose a different target name.`,
      newCategory,
      renameSource,
      targetConflict.source,
    );
  }

  // Collect old list names for remote rename
  const oldListNames = new Set<string>();

  for (const task of store.tasks) {
    if (task.category.toLowerCase() === oldCategory.toLowerCase()) {
      const oldListName = buildListName(task.category, task.project);
      oldListNames.add(oldListName);
      task.category = newCategory;
      task.updated_at = now;
      count++;
    }
  }

  // Update store.categories: move old entry to new name
  if (store.categories) {
    const oldCatKey = Object.keys(store.categories).find(
      k => k.toLowerCase() === oldCategory.toLowerCase(),
    );
    if (oldCatKey) {
      const entry = store.categories[oldCatKey];
      delete store.categories[oldCatKey];
      store.categories[newCategory] = entry;
    }
  }

  await writeStore(store);

  // Update config.local.categories when renaming a local category
  if (renameSource === 'local') {
    const localCats = config.local?.categories;
    if (localCats?.some(c => c.toLowerCase() === oldCategory.toLowerCase())) {
      const freshConfig = await getConfig();
      if (freshConfig.local?.categories) {
        freshConfig.local.categories = freshConfig.local.categories
          .filter(c => c.toLowerCase() !== oldCategory.toLowerCase());
        if (!freshConfig.local.categories.some(c => c.toLowerCase() === newCategory.toLowerCase())) {
          freshConfig.local.categories.push(newCategory);
        }
        await updateConfig({ local: freshConfig.local });
      }
    }
  }

  // Fire-and-forget: notify plugin about category change for each renamed task
  if (renameSource !== 'local') {
    const renamedTasks = store.tasks.filter(t => t.category === newCategory);
    for (const task of renamedTasks) {
      pushToPlugin(task, 'updateCategory', newCategory, task.project).catch(() => {
        // Silent — local rename succeeded, remote rename is best-effort
      });
    }
  }

  return { count };
  });
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
 * Whether chatting with a pinned task in the given tier should bump it to the
 * front of that tier. Per-tier configurable via ui.bump_tiers.
 * Defaults when unset: focus=false (keep the hand-ordered current sprint),
 * satellite/wait=true.
 */
function isBumpEnabledForTier(
  config: { ui?: { bump_tiers?: { focus?: boolean; satellite?: boolean; wait?: boolean } } },
  tier: 'focus' | 'satellite' | 'wait',
): boolean {
  const configured = config.ui?.bump_tiers?.[tier];
  if (configured !== undefined) return configured;
  return tier !== 'focus'; // default: focus off, others on
}

/**
 * Move a pinned task to the front of its own tier by reassigning pin_order.
 * Tiers are derived by filtering pinned tasks on focus_tier, so only the target
 * task's own tier reorders — other tiers keep their relative order untouched.
 * Returns true if the order actually changed.
 */
function bumpPinnedTaskWithinTier(store: TaskStore, task: Task): boolean {
  const tierOf = (t: Task) => t.focus_tier ?? 'satellite';
  const targetTier = tierOf(task);
  const ordered = store.tasks
    .filter((t) => t.pinned && t.phase !== 'COMPLETE' && t.status !== 'done')
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
  const firstIdx = ordered.findIndex((t) => tierOf(t) === targetTier);
  if (firstIdx < 0 || ordered[firstIdx].id === task.id) return false; // already at tier front
  const curIdx = ordered.findIndex((t) => t.id === task.id);
  if (curIdx < 0) return false;
  const [moved] = ordered.splice(curIdx, 1);
  ordered.splice(firstIdx, 0, moved);
  ordered.forEach((t, i) => { t.pin_order = i; });
  return true;
}

/**
 * Lightweight touch: update last_session_update without full updateTask() validation.
 * Used on session resume (handleSend) to keep "Recent" sort accurate.
 * If the task is pinned, also bump it to the front of its tier so chatting with
 * a task surfaces it in the Focus bar.
 */
export async function touchLastSessionUpdate(taskIdPrefix: string): Promise<void> {
  return withWriteLock(async () => {
    const store = await readStore();
    const task = store.tasks.find((t) => t.id.startsWith(taskIdPrefix));
    if (!task) return;
    task.last_session_update = new Date().toISOString();
    // Per-tier opt-out: chatting bumps a pinned task to the front of its tier,
    // configurable per tier. Defaults preserve the manually ordered current sprint
    // (focus=false) while surfacing recent activity in the other tiers.
    const config = await getConfig();
    const focusBarChanged = task.pinned && isBumpEnabledForTier(config, task.focus_tier ?? 'satellite')
      ? bumpPinnedTaskWithinTier(store, task)
      : false;
    await writeStore(store);
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-touch' });
    if (focusBarChanged) {
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui']);
    }
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
 * Parse YAML description from a metadata task. Returns null on failure.
 */
function parseMetadataYaml(task: Task): Record<string, unknown> | null {
  if (!task.description) return null;
  try {
    const parsed = yaml.load(task.description);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    log.task.warn('failed to parse metadata YAML description', {
      taskId: task.id,
      title: task.title,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Get merged metadata for a project.
 * Resolution chain: .metadata_project (project-level) → .metadata_category (category-level) → null
 * Project-level settings override category-level settings.
 */
export async function getProjectMetadata(category: string, project: string): Promise<{
  default_host?: string;
  default_cwd?: string;
  [key: string]: unknown;
} | null> {
  const store = await readStore();
  const catLower = category.toLowerCase();

  // Category-level: title='.metadata_category', project='.metadata_category', same category
  const categoryMeta = store.tasks.find(
    (t) =>
      t.title === '.metadata_category' &&
      t.project === '.metadata_category' &&
      t.category.toLowerCase() === catLower,
  );

  // Project-level: title='.metadata_project', specific project, same category
  const projectMeta = store.tasks.find(
    (t) =>
      t.title === '.metadata_project' &&
      t.category.toLowerCase() === catLower &&
      t.project.toLowerCase() === project.toLowerCase(),
  );

  const catSettings = categoryMeta ? parseMetadataYaml(categoryMeta) : null;
  const projSettings = projectMeta ? parseMetadataYaml(projectMeta) : null;

  if (!catSettings && !projSettings) return null;

  // Merge: category defaults, then project overrides
  return { ...(catSettings ?? {}), ...(projSettings ?? {}) } as {
    default_host?: string;
    default_cwd?: string;
    [key: string]: unknown;
  };
}

/**
 * Create or update metadata at category or project level.
 * - level='category': creates/updates .metadata_category task (project='.metadata_category')
 * - level='project': creates/updates .metadata_project task in the specific project
 * Merges provided settings into existing YAML description (or creates the task).
 * Returns the merged settings object.
 */
export async function setProjectMetadata(
  category: string,
  project: string,
  settings: Record<string, unknown>,
  level: 'category' | 'project' = 'project',
): Promise<Record<string, unknown>> {
  const metaTitle = level === 'category' ? '.metadata_category' : '.metadata_project';
  const metaProject = level === 'category' ? '.metadata_category' : project;

  return withWriteLock(async () => {
    const store = await readStore();
    const metaTask = store.tasks.find(
      (t) =>
        t.title === metaTitle &&
        t.category.toLowerCase() === category.toLowerCase() &&
        t.project.toLowerCase() === metaProject.toLowerCase(),
    );

    if (metaTask) {
      // Parse existing YAML and merge
      const existing = parseMetadataYaml(metaTask) ?? {};
      const merged = { ...existing, ...settings };
      metaTask.description = yaml.dump(merged).trim();
      metaTask.updated_at = new Date().toISOString();
      await writeStore(store);
      return merged;
    }

    // Create new metadata task — resolve source from store.categories first, then registry fallback
    const now = new Date().toISOString();
    const catLower = category.toLowerCase();
    const storeCatKey = Object.keys(store.categories ?? {}).find(k => k.toLowerCase() === catLower);
    const source: TaskSource = storeCatKey
      ? store.categories![storeCatKey].source
      : (await registry.getForCategory(category)).id;

    const newTask: Task = {
      id: generateId(),
      title: metaTitle,
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      category,
      project: metaProject,
      source,
      session_ids: [],
      description: yaml.dump(settings).trim(),
      summary: '',
      note: '',
      created_at: now,
      updated_at: now,
    };
    store.tasks.push(newTask);
    await writeStore(store);
    return { ...settings };
  });
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
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
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
 */
export async function reorderPins(orderedIds: string[]): Promise<string[]> {
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
    const ordered = store.tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    return ordered.map((t) => t.id);
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

// Focus tiers: focus (current sprint) → satellite (backlog) → wait (parked).
// No cap — users decide how many tasks per tier.
type FocusTier = 'focus' | 'satellite' | 'wait';

export interface TierResult {
  pinned_tasks: string[];
  focus_tasks: string[];
  satellite_tasks: string[];
  wait_tasks: string[];
}

/** Helper: split pinned tasks into tier arrays (includes pinned_tasks for full state sync). */
function splitTiers(store: TaskStore): TierResult {
  const pinned = store.tasks
    .filter((t) => t.pinned && t.phase !== 'COMPLETE' && t.status !== 'done')
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
  return {
    pinned_tasks: pinned.map((t) => t.id),
    focus_tasks: pinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id),
    // Satellite is the default tier: anything not focus and not wait (incl. the
    // retired 'next' value on legacy tasks) falls here.
    satellite_tasks: pinned.filter((t) => t.focus_tier !== 'focus' && t.focus_tier !== 'wait').map((t) => t.id),
    wait_tasks: pinned.filter((t) => t.focus_tier === 'wait').map((t) => t.id),
  };
}

/**
 * Set the focus tier for a pinned task.
 * 'focus' = current sprint, 'satellite' = backlog, 'wait' = parked.
 */
export async function setFocusTier(taskId: string, tier: FocusTier): Promise<TierResult> {
  return withWriteLock(async () => {
    const store = await readStore();
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.pinned) throw new Error(`Task is not pinned: ${task.title}`);

    if (tier === 'focus' || tier === 'wait') {
      task.focus_tier = tier;
    } else {
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
 * Reorder tasks within a category/project group.
 * `orderedIds` must contain exactly the IDs of all tasks matching the group.
 * Tasks are rearranged in-place at their original index slots in the store array.
 */
export async function reorderTasks(
  category: string,
  project: string,
  orderedIds: string[],
): Promise<void> {
  return withWriteLock(async () => {
  const store = await readStore();

  // Find tasks belonging to this group, preserving their store indices.
  // Exclude .metadata tasks — they are internal bookkeeping and should not
  // participate in user-facing reorder operations. The frontend never sees
  // them (filtered out by GET /api/tasks), so orderedIds will never contain them.
  const groupEntries: { index: number; task: Task }[] = [];
  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    if (t.category === category && t.project === project && !t.title.startsWith('.metadata')) {
      groupEntries.push({ index: i, task: t });
    }
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
      category, project, reconciledCount: reconciledIds.length, groupCount: groupEntries.length,
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
      existing.title = taskData.title;
      if (taskData.phase) {
        applyPhase(existing, taskData.phase);
      } else if (taskData.status) {
        applyPhase(existing, phaseFromStatus(taskData.status));
      }
      existing.priority = sanitizePriority(taskData.priority);
      existing.category = taskData.category;
      existing.project = taskData.project;
      existing.ext = { ...existing.ext, ...taskData.ext };
      if (taskData.due_date !== undefined) existing.due_date = taskData.due_date;
      if (taskData.completed_at !== undefined) existing.completed_at = taskData.completed_at;
      if (taskData.external_url) existing.external_url = taskData.external_url;
      existing.updated_at = taskData.updated_at ?? new Date().toISOString();
      await writeStore(store);
      return existing;
    }
  }

  // Race-condition guard: title + category + project + source match → update ext
  if (taskData.ext && Object.keys(taskData.ext).length > 0) {
    const dup = store.tasks.find((t) =>
      t.source === taskData.source &&
      t.title === taskData.title &&
      t.category === taskData.category &&
      t.project === taskData.project,
    );
    if (dup) {
      dup.ext = { ...dup.ext, ...taskData.ext };
      if (taskData.external_url) dup.external_url = taskData.external_url;
      dup.updated_at = taskData.updated_at ?? new Date().toISOString();
      await writeStore(store);
      return dup;
    }
  }

  // Guard: reject new tasks whose source conflicts with store.categories registration.
  // This prevents sync pull from different plugins creating tasks in categories
  // owned by another source (e.g. ms-todo tasks landing in a plugin-reserved category).
  if (store.categories && taskData.category) {
    const catKey = Object.keys(store.categories).find(
      k => k.toLowerCase() === taskData.category.toLowerCase(),
    );
    if (catKey && store.categories[catKey].source !== taskData.source) {
      throw new Error(
        `addTaskFull: category "${taskData.category}" is registered as ${store.categories[catKey].source}, ` +
        `refusing to create ${taskData.source} task "${taskData.title}" in it`,
      );
    }
  }

  const task: Task = {
    id: generateId(),
    ...taskData,
    priority: sanitizePriority(taskData.priority),
  };

  store.tasks.push(task);
  await writeStore(store);
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
  const updated = await withWriteLock(async () => {
    const db = getDb()!;
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    const task = rowToTask(row);

    const prepared = prepareRawUpdate(task, updates);
    if (!prepared) return undefined;

    // Build the UPDATE dynamically from the fields that actually changed.
    // taskToRow() already handles column mapping + JSON encoding + payload spill.
    const patchRow = taskToRow(prepared);
    // payload is a SINGLE column holding ALL non-column fields (group_id,
    // needs_attention, …). taskToRow(prepared) rebuilds it from the PATCH alone,
    // so a patch that touches any payload field (e.g. session phase transitions
    // set needs_attention) would overwrite the whole column and silently drop
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
    // Return the merged post-update task so callers can emit / push without re-reading.
    Object.assign(task, prepared);
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
  }

  return { changed: true, task: updated };
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
        changedTasks.push(task);
      }
    });
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
 * (category conflict, parent lookup, plugin content validation). Callers that
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
