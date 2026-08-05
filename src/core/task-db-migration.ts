/**
 * task-db-migration.ts — one-shot migration from tasks.json → tasks.sqlite.
 *
 * Called once at startup when the SQLite task store is empty and a legacy
 * tasks.json exists. Reads the JSON blob, INSERTs every task row + project
 * registry row in a single transaction, then stamps a backup file so the
 * original JSON can never be clobbered without a copy sitting next to it.
 *
 * Idempotency: the function bails out cheaply on every subsequent call by
 * checking the `tasks` row count. Safe to invoke from module init.
 *
 * Migration completeness: tasks.json on disk is assumed to already be
 * post-migration (the live task-manager readStore → writeStore cycle has
 * been running in-place migrations for every existing deploy). So this
 * module does NOT re-run the legacy migrate* chain from task-manager.ts.
 * For the one-off JSON→SQLite cutover, the data is already normalized.
 *
 * Category removal (v5) parity: this path applies the SAME rules as the SQLite
 * v4→v5 branch, via the helpers exported from task-db.ts —
 *   - project name          → `promoteLegacyGroup` (+ case-insensitive merge onto
 *                             the spelling that owns the most tasks)
 *   - provider claim        → `pickMajoritySource` (majority by task count)
 *   - remote_list alias     → `legacyListName` for the ms-todo group that owns
 *                             the most of the project's tasks
 *   - task source           → normalized onto the winning registry claim, with
 *                             `ext`/`external_url`/`sync_error` cleared; Inbox is
 *                             forced local (Inbox can never be claimed)
 *   - `.metadata*` sentinels→ absorbed into registry metadata, never imported
 * Deliberate DIFFERENCES (both are JSON-shape artifacts, not rule changes):
 *   - order_index is alphabetical by project name; the SQLite path can expand the
 *     old `task_categories.order_index`, which tasks.json never carried.
 *   - weights count TASKS directly (the SQLite path groups first, then sums group
 *     counts) — same number, different arithmetic path.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { TASKS_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import { readJsonFile } from '../utils/fs.js';
import {
  getDb,
  taskToRow,
  TASK_COLUMNS,
  transaction,
  promoteLegacyGroup,
  pickMajoritySource,
  legacyListName,
} from './task-db.js';
import type { Task, TaskStore } from './types.js';

/** A legacy tasks.json task still carries the retired `category` field. */
type LegacyTask = Task & { category?: string };

export interface MigrationResult {
  /** true only on the run that actually copied rows in. Subsequent runs return false. */
  migrated: boolean;
  /** Number of task rows the function is responsible for on return. On a no-op
   *  (already migrated / fallback mode / no JSON) this is the row count it
   *  observed, which may be 0 or the pre-existing row count. */
  count: number;
}

/**
 * Run the one-shot JSON→SQLite migration if needed.
 *
 * Returns `{migrated: false, count: N}` in three cases:
 *   1. SQLite handle failed to open — skip, will retry on next startup.
 *   2. `tasks` table already has rows — idempotent no-op.
 *   3. tasks.json doesn't exist — fresh install, nothing to import.
 *
 * Returns `{migrated: true, count: N}` after a successful import.
 */
