/**
 * The boot migration that makes the Inbox a real project (src/core/inbox-migration.ts): rows an
 * older build left without a project are filed in `Inbox`, nothing else on them changes, it can
 * run any number of times, and it leaves a copy of the database and a record of what it moved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { closeDb, getDb, TASK_DB_PATH } from '../../src/core/task-db.js';
import { migrateInboxProject } from '../../src/core/inbox-migration.js';
import { _resetForTesting, getTask, listTasks, getStoreProjects, addTask } from '../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../src/constants.js';

const OLD_AT = '2026-01-02T03:04:05.000Z';

/** A task row the way an older build wrote it: no project. */
function oldRow(id: string, project: string | null, extra: Record<string, unknown> = {}): void {
  getDb()!.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, created_at, updated_at, note, payload)
     VALUES (@id, @title, @project, 'todo', 'TODO', 'none', @source, @at, @at, @note, @payload)`,
  ).run({ id, title: `t ${id}`, project, source: 'local', at: OLD_AT, note: `note ${id}`, payload: JSON.stringify({ group_id: extra.group_id ?? undefined }), ...extra });
}

function rowOf(id: string): Record<string, unknown> {
  return getDb()!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
}

const dir = () => path.dirname(TASK_DB_PATH);

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  getDb();
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('migrateInboxProject', () => {
  it('files every task and folder left without a project in the Inbox, changing nothing else', async () => {
    oldRow('a-0001', '');
    oldRow('b-0002', null);
    oldRow('c-0003', '   ');
    oldRow('d-0004', 'Walnut');
    getDb()!.prepare(`INSERT INTO task_groups (id, label, hidden, project, parent_id) VALUES ('g_one', 'Errands', 0, '', NULL)`).run();
    getDb()!.prepare(`INSERT INTO task_groups (id, label, hidden, project, parent_id) VALUES ('g_two', 'Code', 0, 'Walnut', NULL)`).run();
    const before = rowOf('a-0001');

    const result = await migrateInboxProject(getDb()!, dir(), new Date('2026-11-21T00:00:00Z'));

    expect(result.created).toBe(true);
    expect(result.taskIds.sort()).toEqual(['a-0001', 'b-0002', 'c-0003']);
    expect(result.folderIds).toEqual(['g_one']);
    for (const id of ['a-0001', 'b-0002', 'c-0003']) expect(rowOf(id).project).toBe('Inbox');
    expect(rowOf('d-0004').project).toBe('Walnut');
    // Nothing but the project moved: not the time, not the note, not the source.
    const after = rowOf('a-0001');
    expect({ ...after, project: before.project }).toEqual(before);
    expect(after.updated_at).toBe(OLD_AT);
    const folders = getDb()!.prepare('SELECT id, project FROM task_groups ORDER BY id').all();
    expect(folders).toEqual([{ id: 'g_one', project: 'Inbox' }, { id: 'g_two', project: 'Walnut' }]);
    const row = getDb()!.prepare(`SELECT name, source FROM task_projects WHERE name = 'Inbox'`).get();
    expect(row).toEqual({ name: 'Inbox', source: 'local' });
  });

  it('keeps a copy of the database and a record that undoes it, and a second run does nothing', async () => {
    oldRow('a-0001', '');
    const first = await migrateInboxProject(getDb()!, dir(), new Date('2026-11-21T00:00:00Z'));
    expect(first.backupPath).toBe(path.join(dir(), 'tasks.before-inbox-project.sqlite'));
    await expect(fs.stat(first.backupPath!)).resolves.toBeTruthy();
    const record = JSON.parse(await fs.readFile(first.recordPath!, 'utf8'));
    expect(record).toMatchObject({ project: 'Inbox', taskIds: ['a-0001'], folderIds: [] });

    // The copy holds the rows as the older build left them.
    const { default: Database } = await import('../../src/lib/sqlite.js');
    const copy = new Database(first.backupPath!, { readonly: true });
    expect((copy.prepare(`SELECT project FROM tasks WHERE id = 'a-0001'`).get() as { project: string }).project).toBe('');
    copy.close();

    const again = await migrateInboxProject(getDb()!, dir());
    expect(again).toEqual({ created: false, taskIds: [], folderIds: [] });
    const files = (await fs.readdir(dir())).filter((f) => f.startsWith('inbox-project-migration-'));
    expect(files).toHaveLength(1);

    // A later run (an older build wrote an empty row since) keeps the first copy, records its own move.
    oldRow('b-0002', '');
    const later = await migrateInboxProject(getDb()!, dir(), new Date('2026-11-22T00:00:00Z'));
    expect(later.taskIds).toEqual(['b-0002']);
    expect(later.backupPath).toBeUndefined();
    expect(later.recordPath).toBeDefined();
  });

  it('a row whose payload names a project (an older replica copy) keeps that project', async () => {
    oldRow('p-0001', null, { payload: JSON.stringify({ project: 'Ask Walnut' }) });
    oldRow('p-0002', '', { payload: JSON.stringify({ project: '  ' }) });
    await migrateInboxProject(getDb()!, dir());
    expect(rowOf('p-0001').project).toBe('Ask Walnut');
    expect(rowOf('p-0002').project).toBe('Inbox');
  });

  it('frees the name: an old tombstone is cleared and a service claim on a project named Inbox turns local', async () => {
    getDb()!.prepare(`INSERT INTO task_projects (name, source, order_index) VALUES ('inbox', 'ms-todo', 3)`).run();
    getDb()!.prepare(`INSERT INTO task_project_tombstones (name, source, deleted_at) VALUES ('Inbox', 'local', ?)`).run(OLD_AT);
    oldRow('a-0001', '');
    const result = await migrateInboxProject(getDb()!, dir());
    expect(result.created).toBe(false);
    expect(getDb()!.prepare(`SELECT name, source FROM task_projects`).all()).toEqual([{ name: 'inbox', source: 'local' }]);
    expect(getDb()!.prepare(`SELECT COUNT(*) AS n FROM task_project_tombstones`).get()).toEqual({ n: 0 });
    // Filed under the row's own spelling: one project, never two casings.
    expect(rowOf('a-0001').project).toBe('inbox');
  });
});

describe('the store after an upgrade', () => {
  it('reads every old Inbox task in the Inbox, with the Inbox in the registry', async () => {
    oldRow('a-0001', '');
    oldRow('b-0002', null);
    closeDb();
    _resetForTesting();
    // The first read of the store runs the migration (ensureInit).
    const tasks = await listTasks();
    expect(tasks.map((t) => [t.id, t.project]).sort()).toEqual([['a-0001', 'Inbox'], ['b-0002', 'Inbox']]);
    expect((await getStoreProjects()).Inbox).toMatchObject({ source: 'local' });
    expect((await getTask('a-0001'))?.updated_at).toBe(OLD_AT);
    // A new task without a project joins them, and nothing is left empty.
    const { task } = await addTask({ title: 'new' });
    expect(task.project).toBe('Inbox');
    expect(getDb()!.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project IS NULL OR TRIM(project) = ''`).get()).toEqual({ n: 0 });
  });
});
