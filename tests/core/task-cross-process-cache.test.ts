/**
 * Regression tests for the 2026-08-04 task-loss incident: a second server
 * process sharing the same tasks.sqlite silently DELETED tasks the first
 * process created, because
 *   (a) the whole-store cache (taskStoreCache) was only invalidated by the
 *       process's OWN writes — an external commit left it stale, and
 *   (b) writeStore() persists a full snapshot and deletes rows absent from it,
 *       so a stale snapshot erased the other process's new rows.
 *
 * Fix under test: readStore() drops the cache when `PRAGMA data_version`
 * moved (an external connection committed), so a subsequent read-modify-write
 * sees — and therefore preserves — externally created rows.
 *
 * The single-instance server lock (instance-lock.ts) is tested separately;
 * this file proves the DATA layer survives a rogue second writer anyway.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-xproc-cache'));

import { closeDb, TASK_DB_PATH } from '../../src/core/task-db.js';
import {
  _resetForTesting,
  addTask,
  listTasks,
  updateTask,
} from '../../src/core/task-manager.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

async function resetAll(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
}

beforeEach(resetAll);
afterEach(async () => {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

/**
 * Simulate the OTHER server process: a separate better-sqlite3 connection
 * (separate connection == separate data_version domain) inserting a row the
 * way writeStore() would.
 */
function externalInsert(id: string, title: string): void {
  const ext = new Database(TASK_DB_PATH);
  try {
    ext.prepare(
      `INSERT INTO tasks (id, title, project, status, phase, priority, source, created_at, updated_at)
       VALUES (?, ?, 'Local', 'todo', 'TODO', 'none', 'local', ?, ?)`,
    ).run(id, title, new Date().toISOString(), new Date().toISOString());
  } finally {
    ext.close();
  }
}

describe('cross-process store-cache invalidation', () => {
  it('readStore sees a row committed by another connection (stale cache dropped)', async () => {
    await addTask({ title: 'ours', project: 'Local' }); // fills the cache
    await listTasks(); // cache hit path

    externalInsert('xproc-created-1', 'created by the other server');

    const titles = (await listTasks()).map((t) => t.title);
    expect(titles).toContain('created by the other server');
  });

  it('a read-modify-write after an external commit PRESERVES the external row', async () => {
    // The incident shape: process A creates a task; process B (stale cache)
    // then runs any whole-store helper (updateTask → writeStore). Before the
    // fix, B's snapshot lacked A's row and writeStore deleted it.
    const { task: ours } = await addTask({ title: 'ours', project: 'Local' });
    await listTasks(); // ensure cache is populated pre-external-write

    externalInsert('xproc-created-2', 'fork made via the other server');

    await updateTask(ours.id, { note: 'trigger whole-store rewrite' });

    // The external row must have survived the full-snapshot rewrite.
    const ids = (await listTasks()).map((t) => t.id);
    expect(ids).toContain('xproc-created-2');
    expect(ids).toContain(ours.id);
  });

  it('own writes still serve from cache (data_version unmoved by our commits)', async () => {
    const { task } = await addTask({ title: 'cache check', project: 'Local' });
    // Two consecutive reads with no external writer — second must not lose data
    // (sanity that the version check doesn't thrash correctness).
    const first = await listTasks();
    const second = await listTasks();
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(second.some((t) => t.id === task.id)).toBe(true);
  });
});
