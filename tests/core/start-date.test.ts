/**
 * start_date — the "when to begin working" field that drives the Now view.
 *
 * Covers the core surface: column round-trip, create/update paths,
 * precision-echo guard parity with due_date, the real v3→v4 ALTER TABLE
 * migration, slim list projection, and the cloud projection export shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  addTaskFull,
  getTask,
  updateTask,
  updateTaskRaw,
  updateTasksBulk,
  listTasksSlim,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

const TIME_LEVEL = '2026-08-01T09:00:00.000Z';
const SAME_DAY = '2026-08-01';
const OTHER_DAY = '2026-08-15';

describe('start_date round-trip', () => {
  it('persists through addTask and getTask', async () => {
    const { task } = await addTask({
      title: 'Deferred work', project: 'Marina',
      start_date: TIME_LEVEL,
    });
    expect(task.start_date).toBe(TIME_LEVEL);
    expect((await getTask(task.id)).start_date).toBe(TIME_LEVEL);
  });

  it('updates and clears via updateTask (human path)', async () => {
    const { task } = await addTask({ title: 'T', project: 'Marina' });
    await updateTask(task.id, { start_date: SAME_DAY });
    expect((await getTask(task.id)).start_date).toBe(SAME_DAY);
    await updateTask(task.id, { start_date: '' });
    expect((await getTask(task.id)).start_date).toBeUndefined();
  });

  it('appears in the slim list payload (home list view)', async () => {
    const { task } = await addTask({
      title: 'Slim check', project: 'Marina', start_date: SAME_DAY,
    });
    const slim = await listTasksSlim({ minimal: true });
    const row = slim.find((t) => t.id === task.id);
    expect(row?.start_date).toBe(SAME_DAY);
  });
});

describe('start_date precision echo guard (sync pull)', () => {
  async function makeTaskWithTimeStart(): Promise<string> {
    const { task } = await addTask({ title: 'S', project: 'Marina' });
    await updateTask(task.id, { start_date: TIME_LEVEL });
    return task.id;
  }

  it('updateTaskRaw drops a same-day date-only echo', async () => {
    const id = await makeTaskWithTimeStart();
    const { changed } = await updateTaskRaw(id, { start_date: SAME_DAY });
    expect(changed).toBe(false);
    expect((await getTask(id)).start_date).toBe(TIME_LEVEL);
  });

  it('updateTaskRaw applies a genuinely different day', async () => {
    const id = await makeTaskWithTimeStart();
    const { changed } = await updateTaskRaw(id, { start_date: OTHER_DAY });
    expect(changed).toBe(true);
    expect((await getTask(id)).start_date).toBe(OTHER_DAY);
  });

  it('updateTasksBulk (reconciler path) drops the echo per-row', async () => {
    const id = await makeTaskWithTimeStart();
    const { changed } = await updateTasksBulk([{ id, patch: { start_date: SAME_DAY } }]);
    expect(changed).toHaveLength(0);
    expect((await getTask(id)).start_date).toBe(TIME_LEVEL);
  });

  it('addTaskFull dedup-merge preserves the local time-level start', async () => {
    const { task } = await addTask({ title: 'Sync twin', project: 'Marina' });
    await updateTaskRaw(task.id, {
      start_date: TIME_LEVEL,
      ext: { acme: { id: 'r-9' } },
      source: 'acme',
    } as any);

    const merged = await addTaskFull({
      title: 'Sync twin', status: 'todo', phase: 'TODO', priority: 'none',
      project: 'Marina', source: 'acme',
      ext: { acme: { id: 'r-9' } }, session_ids: [],
      start_date: SAME_DAY,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as any);

    expect(merged.id).toBe(task.id);
    expect(merged.start_date).toBe(TIME_LEVEL);
  });
});

describe('schema v3→v4 migration', () => {
  // The v3 fixture keeps the retired `category NOT NULL` column — that IS the v3
  // shape on disk. Opening it now runs v4 (add start_date) AND v5 (project-only),
  // so this doubles as an end-to-end v3→v5 upgrade check.
  it('adds the start_date column to a real v3 database and keeps data intact', async () => {
    // Build a genuine v3 DB: tasks table WITHOUT start_date + user_version=3,
    // then let the normal open path run the ALTER TABLE branch.
    const { default: Database } = await import('better-sqlite3');
    const { TASK_DB_PATH } = await import('../../src/core/task-db.js');
    const fsSync = await import('node:fs');
    const pathMod = await import('node:path');
    fsSync.mkdirSync(pathMod.dirname(TASK_DB_PATH), { recursive: true });
    const raw = new Database(TASK_DB_PATH);
    // Full v3 column set (matches SCHEMA_SQL minus start_date) — the open path
    // also creates indexes over these columns, so a partial table won't do.
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, project TEXT,
      status TEXT, phase TEXT, priority TEXT, source TEXT, parent_task_id TEXT,
      due_date TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT,
      sprint TEXT, focus_tier TEXT, pinned INTEGER DEFAULT 0, ext TEXT, tags TEXT,
      depends_on TEXT, session_ids TEXT, note TEXT, summary TEXT, description TEXT,
      conversation_log TEXT, sync_error TEXT, _synced_at TEXT, payload TEXT
    );`);
    raw.prepare(`INSERT INTO tasks (id, title, status, phase, priority, category, project, created_at, updated_at)
      VALUES ('mig-1', 'Pre-migration task', 'todo', 'TODO', 'none', 'Work', 'Marina', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
    raw.pragma('user_version = 3');
    raw.close();

    // Reopen through the real open path → migration must add the column.
    const { getDb } = await import('../../src/core/task-db.js');
    const db = getDb()!;
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    expect(cols.some((c) => c.name === 'start_date')).toBe(true);
    // v5 also ran: the category column is gone and the project survived.
    expect(cols.some((c) => c.name === 'category')).toBe(false);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(5);
    const row = db.prepare(`SELECT title, project, start_date FROM tasks WHERE id='mig-1'`).get() as { title: string; project: string; start_date: string | null };
    expect(row.title).toBe('Pre-migration task');
    expect(row.project).toBe('Marina');
    expect(row.start_date).toBeNull();
  });
});

describe('projection export shape', () => {
  it('projected task carries start_date', async () => {
    const { task } = await addTask({
      title: 'Projected', project: 'Marina', start_date: SAME_DAY,
    });
    const { exportTaskProjection, readTaskProjection } = await import('../../src/core/task-projection.js');
    await exportTaskProjection();
    const proj = await readTaskProjection();
    const row = proj?.tasks.find((t) => t.id === task.id);
    expect(row?.start_date).toBe(SAME_DAY);
  });
});
