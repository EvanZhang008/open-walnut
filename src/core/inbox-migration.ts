/**
 * The boot migration that makes the Inbox a real project (inbox-project.ts).
 *
 * Runs on every open of the primary's task store and is a no-op once done:
 *   1. the registry row `Inbox` (local, never claimed) exists, and no tombstone holds the name;
 *      a project the user already had under that name is kept: a local one is the Inbox now
 *      (respelled `Inbox`, its tasks and settings with it), one a sync service claimed is renamed
 *      `Inbox (<service>)` with its tasks, which stay synced;
 *   2. every task row an older build left without a project (NULL or '') is filed there (a NULL
 *      row whose payload names a project, which rowToTask read as that project, keeps it);
 *   3. every folder of the old empty project is filed there too.
 * Nothing else on a row changes (not updated_at, not the source): an older build reads the
 * result as an ordinary project named Inbox, so going back needs no step.
 *
 * Before it moves anything it saves a copy of the database next to it
 * (`tasks.before-inbox-project.sqlite`, kept: never overwritten by a later run) and the list
 * of what it moved (`inbox-project-migration-<time>.json`), which is how to undo it:
 * set `project = ''` on exactly those task ids and folder ids (and give a renamed project its
 * old name back, as the record says).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logging/index.js';
import { INBOX_PROJECT } from './inbox-project.js';
import type { Database } from '../lib/sqlite.js';

type InboxMigrationDb = Pick<Database, 'prepare' | 'transaction' | 'backup'>;

export interface InboxMigrationResult {
  /** The registry row was created now. */
  created: boolean;
  /** Task ids filed into the Inbox now. */
  taskIds: string[];
  /** Folder ids filed into the Inbox now. */
  folderIds: string[];
  /** A project the user had under the Inbox's name, renamed now (see the file comment). */
  renamed?: { from: string; to: string; source: string; taskIds: string[] };
  /** The copy of the database taken before the move (undefined when nothing moved). */
  backupPath?: string;
  /** The record of what moved (undefined when nothing moved). */
  recordPath?: string;
}

const EMPTY = `(project IS NULL OR TRIM(project) = '')`;
/** A NULL column whose payload names a project: rowToTask reads that project, so it keeps it. */
const PAYLOAD_PROJECT = `CASE WHEN project IS NULL AND payload IS NOT NULL AND json_valid(payload)
  AND json_type(payload, '$.project') = 'text' THEN NULLIF(TRIM(json_extract(payload, '$.project')), '') END`;

interface Plan {
  taskIds: string[];
  folderIds: string[];
  /** The existing row holding the Inbox's name, when it is not already `Inbox` and local. */
  row?: { name: string; source: string };
  /** What that row becomes: `Inbox` (local) or `Inbox (<service>)` (claimed). */
  rowTo?: string;
  rowTaskIds: string[];
}

/** The Inbox's registry row as stored (any spelling), or undefined. */
function inboxRow(db: InboxMigrationDb): { name: string; source: string } | undefined {
  const rows = db.prepare('SELECT name, source FROM task_projects').all() as { name: string; source: string }[];
  return rows.find((r) => r.name.trim().toLowerCase() === INBOX_PROJECT.toLowerCase());
}

/** A free registry name for a claimed project that held the Inbox's name. */
function claimedName(db: InboxMigrationDb, source: string): string {
  const taken = (n: string) => !!db.prepare('SELECT 1 FROM task_projects WHERE name = ?').get(n);
  const base = `${INBOX_PROJECT} (${source})`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}

function plan(db: InboxMigrationDb): Plan {
  const taskIds = (db.prepare(`SELECT id FROM tasks WHERE ${EMPTY} AND (${PAYLOAD_PROJECT}) IS NULL`).all() as { id: string }[]).map((r) => r.id);
  const folderIds = (db.prepare(`SELECT id FROM task_groups WHERE ${EMPTY}`).all() as { id: string }[]).map((r) => r.id);
  const row = inboxRow(db);
  if (!row || (row.name === INBOX_PROJECT && row.source === 'local')) return { taskIds, folderIds, rowTaskIds: [] };
  const rowTo = row.source === 'local' ? INBOX_PROJECT : claimedName(db, row.source);
  const rowTaskIds = (db.prepare('SELECT id FROM tasks WHERE project = ? COLLATE NOCASE').all(row.name) as { id: string }[]).map((r) => r.id);
  return { taskIds, folderIds, row, rowTo, rowTaskIds };
}

const somethingToDo = (p: Plan) => p.taskIds.length > 0 || p.folderIds.length > 0 || !!p.row;

/**
 * Make the Inbox a real project in `db` (the primary's task store). `dir` is where the copy
 * and the record go (the task store's own folder). Safe to run any number of times.
 */
