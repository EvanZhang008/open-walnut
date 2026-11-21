/**
 * Guard: every task has a project (src/core/inbox-project.ts). No way of writing a task may leave
 * its project empty; one that names none files it in the Inbox.
 *
 * Three layers, so a NEW way of writing a task fails here until it is covered:
 *   1. Only the task store's own files write task rows in SQL, and each statement that inserts a
 *      row binds one built by taskToFullRow (directly or through rowFingerprint).
 *   2. Every exported function of task-manager.ts that adds a task is named below, and the ones
 *      a primary runs are exercised with an empty project.
 *   3. The row codec itself: taskToRow / taskToFullRow / rowToTask.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  _resetForTesting, addTask, addTaskFull, addTasksBulk, updateTask, updateTaskRaw, createFolder, moveFolderToProject,
  groupTasks, getTask, ensureProject,
} from '../../src/core/task-manager.js';
import { closeDb, getDb, rowToTask, taskToFullRow, taskToRow } from '../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { INBOX_PROJECT, isInboxProject, projectOrInbox } from '../../src/core/inbox-project.js';
import type { Task } from '../../src/core/types.js';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const INSERT_RE = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+tasks\b(?!_)/g;
const UPDATE_RE = /UPDATE\s+tasks\s+SET\b/g;

/** The task store's own files: the only ones allowed to write task rows in SQL. */
const STORE_FILES = new Set([
  'src/core/task-manager.ts',
  'src/core/task-db.ts',
  'src/core/task-db-migration.ts',
  'src/core/inbox-migration.ts',
]);

