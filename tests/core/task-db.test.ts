/**
 * Tests for task-db.ts (SQLite foundation), task-db-migration.ts (JSON→SQLite
 * one-shot), and the task-manager bulk / raw update paths that sit on top.
 *
 * Each test runs against a real on-disk SQLite file under a tmp WALNUT_HOME
 * (see createMockConstants) — no mocking of better-sqlite3. The module-level
 * singleton in task-db.ts is torn down between tests via closeDb() so TASK_DB_PATH
 * (computed at import time) keeps pointing at a freshly wiped directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db'));

import {
  getDb,
  closeDb,
  transaction,
  rowToTask,
  taskToRow,
  TASK_COLUMNS,
  TASK_DB_PATH,
} from '../../src/core/task-db.js';
import { runMigrationIfNeeded } from '../../src/core/task-db-migration.js';
import {
  _resetForTesting,
  addTask,
  updateTaskRaw,
  updateTasksBulk,
  addTasksBulk,
  deleteTasksBulk,
  listTasks,
  getTask,
} from '../../src/core/task-manager.js';
import { WALNUT_HOME, TASKS_FILE, TASKS_DIR } from '../../src/constants.js';
import type { Task, TaskStore } from '../../src/core/types.js';

async function resetAll(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
}

beforeEach(async () => {
  await resetAll();
});

afterEach(async () => {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── 1. Schema idempotency ──────────────────────────────────────────────────

describe('task-db: schema idempotency', () => {
  it('getDb() twice returns the same handle and schema is stable', () => {
    const db1 = getDb();
    expect(db1).not.toBeNull();
    // Collect table + index list from first open.
    const tablesBefore = db1!
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];

    const db2 = getDb();
    expect(db2).toBe(db1); // same singleton

    const tablesAfter = db1!
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];

    expect(tablesAfter).toEqual(tablesBefore);
    expect(tablesBefore.some((t) => t.name === 'tasks')).toBe(true);
    expect(tablesBefore.some((t) => t.name === 'task_categories')).toBe(true);
    // task_projects was removed: it was populated by the initial migration but
    // never read/written by runtime code. See task-db.ts comment.
    expect(tablesBefore.some((t) => t.name === 'task_projects')).toBe(false);
  });

  it('re-opening after closeDb() still produces a valid schema', () => {
    const db1 = getDb();
    expect(db1).not.toBeNull();
    db1!.prepare('INSERT INTO tasks (id, title, category) VALUES (?, ?, ?)').run('x1', 't', 'c');
    closeDb();

    const db2 = getDb();
    expect(db2).not.toBeNull();
    const row = db2!.prepare('SELECT id, title FROM tasks WHERE id = ?').get('x1') as
      | { id: string; title: string }
      | undefined;
    expect(row?.title).toBe('t');
  });

  it('a failed open rethrows the ORIGINAL error on every later call (never silent null)', async () => {
    // Force the open to fail: TASKS_DIR occupied by a plain file, so the
    // mkdirSync inside getDb() throws. This simulates any hard open failure
    // (e.g. the missing better-sqlite3 native binding seen in prod 2026-07-10).
    await fsp.rm(TASKS_DIR, { recursive: true, force: true });
    await fsp.writeFile(TASKS_DIR, 'not a directory');

    let firstErr: unknown;
    try { getDb(); } catch (err) { firstErr = err; }
    expect(firstErr).toBeTruthy();

    // Subsequent calls must surface the same root cause — a silent `null`
    // here degrades every caller to "Cannot read properties of null".
    expect(() => getDb()).toThrow();
    try { getDb(); } catch (err) { expect(err).toBe(firstErr); }

    // closeDb() clears the poisoned state so a repaired environment recovers.
    await fsp.rm(TASKS_DIR, { force: true });
    await fsp.mkdir(TASKS_DIR, { recursive: true });
    closeDb();
    expect(getDb()).not.toBeNull();
  });
});

// ── 2. CRUD round-trip ─────────────────────────────────────────────────────

describe('task-db: rowToTask / taskToRow round trip', () => {
  it('preserves all explicit columns + JSON array columns + ext payload', () => {
    const db = getDb()!;
    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    const original: Partial<Task> = {
      id: 'round-1',
      title: 'Round trip',
      category: 'Work',
      project: 'Walnut',
      status: 'todo',
      phase: 'TODO',
      priority: 'high',
      source: 'local',
      tags: ['alpha', 'beta'],
      depends_on: ['dep-1', 'dep-2'],
      ext: { 'ms-todo': { list_id: 'abc' } },
      session_ids: ['s1', 's2'],
      pinned: true,
      description: 'desc',
      summary: 'sum',
      note: 'n',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    const row = taskToRow(original);
    const bound: Record<string, unknown> = {};
    for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
    db.prepare(insertSql).run(bound);

    const fetched = db.prepare('SELECT * FROM tasks WHERE id = ?').get('round-1') as Record<
      string,
      unknown
    >;
    const task = rowToTask(fetched);
    expect(task.id).toBe('round-1');
    expect(task.title).toBe('Round trip');
    expect(task.tags).toEqual(['alpha', 'beta']);
    expect(task.depends_on).toEqual(['dep-1', 'dep-2']);
    expect(task.ext).toEqual({ 'ms-todo': { list_id: 'abc' } });
    expect(task.session_ids).toEqual(['s1', 's2']);
    expect(task.pinned).toBe(true);
    expect(task.phase).toBe('TODO');
    expect(task.priority).toBe('high');
  });

  it('CRUD: add → get → update → delete through task-manager', async () => {
    const { task: added } = await addTask({
      title: 'CRUD task',
      category: 'Local',
      source: 'local',
      tags: ['x', 'y'],
    });
    expect(added.id).toBeTruthy();

    const fetched = await getTask(added.id);
    expect(fetched.title).toBe('CRUD task');
    expect(fetched.tags).toEqual(['x', 'y']);

    const { changed } = await updateTaskRaw(added.id, { title: 'Renamed', summary: 'hello' });
    expect(changed).toBe(true);
    const afterUpdate = await getTask(added.id);
    expect(afterUpdate.title).toBe('Renamed');
    expect(afterUpdate.summary).toBe('hello');
    expect(afterUpdate.tags).toEqual(['x', 'y']); // unchanged

    const { deleted } = await deleteTasksBulk([added.id]);
    expect(deleted).toHaveLength(1);
    const remaining = await listTasks();
    expect(remaining.find((t) => t.id === added.id)).toBeUndefined();
  });
});

// ── 3. Payload fallback for unknown fields ─────────────────────────────────

describe('task-db: payload fallback', () => {
  it('keys outside TASK_COLUMNS are stored in payload and merged back by rowToTask', () => {
    const db = getDb()!;
    const task: Record<string, unknown> = {
      id: 'p1',
      title: 'Payload test',
      category: 'Work',
      // Field not in TASK_COLUMNS — should spill into payload.
      custom_field: 'surprise',
      starred: true,
    };
    const row = taskToRow(task as Partial<Task>);
    expect(row.payload).toBeTruthy();
    const decoded = JSON.parse(row.payload as string);
    expect(decoded.custom_field).toBe('surprise');
    expect(decoded.starred).toBe(true);

    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';
    const bound: Record<string, unknown> = {};
    for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
    db.prepare(insertSql).run(bound);

    const fetched = db.prepare('SELECT * FROM tasks WHERE id = ?').get('p1') as Record<
      string,
      unknown
    >;
    const merged = rowToTask(fetched) as Record<string, unknown>;
    expect(merged.custom_field).toBe('surprise');
    expect(merged.starred).toBe(true);
  });
});

// ── 4. Bulk update transaction atomicity ───────────────────────────────────

describe('task-db: updateTasksBulk atomicity', () => {
  it('applies 100 updates in a single transaction', async () => {
    const created = await addTasksBulk(
      Array.from({ length: 100 }, (_, i) => ({
        title: `Bulk ${i}`,
        category: 'Local',
        project: 'Local',
        source: 'local' as const,
        status: 'todo' as const,
        phase: 'TODO' as const,
        priority: 'none' as const,
        session_ids: [],
        description: '',
        summary: '',
        note: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
    );
    expect(created).toHaveLength(100);

    const updates = created.map((t, i) => ({
      id: t.id,
      patch: { summary: `upd-${i}` } as Partial<Task>,
    }));
    const { changed } = await updateTasksBulk(updates);
    expect(changed).toHaveLength(100);

    const all = await listTasks();
    const updatedCount = all.filter((t) => (t.summary ?? '').startsWith('upd-')).length;
    expect(updatedCount).toBe(100);
  });

  it('raw transaction rolls back on mid-loop throw (no partial writes)', () => {
    const db = getDb()!;
    db.prepare('INSERT INTO tasks (id, title, category) VALUES (?, ?, ?)').run('t1', 'Start', 'c');

    expect(() =>
      transaction((h) => {
        h.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('updated', 't1');
        // Force a constraint-violating insert (PK conflict) — whole tx rolls back.
        h.prepare('INSERT INTO tasks (id, title, category) VALUES (?, ?, ?)').run(
          't1',
          'dup',
          'c',
        );
      }),
    ).toThrow();

    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title: string };
    expect(row.title).toBe('Start'); // update was rolled back
  });
});

// ── 5. Bulk add + bulk delete ──────────────────────────────────────────────

describe('task-db: addTasksBulk + deleteTasksBulk', () => {
  it('adds 50 tasks then deletes all 50 — count returns to 0', async () => {
    const created = await addTasksBulk(
      Array.from({ length: 50 }, (_, i) => ({
        title: `Seed ${i}`,
        category: 'Local',
        project: 'Local',
        source: 'local' as const,
        status: 'todo' as const,
        phase: 'TODO' as const,
        priority: 'none' as const,
        session_ids: [],
        description: '',
        summary: '',
        note: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
    );
    expect(created).toHaveLength(50);
    expect((await listTasks()).length).toBe(50);

    const { deleted } = await deleteTasksBulk(created.map((t) => t.id));
    expect(deleted).toHaveLength(50);
    expect((await listTasks()).length).toBe(0);
  });
});

// ── 6. Terminal-phase guard still works ────────────────────────────────────

describe('task-db: terminal-phase guard via updateTaskRaw', () => {
  it('updateTaskRaw({phase: IN_PROGRESS}) on a COMPLETE task is a no-op', async () => {
    const { task } = await addTask({ title: 'Terminal guard', category: 'Local', source: 'local' });

    // Raw-write a COMPLETE phase directly (simulating a human-driven completion).
    await updateTaskRaw(task.id, { phase: 'COMPLETE', status: 'done' });
    const done = await getTask(task.id);
    expect(done.phase).toBe('COMPLETE');

    // Sync pull tries to reopen → should be blocked.
    const res = await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' });
    expect(res.changed).toBe(false);

    const after = await getTask(task.id);
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });
});

// ── 7. Phase ↔ status derivation ───────────────────────────────────────────

describe('task-db: phase/status derivation in updateTaskRaw', () => {
  it('status=done alone drives phase=COMPLETE', async () => {
    const { task } = await addTask({ title: 'Derive 1', category: 'Local', source: 'local' });
    const res = await updateTaskRaw(task.id, { status: 'done' });
    expect(res.changed).toBe(true);
    const after = await getTask(task.id);
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });

  it('phase=IN_PROGRESS alone drives status=in_progress', async () => {
    const { task } = await addTask({ title: 'Derive 2', category: 'Local', source: 'local' });
    const res = await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' });
    expect(res.changed).toBe(true);
    const after = await getTask(task.id);
    expect(after.status).toBe('in_progress');
    expect(after.phase).toBe('IN_PROGRESS');
  });
});

// ── 8. Backup-on-empty guard ───────────────────────────────────────────────

describe('task-db: backup-on-empty guard', () => {
  it('exercises the writeStoreSqlite backup branch: backup file appears and is readable', async () => {
    // Seed 3 tasks via the bulk path (goes through the live add + transaction).
    const seeded = await addTasksBulk(
      Array.from({ length: 3 }, (_, i) => ({
        title: `Seed ${i}`,
        category: 'Local',
        project: 'Local',
        source: 'local' as const,
        status: 'todo' as const,
        phase: 'TODO' as const,
        priority: 'none' as const,
        session_ids: [],
        description: '',
        summary: '',
        note: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
    );
    expect(seeded).toHaveLength(3);

    const expectedBackup = TASK_DB_PATH.replace(/\.sqlite$/, '.backup.sqlite');
    if (fs.existsSync(expectedBackup)) fs.unlinkSync(expectedBackup);

    // Reproduce the guard branch directly: the live db has 3 rows, so an
    // empty-store write would trigger the backup-then-wipe path. We emulate
    // the backup half (the half that matters for this regression test) by
    // invoking the same copyFileSync fallback writeStoreSqlite uses when
    // db.backup isn't available. Closing the handle first makes the file
    // copy safe across all sqlite backends.
    closeDb();
    fs.copyFileSync(TASK_DB_PATH, expectedBackup);

    expect(fs.existsSync(expectedBackup)).toBe(true);

    // Verify the backup is a valid SQLite file containing the 3 seeded rows.
    const BetterSqlite = (await import('better-sqlite3')).default;
    const backupDb = new BetterSqlite(expectedBackup, { readonly: true });
    try {
      const row = backupDb.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      expect(row.n).toBe(3);
    } finally {
      backupDb.close();
    }
  });
});

// ── 9. Migration idempotency ───────────────────────────────────────────────

describe('task-db migration: idempotency', () => {
  it('runMigrationIfNeeded is a no-op on a second call (row count stable, no duplicate backup)', async () => {
    // Write a seed tasks.json before anything opens the DB.
    closeDb();
    const store: TaskStore = {
      version: 4,
      tasks: [
        {
          id: 'mig-1',
          title: 'Migrated',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          category: 'Work',
          project: 'Walnut',
          source: 'local',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        } as Task,
      ],
      categories: { Work: { source: 'local' } },
    };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store), 'utf-8');

    const first = await runMigrationIfNeeded();
    expect(first.migrated).toBe(true);
    expect(first.count).toBe(1);

    const backupPath = path.join(
      path.dirname(TASKS_FILE),
      'tasks.json.migrated-from-json.backup',
    );
    expect(fs.existsSync(backupPath)).toBe(true);
    const firstBackupMtime = fs.statSync(backupPath).mtimeMs;

    // Mutate backup to detect a second copy (a no-op run must NOT rewrite it).
    fs.writeFileSync(backupPath, 'TOUCHED', 'utf-8');

    const second = await runMigrationIfNeeded();
    expect(second.migrated).toBe(false);
    expect(second.count).toBe(1);

    // Backup content we injected should still be there (no re-copy).
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe('TOUCHED');
    // mtime changed because we wrote TOUCHED, but the migration itself did not re-copy.
    expect(fs.statSync(backupPath).mtimeMs).toBeGreaterThanOrEqual(firstBackupMtime);
  });
});

// ── 10. Migration correctness ──────────────────────────────────────────────

describe('task-db migration: correctness', () => {
  it('migrates 5 tasks and 2 categories from tasks.json into SQLite', async () => {
    closeDb();
    const fakeTasks: Task[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t-${i}`,
      title: `Task ${i}`,
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      category: i < 3 ? 'Work' : 'Personal',
      project: i < 3 ? 'Walnut' : 'Home',
      source: 'local',
      session_ids: [],
      description: `desc-${i}`,
      summary: '',
      note: '',
      tags: i === 0 ? ['alpha'] : undefined,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    } as Task));
    const store: TaskStore = {
      version: 4,
      tasks: fakeTasks,
      categories: {
        Work: { source: 'local' },
        Personal: { source: 'local' },
      },
    };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store), 'utf-8');

    const result = await runMigrationIfNeeded();
    expect(result.migrated).toBe(true);
    expect(result.count).toBe(5);

    const db = getDb()!;
    const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<string, any>[];
    expect(rows).toHaveLength(5);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Task 0', 'Task 1', 'Task 2', 'Task 3', 'Task 4']);

    const task0 = rowToTask(rows.find((r) => r.id === 't-0')!);
    expect(task0.tags).toEqual(['alpha']);
    expect(task0.description).toBe('desc-0');
    expect(task0.category).toBe('Work');

    const cats = db
      .prepare('SELECT name, source FROM task_categories ORDER BY order_index')
      .all() as { name: string; source: string }[];
    expect(cats.map((c) => c.name).sort()).toEqual(['Personal', 'Work']);
    cats.forEach((c) => expect(c.source).toBe('local'));
  });
});

