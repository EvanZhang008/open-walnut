/**
 * The task store cache is WRITE-THROUGH: a row-level writer patches the cached
 * snapshot instead of dropping it, and the composable query serves its
 * candidates from that snapshot while it is current.
 *
 * Why this matters: with ~6.5k tasks on a real board, every drop cost the next
 * reader a `SELECT *` + rowToTask over the whole table (250ms idle, over 1s on
 * a loaded machine) on the one event loop every route shares. Row writes happen
 * on every session activity, so the rescan ran several times a minute and was
 * the largest measured share of main-thread CPU on the live server (2026-09-29).
 *
 * The invariants pinned here:
 *   1. a row write is visible to the next read WITHOUT a full scan
 *   2. a write from ANOTHER connection still forces a rescan (data_version)
 *   3. the query's cache path and its SQL path answer identically
 *   4. what a reader gets back is a copy: mutating it never reaches the cache
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-write-through'));

import {
  addTask,
  addTasksBulk,
  deleteTasksBulk,
  getTask,
  listTasks,
  queryTasksPage,
  queryTasksSlimPage,
  touchLastSessionUpdate,
  updateNote,
  updateTaskRaw,
  updateTasksBulk,
  _dropTaskStoreCacheForTesting,
  _resetForTesting,
  _storeStatsForTesting,
} from '../../src/core/task-manager.js';
import { TASK_DB_PATH } from '../../src/core/task-db.js';

const scans = () => _storeStatsForTesting().fullScans;

describe('task store write-through', () => {
  beforeAll(() => { _resetForTesting(); });

  it('a per-row write is visible at once and costs no full scan', async () => {
    const { task } = await addTask({ title: 'row write', project: 'Local', source: 'local' });
    await listTasks();
    const before = scans();

    await updateTaskRaw(task.id, { title: 'row write 2' });
    expect((await getTask(task.id)).title).toBe('row write 2');
    expect((await listTasks()).find((t) => t.id === task.id)?.title).toBe('row write 2');

    await touchLastSessionUpdate(task.id);
    expect((await getTask(task.id)).last_session_update).toBeTruthy();

    await updateNote(task.id, 'a note');
    expect((await getTask(task.id)).note).toBe('a note');

    expect(scans()).toBe(before);
  });

  it('bulk add, bulk patch and bulk delete keep the snapshot coherent without a scan', async () => {
    await listTasks();
    const before = scans();
    const now = new Date().toISOString();
    const created = await addTasksBulk([
      { title: 'bulk a', project: 'Local', source: 'local', status: 'active', phase: 'TODO', priority: 'none', created_at: now, updated_at: now } as never,
      { title: 'bulk b', project: 'Local', source: 'local', status: 'active', phase: 'TODO', priority: 'none', created_at: now, updated_at: now } as never,
    ]);
    const ids = created.map((t) => t.id);
    let listed = await listTasks();
    expect(ids.every((id) => listed.some((t) => t.id === id))).toBe(true);

    await updateTasksBulk(ids.map((id) => ({ id, patch: { title: 'bulk patched' } })));
    listed = await listTasks();
    expect(listed.filter((t) => ids.includes(t.id)).map((t) => t.title)).toEqual(['bulk patched', 'bulk patched']);

    await deleteTasksBulk([ids[0]]);
    listed = await listTasks();
    expect(listed.some((t) => t.id === ids[0])).toBe(false);
    expect(listed.some((t) => t.id === ids[1])).toBe(true);
    await expect(getTask(ids[0])).rejects.toThrow();

    expect(scans()).toBe(before);
  });

  it('a write from another connection forces a rescan and is not hidden by the cache', async () => {
    const { task } = await addTask({ title: 'foreign before', project: 'Local', source: 'local' });
    await listTasks();
    const before = scans();

    const other = new Database(TASK_DB_PATH);
    try {
      other.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('foreign after', task.id);
    } finally {
      other.close();
    }

    expect((await getTask(task.id)).title).toBe('foreign after');
    expect(scans()).toBe(before + 1);
    // The query path must not read a stale snapshot either.
    const page = await queryTasksSlimPage({ ids: [task.id] }, { minimal: true });
    expect(page.tasks[0]?.title).toBe('foreign after');
  });

  it('the query answers the same from the cache and from SQL, for every projection', async () => {
    const stamp = Date.now().toString(36);
    const { task: withNote } = await addTask({ title: `eq note ${stamp}`, project: 'Equal', source: 'local', description: 'desc', tags: ['eq'] });
    await updateNote(withNote.id, 'note body');
    await updateTaskRaw(withNote.id, { conversation_log: 'log line', summary: 'sum', ext: { local: { id: 'x' } } as never });
    const { task: synced } = await addTask({ title: `eq synced ${stamp}`, project: 'Equal', source: 'local' });
    await updateTaskRaw(synced.id, { source: 'remote' as never, ext: { remote: { id: 'r1' } } as never, due_date: '2026-10-01' });
    const { task: bare } = await addTask({ title: `eq bare ${stamp}`, project: 'Equal', source: 'local' });
    await updateTaskRaw(bare.id, { ext: {} as never, conversation_log: '' });
    const { task: done } = await addTask({ title: `eq done ${stamp}`, project: 'Equal', source: 'local' });
    await updateTaskRaw(done.id, { phase: 'COMPLETE', status: 'completed', completed_at: new Date().toISOString() });

    const queries = [
      { projects: ['Equal'] },
      { projects: ['Equal'], completion: ['todo', 'in_progress'] },
      { projects: ['Equal'], q: 'eq' },
      { projects: ['Equal'], tagsAny: ['eq'] },
      { projects: ['Equal'], sort: 'title_asc' as const, limit: 2 },
      { ids: [withNote.id, synced.id, bare.id, done.id] },
    ];
    for (const query of queries) {
      await listTasks(); // warm: the cache path
      const warm = {
        full: await queryTasksPage(query as never),
        slim: await queryTasksSlimPage(query as never),
        minimal: await queryTasksSlimPage(query as never, { minimal: true }),
      };
      _dropTaskStoreCacheForTesting(); // cold: the SQL path
      const scansBefore = scans();
      const cold = {
        full: await queryTasksPage(query as never),
        slim: await queryTasksSlimPage(query as never),
        minimal: await queryTasksSlimPage(query as never, { minimal: true }),
      };
      expect(scans()).toBe(scansBefore);
      expect(cold).toEqual(warm);
      expect(warm.full.tasks.length).toBeGreaterThan(0);
    }

    // The presence flags themselves, spelled out once.
    await listTasks();
    const minimal = (await queryTasksSlimPage({ ids: [withNote.id, synced.id, bare.id] }, { minimal: true })).tasks;
    const flags = (id: string) => {
      const t = minimal.find((x) => x.id === id)!;
      return [t.has_note, t.has_conversation_log, t.has_summary, t.has_description, t.has_ext, t.has_synced];
    };
    expect(flags(withNote.id)).toEqual([true, true, true, true, true, false]);
    expect(flags(synced.id)).toEqual([false, false, false, false, true, true]);
    expect(flags(bare.id)).toEqual([false, false, false, false, false, false]);
    expect('note' in minimal[0]).toBe(false);
    expect('summary' in minimal[0]).toBe(false);
  });

  it('hands out copies: mutating a result never reaches the snapshot', async () => {
    const { task } = await addTask({ title: 'isolated', project: 'Local', source: 'local' });
    await listTasks();
    const got = await getTask(task.id);
    got.title = 'mutated in place';
    expect((await getTask(task.id)).title).toBe('isolated');
    const listed = (await listTasks()).find((t) => t.id === task.id)!;
    listed.title = 'mutated in list';
    expect((await getTask(task.id)).title).toBe('isolated');
    const queried = (await queryTasksPage({ ids: [task.id] })).tasks[0];
    queried.title = 'mutated in query';
    expect((await getTask(task.id)).title).toBe('isolated');
  });
});
