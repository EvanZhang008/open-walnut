/**
 * The boot migration that makes the Inbox a real project (inbox-project.ts).
 *
 * Runs on every open of the primary's task store and is a no-op once done:
 *   1. the registry row `Inbox` (local, never claimed) exists, and no tombstone holds the name;
 *   2. every task row an older build left without a project (NULL or '') is filed there (a row
 *      whose payload names a project, as rowToTask read it, keeps that one);
 *   3. every folder of the old empty project is filed there too.
 * Nothing else on a row changes (not updated_at, not the source): an older build reads the
 * result as an ordinary project named Inbox, so going back needs no step.
 *
 * Before it moves anything it saves a copy of the database next to it
 * (`tasks.before-inbox-project.sqlite`, kept: never overwritten by a later run) and the list
 * of what it moved (`inbox-project-migration-<time>.json`), which is how to undo it:
 * set `project = ''` on exactly those task ids and folder ids.
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
  /** The copy of the database taken before the move (undefined when nothing moved). */
  backupPath?: string;
  /** The record of what moved (undefined when nothing moved). */
  recordPath?: string;
}

const EMPTY = `(project IS NULL OR TRIM(project) = '')`;

function pending(db: InboxMigrationDb): { taskIds: string[]; folderIds: string[] } {
  const taskIds = (db.prepare(`SELECT id FROM tasks WHERE ${EMPTY}`).all() as { id: string }[]).map((r) => r.id);
  const folderIds = (db.prepare(`SELECT id FROM task_groups WHERE ${EMPTY}`).all() as { id: string }[]).map((r) => r.id);
  return { taskIds, folderIds };
}

/** The Inbox's registry row as stored (any spelling), or undefined. */
function inboxRow(db: InboxMigrationDb): { name: string; source: string } | undefined {
  const rows = db.prepare('SELECT name, source FROM task_projects').all() as { name: string; source: string }[];
  return rows.find((r) => r.name.trim().toLowerCase() === INBOX_PROJECT.toLowerCase());
}

/**
 * Make the Inbox a real project in `db` (the primary's task store). `dir` is where the copy
 * and the record go (the task store's own folder). Safe to run any number of times.
 */
export async function migrateInboxProject(db: InboxMigrationDb, dir: string, now = new Date()): Promise<InboxMigrationResult> {
  const before = pending(db);
  let backupPath: string | undefined;
  let recordPath: string | undefined;
  if (before.taskIds.length || before.folderIds.length) {
    await fs.mkdir(dir, { recursive: true });
    // The first copy is the one that holds the data as the older build left it: a later run
    // (rows an older client wrote since) records its own list but keeps that copy.
    const copy = path.join(dir, 'tasks.before-inbox-project.sqlite');
    const exists = await fs.stat(copy).then(() => true, () => false);
    if (!exists) {
      try {
        await db.backup(copy);
        backupPath = copy;
      } catch (err) {
        // The record below is the undo on its own; a failed copy is logged, never a stop.
        log.task.warn('inbox migration: database copy failed', { copy, err: err instanceof Error ? err.message : String(err) });
      }
    }
    recordPath = path.join(dir, `inbox-project-migration-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(recordPath, JSON.stringify({
      at: now.toISOString(),
      project: INBOX_PROJECT,
      undo: "UPDATE tasks SET project = '' WHERE id IN (taskIds); UPDATE task_groups SET project = '' WHERE id IN (folderIds)",
      taskIds: before.taskIds,
      folderIds: before.folderIds,
    }, null, 2) + '\n');
  }

  // One transaction, re-reading what is empty inside it: a row written between the read
  // above and here is filed too (its id is in the log line, if not in the record).
  const result = db.transaction(() => {
    let created = false;
    const row = inboxRow(db);
    if (!row) {
      const next = (db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM task_projects').get() as { next: number }).next;
      db.prepare('INSERT INTO task_projects (name, source, order_index) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING')
        .run(INBOX_PROJECT, 'local', next);
      created = true;
    } else if (row.source !== 'local') {
      // Nothing claims the Inbox (it would sync every unfiled task to that service): a
      // service that claimed a project of this name before it was the Inbox lets go of it.
      db.prepare('UPDATE task_projects SET source = ? WHERE name = ?').run('local', row.name);
      log.task.warn('inbox migration: the Inbox was claimed by a service; it is local now', { was: row.source });
    }
    db.prepare('DELETE FROM task_project_tombstones WHERE name = ? COLLATE NOCASE').run(INBOX_PROJECT);
    const now2 = pending(db);
    const name = inboxRow(db)?.name ?? INBOX_PROJECT;
    // A foreign row (an older replica's copy) may carry its project in the payload, which
    // rowToTask read while the column was empty: that project stays its project.
    if (now2.taskIds.length) {
      db.prepare(
        `UPDATE tasks SET project = COALESCE(
           CASE WHEN payload IS NOT NULL AND json_valid(payload) AND json_type(payload, '$.project') = 'text'
             THEN NULLIF(TRIM(json_extract(payload, '$.project')), '') END,
           ?) WHERE ${EMPTY}`,
      ).run(name);
    }
    if (now2.folderIds.length) db.prepare(`UPDATE task_groups SET project = ? WHERE ${EMPTY}`).run(name);
    return { created, ...now2 };
  })();

  if (result.created || result.taskIds.length || result.folderIds.length) {
    log.task.info('inbox migration: the Inbox is a project', {
      created: result.created, tasks: result.taskIds.length, folders: result.folderIds.length, backupPath, recordPath,
    });
  }
  return { ...result, ...(backupPath ? { backupPath } : {}), ...(recordPath ? { recordPath } : {}) };
}