describe('layer 1: only the task store writes task rows, through taskToFullRow', () => {
  it('no other file inserts or updates task rows in SQL', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (STORE_FILES.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      INSERT_RE.lastIndex = 0;
      if (INSERT_RE.test(text)) offenders.push(`${rel}: inserts task rows`);
      // An UPDATE of other columns (a hook stamping a note) is fine; one that sets the project is not.
      UPDATE_RE.lastIndex = 0;
      for (let m = UPDATE_RE.exec(text); m; m = UPDATE_RE.exec(text)) {
        const set = text.slice(m.index, m.index + 600).split(/\bWHERE\b/)[0]!;
        if (/\bproject\s*=/.test(set)) offenders.push(`${rel}: sets tasks.project`);
      }
    }
    expect(offenders, 'write tasks through task-manager.ts (addTask, updateTask, ...), whose rows go through taskToFullRow and so always have a project').toEqual([]);
  });

  it("every INSERT into tasks in task-manager.ts binds a row built by taskToFullRow", () => {
    const text = fs.readFileSync(path.join(SRC, 'core/task-manager.ts'), 'utf8');
    const lines = text.split('\n');
    const sites: number[] = [];
    lines.forEach((line, i) => { INSERT_RE.lastIndex = 0; if (INSERT_RE.test(line)) sites.push(i); });
    expect(sites.length).toBeGreaterThan(0);
    const fnStart = /^(?:export )?(?:async )?function /;
    const unbound = sites.filter((i) => {
      // The whole top-level function holding the statement.
      let start = i;
      while (start > 0 && !fnStart.test(lines[start]!)) start--;
      let end = i + 1;
      while (end < lines.length && !fnStart.test(lines[end]!)) end++;
      return !/taskToFullRow\(|rowFingerprint\(/.test(lines.slice(start, end).join('\n'));
    }).map((i) => `task-manager.ts:${i + 1}`);
    expect(unbound, 'bind the inserted row from taskToFullRow(task) (or rowFingerprint), which files an empty project in the Inbox').toEqual([]);
    // rowFingerprint itself is the full-row codec.
    expect(text).toMatch(/function rowFingerprint\(task: Task\): RowFingerprint \{\n\s+const partial = taskToFullRow\(task\);/);
  });
});

/** Functions of task-manager.ts that add a task row (push onto the store, or INSERT), exported or not. */
function creatorsInSource(): string[] {
  const text = fs.readFileSync(path.join(SRC, 'core/task-manager.ts'), 'utf8');
  const out = new Set<string>();
  const parts = text.split(/\n(?=(?:export )?(?:async )?function )/);
  for (const part of parts) {
    const head = /^(?:export )?(?:async )?function (\w+)/.exec(part);
    if (!head) continue;
    INSERT_RE.lastIndex = 0;
    if (/store\.tasks\.push\(/.test(part) || INSERT_RE.test(part)) out.add(head[1]!);
  }
  return [...out].sort();
}

/** Every function that adds a task row, and how this file covers it. */
const CREATORS: Record<string, 'exercised' | 'replica-only' | 'shared-writer'> = {
  addTask: 'exercised',
  addTaskFull: 'exercised',
  addTasksBulk: 'exercised',
  // The whole-store writer every creator above ends in: binds rows through rowFingerprint (layer 1).
  writeStore: 'shared-writer',
  // A follower's copy of the leader's rows (applyTaskReplica): bound through rowFingerprint
  // (layer 1); a primary never runs it.
  applyTaskReplicaRows: 'replica-only',
};

describe('layer 2: every way to add a task is known and files an empty project in the Inbox', () => {
  it('names every function in task-manager.ts that adds a task', () => {
    expect(creatorsInSource(), 'a new function adds tasks: add it to CREATORS and exercise it below with an empty project').toEqual(Object.keys(CREATORS).sort());
  });

  beforeEach(async () => {
    closeDb();
    closeSessionDb();
    _resetForTesting();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });
  afterEach(async () => {
    closeDb();
    closeSessionDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  const emptyRows = () => (getDb()!.prepare(`SELECT id, project FROM tasks WHERE project IS NULL OR TRIM(project) = ''`).all());
  const storedProject = (id: string) => (getDb()!.prepare('SELECT project FROM tasks WHERE id = ?').get(id) as { project: string | null }).project;

  it('addTask: no project, an empty one, a blank one', async () => {
    for (const project of [undefined, '', '   ']) {
      const { task } = await addTask({ title: `t ${String(project)}`, ...(project !== undefined ? { project } : {}) });
      expect(task.project).toBe(INBOX_PROJECT);
      expect(storedProject(task.id)).toBe(INBOX_PROJECT);
    }
    expect(emptyRows()).toEqual([]);
  });

  it('addTask: a subtask of an Inbox task, and a task in a deleted project', async () => {
    const { task: parent } = await addTask({ title: 'parent' });
    const { task: child } = await addTask({ title: 'child', parent_task_id: parent.id });
    expect(child.project).toBe(INBOX_PROJECT);
    await ensureProject('Gone');
    const { deleteProject } = await import('../../src/core/task-manager.js');
    await deleteProject('Gone');
    const { task: late } = await addTask({ title: 'late', project: 'Gone' });
    expect(late.project).toBe(INBOX_PROJECT);
    expect(emptyRows()).toEqual([]);
  });

  it('addTaskFull and addTasksBulk (importers and pulls) with an empty or missing project', async () => {
    const full = await addTaskFull({ title: 'pulled', project: '', source: 'local' } as Omit<Task, 'id'>);
    expect(full.project).toBe(INBOX_PROJECT);
    const bulk = await addTasksBulk([
      { title: 'bulk a', source: 'local' } as Omit<Task, 'id'>,
      { title: 'bulk b', project: '', source: 'local' } as Omit<Task, 'id'>,
    ]);
    for (const t of bulk) expect(t.project).toBe(INBOX_PROJECT);
    expect(emptyRows()).toEqual([]);
  });

  it('a synced task still cannot be created in the Inbox', async () => {
    await expect(addTask({ title: 'synced', project: '', source: 'ms-todo' as Task['source'] })).rejects.toThrow(/Inbox/);
    await expect(addTaskFull({ title: 'synced', project: '', source: 'ms-todo' } as Omit<Task, 'id'>)).rejects.toThrow(/Inbox/);
  });

  it('moves and raw writes that clear a project file the task in the Inbox', async () => {
    const { task } = await addTask({ title: 'moved', project: 'Walnut' });
    const moved = await updateTask(task.id, { project: '' });
    expect(moved.task.project).toBe(INBOX_PROJECT);
    await updateTask(task.id, { project: 'Walnut' });
    await updateTaskRaw(task.id, { project: null as unknown as string });
    expect((await getTask(task.id))?.project).toBe(INBOX_PROJECT);
    await updateTask(task.id, { project: 'Walnut' });
    await updateTaskRaw(task.id, { project: '' });
    expect(storedProject(task.id)).toBe(INBOX_PROJECT);
    expect(emptyRows()).toEqual([]);
  });

  it('folders: made, grouped and moved into the Inbox by its empty name', async () => {
    const folder = await createFolder('Errands', '');
    expect(folder.project).toBe(INBOX_PROJECT);
    const { task: a } = await addTask({ title: 'a', project: 'Walnut' });
    const { task: b } = await addTask({ title: 'b', project: 'Walnut' });
    const grouped = await groupTasks([a.id, b.id], 'Pair');
    const moved = await moveFolderToProject(grouped.group_id, '');
    expect(moved.project).toBe(INBOX_PROJECT);
    expect((await getTask(a.id))?.project).toBe(INBOX_PROJECT);
    expect(getDb()!.prepare(`SELECT COUNT(*) AS n FROM task_groups WHERE TRIM(project) = '' OR project IS NULL`).get()).toEqual({ n: 0 });
    expect(emptyRows()).toEqual([]);
  });
});

describe('layer 3: the row codec', () => {
  it('taskToRow files a cleared or empty project in the Inbox, and leaves an absent one out of a patch', () => {
    expect(taskToRow({ project: '' }).project).toBe(INBOX_PROJECT);
    expect(taskToRow({ project: '  ' }).project).toBe(INBOX_PROJECT);
    expect(taskToRow({ project: null as unknown as string }).project).toBe(INBOX_PROJECT);
    expect(taskToRow({ project: 'inbox' }).project).toBe(INBOX_PROJECT);
    expect(taskToRow({ project: 'Walnut' }).project).toBe('Walnut');
    expect('project' in taskToRow({ title: 'patch' })).toBe(false);
  });

  it('taskToFullRow gives a whole row with no project the Inbox', () => {
    expect(taskToFullRow({ id: 'x', title: 'x' } as Task).project).toBe(INBOX_PROJECT);
  });

  it('rowToTask reads a row an older build left empty as the Inbox', () => {
    expect(rowToTask({ id: 'x', title: 'x', project: null }).project).toBe(INBOX_PROJECT);
    expect(rowToTask({ id: 'x', title: 'x', project: '' }).project).toBe(INBOX_PROJECT);
    expect(rowToTask({ id: 'x', title: 'x', project: 'Walnut' }).project).toBe('Walnut');
  });

  it('the helpers agree on what the Inbox is', () => {
    for (const v of ['', '  ', null, undefined, 'Inbox', 'inbox', ' INBOX ']) {
      expect(isInboxProject(v)).toBe(true);
      expect(projectOrInbox(v)).toBe(INBOX_PROJECT);
    }
    expect(isInboxProject('Inboxes')).toBe(false);
    expect(projectOrInbox(' Walnut ')).toBe('Walnut');
  });
});