export async function migrateInboxProject(db: InboxMigrationDb, dir: string, now = new Date()): Promise<InboxMigrationResult> {
  const before = plan(db);
  let backupPath: string | undefined;
  let recordPath: string | undefined;
  if (somethingToDo(before)) {
    await fs.mkdir(dir, { recursive: true });
    // The first copy is the one that holds the data as the older build left it: a later run
    // (rows an older client wrote since) records its own list but keeps that copy. Written
    // beside it and renamed, so a copy cut off half way is never taken for a finished one.
    const copy = path.join(dir, 'tasks.before-inbox-project.sqlite');
    const exists = await fs.stat(copy).then(() => true, () => false);
    if (!exists) {
      const partial = `${copy}.partial`;
      try {
        await fs.rm(partial, { force: true });
        await db.backup(partial);
        await fs.rename(partial, copy);
        backupPath = copy;
      } catch (err) {
        // The record below is the undo on its own; a failed copy is logged, never a stop.
        await fs.rm(partial, { force: true }).catch(() => {});
        log.task.warn('inbox migration: database copy failed', { copy, err: err instanceof Error ? err.message : String(err) });
      }
    }
    recordPath = path.join(dir, `inbox-project-migration-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(recordPath, JSON.stringify({
      at: now.toISOString(),
      project: INBOX_PROJECT,
      undo: "UPDATE tasks SET project = '' WHERE id IN (taskIds); UPDATE task_groups SET project = '' WHERE id IN (folderIds)"
        + (before.row ? `; rename project '${before.rowTo}' back to '${before.row.name}' (source ${before.row.source}, its tasks: renamedTaskIds)` : ''),
      taskIds: before.taskIds,
      folderIds: before.folderIds,
      ...(before.row ? { renamed: { from: before.row.name, to: before.rowTo, source: before.row.source }, renamedTaskIds: before.rowTaskIds } : {}),
    }, null, 2) + '\n');
  }

  // One transaction, planning again inside it: a row written between the read above and here
  // is filed too (its id is in the log line, if not in the record).
  const result = db.transaction(() => {
    const now2 = plan(db);
    let created = false;
    if (now2.row && now2.rowTo) {
      const { row, rowTo } = now2;
      // A local project of this name is the Inbox now, under one spelling; a claimed one keeps
      // its service and its tasks under a name of its own (nothing claims the Inbox: it would
      // sync every unfiled task to that service).
      db.prepare('UPDATE task_projects SET name = ? WHERE name = ?').run(rowTo, row.name);
      // A claimed one keeps living in its service's list of the old name (as renameProject
      // keeps it): without the alias the next push would make a second list named rowTo.
      if (row.source !== 'local') {
        db.prepare(`UPDATE task_projects SET metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.remote_list', ?)
          WHERE name = ? AND (metadata IS NULL OR NOT json_valid(metadata) OR COALESCE(TRIM(json_extract(metadata, '$.remote_list')), '') = '')`).run(row.name, rowTo);
      }
      db.prepare('UPDATE tasks SET project = ? WHERE project = ? COLLATE NOCASE').run(rowTo, row.name);
      db.prepare('UPDATE task_groups SET project = ? WHERE project = ? COLLATE NOCASE').run(rowTo, row.name);
      log.task.warn('inbox migration: a project held the Inbox\'s name', { from: row.name, to: rowTo, source: row.source, tasks: now2.rowTaskIds.length });
    }
    if (!inboxRow(db)) {
      const next = (db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM task_projects').get() as { next: number }).next;
      db.prepare('INSERT INTO task_projects (name, source, order_index) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING')
        .run(INBOX_PROJECT, 'local', next);
      created = true;
    }
    db.prepare('DELETE FROM task_project_tombstones WHERE name = ? COLLATE NOCASE').run(INBOX_PROJECT);
    if (now2.taskIds.length) db.prepare(`UPDATE tasks SET project = ? WHERE ${EMPTY} AND (${PAYLOAD_PROJECT}) IS NULL`).run(INBOX_PROJECT);
    // A NULL column with a payload project: write the project rowToTask already read.
    db.prepare(`UPDATE tasks SET project = ${PAYLOAD_PROJECT} WHERE project IS NULL AND (${PAYLOAD_PROJECT}) IS NOT NULL`).run();
    if (now2.folderIds.length) db.prepare(`UPDATE task_groups SET project = ? WHERE ${EMPTY}`).run(INBOX_PROJECT);
    return {
      created, taskIds: now2.taskIds, folderIds: now2.folderIds,
      ...(now2.row && now2.rowTo ? { renamed: { from: now2.row.name, to: now2.rowTo, source: now2.row.source, taskIds: now2.rowTaskIds } } : {}),
    };
  })();

  if (result.created || result.taskIds.length || result.folderIds.length || result.renamed) {
    log.task.info('inbox migration: the Inbox is a project', {
      created: result.created, tasks: result.taskIds.length, folders: result.folderIds.length, backupPath, recordPath,
    });
  }
  return { ...result, ...(backupPath ? { backupPath } : {}), ...(recordPath ? { recordPath } : {}) };
}