export async function runMigrationIfNeeded(): Promise<MigrationResult> {
  const db = getDb();
  if (!db) {
    return { migrated: false, count: 0 };
  }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  if (existing.n > 0) {
    return { migrated: false, count: existing.n };
  }

  if (!fs.existsSync(TASKS_FILE)) {
    return { migrated: false, count: 0 };
  }

  // readJsonFile throws on corrupt content rather than silently returning the
  // fallback — we let that propagate so a bad tasks.json aborts startup
  // instead of silently creating an empty DB.
  const store = await readJsonFile<TaskStore>(TASKS_FILE, { version: 1, tasks: [] });

  const rawTasks: LegacyTask[] = Array.isArray(store.tasks) ? (store.tasks as LegacyTask[]) : [];
  // Legacy JSON may carry a `categories` registry (pre-project-only model). It
  // only survives as the source hint for the project rows we derive below.
  const legacyCategories = (store as { categories?: Record<string, { source?: string }> }).categories ?? {};

  // Sentinel metadata tasks are not real tasks — their YAML body becomes the
  // project registry row's metadata (the .metadata_* pipeline is retired).
  const tasks = rawTasks.filter(
    (t) => t?.title !== '.metadata_project' && t?.title !== '.metadata_category',
  );
  const sentinels = rawTasks.filter(
    (t) => t?.title === '.metadata_project' || t?.title === '.metadata_category',
  );

  // Legacy (category, project) → project name, then case-insensitive merge onto
  // the spelling that owns the most tasks (ties alphabetical) — same rule as the
  // SQLite v4→v5 migration. Both paths share promoteLegacyGroup,
  // pickMajoritySource, and legacyListName so they can't diverge on the data they
  // produce (project names, claim per project, remote_list alias).
  const targetOf = (t: LegacyTask): string =>
    promoteLegacyGroup(t.category ?? '', t.project ?? '');
  const spellingCounts = new Map<string, Map<string, number>>();
  for (const t of tasks) {
    const target = targetOf(t);
    if (!target) continue;
    const lower = target.toLowerCase();
    const bucket = spellingCounts.get(lower) ?? new Map<string, number>();
    bucket.set(target, (bucket.get(target) ?? 0) + 1);
    spellingCounts.set(lower, bucket);
  }
  const canonical = new Map<string, string>();
  for (const [lower, bucket] of spellingCounts) {
    canonical.set(
      lower,
      [...bucket.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0],
    );
  }
  const finalProjectOf = (t: LegacyTask): string => {
    const target = targetOf(t);
    return target ? (canonical.get(target.toLowerCase()) ?? target) : '';
  };

  // Project registry rows: claim inherited majority-weighted from the contributing
  // categories, legacy category kept for the record, sentinel YAML folded into
  // metadata, remote_list alias pre-seeded for ms-todo.
  interface ProjectRow {
    name: string;
    source: string;
    metadata: Record<string, unknown>;
    /** provider id → task count, for pickMajoritySource. */
    weights: Map<string, number>;
    /** provider-owned legacy (category, project) groups → task count. Feeds the
     *  remote_list alias pick. Keyed by lowercased pair; the original spelling
     *  rides along in the value because the alias must match the remote list. */
    ownedGroups: Map<string, { category: string; project: string; count: number }>;
  }
  const projectRows = new Map<string, ProjectRow>(); // keyed by lower(name)
  const categorySource = (category: string): string => {
    const key = Object.keys(legacyCategories).find((k) => k.toLowerCase() === category.trim().toLowerCase());
    return key ? String(legacyCategories[key]?.source ?? 'local') : 'local';
  };
  for (const t of tasks) {
    const name = finalProjectOf(t);
    if (!name) continue;
    const row: ProjectRow = projectRows.get(name.toLowerCase())
      ?? { name, source: 'local', metadata: {}, weights: new Map(), ownedGroups: new Map() };
    const legacyCat = (t.category ?? '').trim();
    const src = categorySource(legacyCat);
    if (src !== 'local') {
      row.weights.set(src, (row.weights.get(src) ?? 0) + 1);
      const legacyProj = (t.project ?? '').trim();
      const groupKey = `${legacyCat.toLowerCase()}/${legacyProj.toLowerCase()}`;
      const group = row.ownedGroups.get(groupKey)
        ?? { category: legacyCat, project: legacyProj, count: 0 };
      group.count += 1;
      row.ownedGroups.set(groupKey, group);
    }
    if (legacyCat) {
      const existing = row.metadata.legacy_category;
      if (existing === undefined) row.metadata.legacy_category = legacyCat;
      else if (Array.isArray(existing)) {
        if (!existing.includes(legacyCat)) existing.push(legacyCat);
      } else if (existing !== legacyCat) {
        row.metadata.legacy_category = [existing as string, legacyCat].sort();
      }
    }
    projectRows.set(name.toLowerCase(), row);
  }
  for (const row of projectRows.values()) {
    row.source = pickMajoritySource(row.weights, row.name);
    // remote_list alias: keep pushing into the MS To-Do list the account already
    // has ("Cat / Proj") instead of forking a new one named after the project.
    // Only ms-todo encodes the grouping into the remote list name.
    if (row.source !== 'ms-todo') continue;
    const owned = [...row.ownedGroups.values()]
      .filter((g) => categorySource(g.category) === 'ms-todo')
      .sort((a, b) => b.count - a.count || (a.project < b.project ? -1 : 1));
    const pick = owned[0];
    if (!pick) continue;
    const oldList = legacyListName(pick.category, pick.project);
    if (oldList && oldList.toLowerCase() !== row.name.toLowerCase()) {
      row.metadata.remote_list = oldList;
    }
    if (owned.length > 1) {
      log.task.warn('task-db migration: ambiguous remote list for merged project', {
        project: row.name, picked: oldList, candidates: owned.length,
      });
    }
  }
  for (const sentinel of sentinels) {
    const name = finalProjectOf(sentinel);
    if (!name) continue;
    const row = projectRows.get(name.toLowerCase());
    if (!row) continue;
    let settings: unknown;
    try { settings = yaml.load(sentinel.description ?? ''); } catch { settings = null; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
    // Project-level sentinel wins over category-level (old resolution chain).
    const overwrite = sentinel.title === '.metadata_project';
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (overwrite || !(key in row.metadata)) row.metadata[key] = value;
    }
  }

  // Prepared INSERT for `tasks`. Built from TASK_COLUMNS so the column list
  // here and the one in task-db.ts can never drift. `payload` is appended
  // explicitly because it's not in TASK_COLUMNS (it's the spillover column).
  const taskInsertCols = [...TASK_COLUMNS, 'payload'];
  const taskInsertSql =
    'INSERT INTO tasks (' + taskInsertCols.join(', ') + ') ' +
    'VALUES (' + taskInsertCols.map((c) => '@' + c).join(', ') + ')';

  const projectInsertSql =
    'INSERT INTO task_projects (name, source, order_index, metadata) ' +
    'VALUES (@name, @source, @order_index, @metadata) ON CONFLICT(name) DO NOTHING';

  /** Tasks whose source the registry claim overrode — logged after the tx. */
  const sourceNormalized: Array<{ id: string; from: string; to: string; project: string }> = [];

  transaction((h) => {
    const insertTask = h.prepare(taskInsertSql);
    const insertProject = h.prepare(projectInsertSql);

    // Projects first (no FK today but the logical order still matters for
    // any future constraints / observers).
    [...projectRows.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .forEach((row, index) => {
        insertProject.run({
          name: row.name,
          source: row.source,
          order_index: index,
          metadata: Object.keys(row.metadata).length > 0 ? JSON.stringify(row.metadata) : null,
        });
      });

    // Tasks. taskToRow emits only the keys the task actually carries; we pad
    // the missing columns with null so the prepared statement's named-binding
    // contract is satisfied (better-sqlite3 throws on unbound @params).
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
        log.task.warn('task-db migration: skipping malformed task', {
          sample: String((task as { id?: unknown })?.id ?? '<no id>'),
        });
        continue;
      }
      // Sentinel rows never become tasks (they were filtered above), and the
      // whole `.metadata*` namespace stays uncreatable — mirrors addTaskFull.
      if (task.title?.trim().startsWith('.metadata')) continue;
      // Strip the retired field so it can't spill into the payload blob.
      const { category: _legacyCategory, ...rest } = task;
      const project = finalProjectOf(task);
      // Source normalization, identical to the v4→v5 SQLite path: the registry
      // row carries ONE claim and pushTask hard-refuses a task whose project
      // names a different source, so a minority-source task would be permanently
      // unpushable. Inbox ('') is structurally local-only. Both cases adopt the
      // authoritative source and drop the stale remote identity so the next sync
      // tick re-creates a twin in the right place.
      const registryRow = project ? projectRows.get(project.toLowerCase()) : undefined;
      const authoritativeSource = project ? (registryRow?.source ?? task.source) : 'local';
      const normalized: Partial<Task> = {};
      if (task.source !== authoritativeSource) {
        normalized.source = authoritativeSource as Task['source'];
        normalized.ext = undefined;
        normalized.external_url = undefined;
        normalized.sync_error = undefined;
        sourceNormalized.push({ id: task.id, from: task.source, to: authoritativeSource, project });
      }
      const partial = taskToRow({ ...(rest as Task), project, ...normalized });
      // taskToRow omits `undefined`, so an explicit clear needs an explicit null.
      if (normalized.source !== undefined) partial.ext = null;
      const bound: Record<string, unknown> = {};
      for (const col of taskInsertCols) {
        bound[col] = partial[col] === undefined ? null : partial[col];
      }
      try {
        insertTask.run(bound);
      } catch (err) {
        // One bad row shouldn't abort the whole migration — log and continue.
        // User still has the pristine tasks.json (plus the backup below) for
        // manual recovery if something important was dropped.
        log.task.warn('task-db migration: failed to insert task, skipping', {
          id: task.id,
          err: String(err),
        });
      }
    }
  });

  if (sourceNormalized.length > 0) {
    log.task.warn('task-db migration: normalized task sources onto the project claim', {
      tasks: sourceNormalized.length,
      sample: sourceNormalized.slice(0, 20),
    });
  }

  const after = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  const count = after.n;

  // Copy the source blob aside so operators / future migrations have a
  // known-good snapshot even after we start mutating the SQLite file. A
  // failure here isn't fatal — the JSON itself still exists untouched.
  const backupPath = path.join(path.dirname(TASKS_FILE), 'tasks.json.migrated-from-json.backup');
  try {
    fs.copyFileSync(TASKS_FILE, backupPath);
  } catch (err) {
    log.task.warn('task-db migration: backup copy failed (non-fatal)', {
      path: backupPath,
      err: String(err),
    });
  }

  log.task.info('task-db: migrated tasks from tasks.json', {
    count,
    projectCount: projectRows.size,
  });

  return { migrated: true, count };
}
