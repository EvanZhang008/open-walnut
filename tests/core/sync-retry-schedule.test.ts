/**
 * Step 1.5 of a plugin's sync tick: which failed pushes get retried, and how often.
 *
 * Two halves. The pure schedule (backoff + ordering), and the SQL behind it
 * (`listSyncErrorTasks`), which used to exclude completed tasks: a task closed while its
 * plugin was down stayed open in the tracker for a week because the one retry path
 * skipped exactly the rows that mattered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';
import { SyncRetrySchedule } from '../../src/core/sync-retry-schedule.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-retry-schedule'));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
  unlinkSessionsFromTasks: vi.fn(async () => 0),
  relinkSessionsToTask: vi.fn(async () => 0),
  completeTaskSessions: vi.fn(async () => 0),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import {
  _resetForTesting,
  addTasksBulk,
  listTasks,
  listSyncErrorTasks,
} from '../../src/core/task-manager.js';
import { closeDb, getDb } from '../../src/core/task-db.js';
import { setExtIndexes, _resetForTesting as resetExtRegistry } from '../../src/core/ext-index-registry.js';
import type { Task } from '../../src/core/types.js';

const MIN = 60_000;

describe('SyncRetrySchedule', () => {
  const t = (id: string) => ({ id });

  it('never-tried candidates are all due, in the order given, capped at the limit', () => {
    const s = new SyncRetrySchedule();
    expect(s.pick([t('a'), t('b'), t('c')], 2, 0)).toEqual([t('a'), t('b')]);
  });

  it('a failure pushes the task out of the next batch so the ones behind it get a turn', () => {
    // The starvation case: five permanently failing rows at the top of the table used to
    // fill the batch of five every minute, forever.
    const s = new SyncRetrySchedule({ baseMs: MIN });
    const all = ['p1', 'p2', 'p3', 'p4', 'p5', 'ok1', 'ok2'].map(t);
    expect(s.pick(all, 5, 0).map((x) => x.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) s.noteFailure(id, 0);
    expect(s.pick(all, 5, 1_000).map((x) => x.id)).toEqual(['ok1', 'ok2']);
  });

  it('backs off exponentially per consecutive failure, capped at maxMs', () => {
    const s = new SyncRetrySchedule({ baseMs: MIN, maxMs: 10 * MIN });
    const c = [t('a')];
    s.noteFailure('a', 0);            // wait 1 min
    expect(s.pick(c, 1, MIN - 1)).toEqual([]);
    expect(s.pick(c, 1, MIN)).toEqual([t('a')]);
    s.noteFailure('a', MIN);          // wait 2 min
    expect(s.pick(c, 1, 2 * MIN + MIN - 1)).toEqual([]);
    expect(s.pick(c, 1, 3 * MIN)).toEqual([t('a')]);
    s.noteFailure('a', 3 * MIN);      // 4 min
    s.noteFailure('a', 7 * MIN);      // 8 min
    s.noteFailure('a', 15 * MIN);     // 16 min → capped to 10
    expect(s.attemptsOf('a')).toBe(5);
    expect(s.pick(c, 1, 15 * MIN + 10 * MIN - 1)).toEqual([]);
    expect(s.pick(c, 1, 25 * MIN)).toEqual([t('a')]);
  });

  it('a success resets the task to never-tried', () => {
    const s = new SyncRetrySchedule({ baseMs: MIN });
    s.noteFailure('a', 0);
    s.noteFailure('a', 0);
    s.noteSuccess('a');
    expect(s.attemptsOf('a')).toBe(0);
    expect(s.pick([t('a')], 1, 0)).toEqual([t('a')]);
  });

  it('due tasks come back oldest-due first', () => {
    const s = new SyncRetrySchedule({ baseMs: MIN });
    s.noteFailure('late', 5 * MIN);   // due at 6 min
    s.noteFailure('early', 0);        // due at 1 min
    expect(s.pick([t('late'), t('early'), t('fresh')], 3, 10 * MIN).map((x) => x.id))
      .toEqual(['fresh', 'early', 'late']);
  });

  it('forgets tasks that left the candidate set', () => {
    const s = new SyncRetrySchedule({ baseMs: MIN });
    s.noteFailure('gone', 0);
    s.pick([t('other')], 5, 0);
    expect(s.attemptsOf('gone')).toBe(0);
  });
});

describe('listSyncErrorTasks', () => {
  const SOURCE = 'tracker';
  const SPEC = { source: SOURCE, paths: [{ key: 'id', json: '$.tracker.id' }] };

  function makeTask(id: string, overrides: Partial<Task> = {}): Task {
    return {
      id,
      title: `Task ${id}`,
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      project: 'Proj',
      source: SOURCE,
      session_ids: [],
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      description: '',
      summary: '',
      note: '',
      ext: { tracker: { id: `remote-${id}` } },
      ...overrides,
    } as unknown as Task;
  }

  beforeEach(async () => {
    closeDb();
    _resetForTesting();
    resetExtRegistry();
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    setExtIndexes([SPEC]);
    await listTasks();
  });

  afterEach(() => {
    closeDb();
    _resetForTesting();
    resetExtRegistry();
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('includes completed tasks, newest edit first: a close that never reached the tracker must be retried', async () => {
    await addTasksBulk([
      makeTask('open-err', { updated_at: '2026-08-12T00:00:00Z' }),
      makeTask('done-err', { status: 'done', phase: 'COMPLETE', completed_at: '2026-09-04T05:47:32Z', updated_at: '2026-09-04T05:47:32Z' }),
      makeTask('done-ok', { status: 'done', phase: 'COMPLETE' }),
      makeTask('never-pushed', { ext: {} }),
    ]);
    // sync_error is stamped by the push path, not by addTasksBulk; write it directly.
    const db = getDb()!;
    db.prepare(`UPDATE tasks SET sync_error = 'Plugin "tracker" not loaded — task not synced' WHERE id IN ('open-err', 'done-err', 'never-pushed')`).run();
    _resetForTesting();

    const ids = (await listSyncErrorTasks(SOURCE)).map((t) => t.id);
    // never-pushed has no remote id: that is listUnsyncedTasks' job (createTask, not push).
    expect(ids).toEqual(['done-err', 'open-err']);
  });
});
