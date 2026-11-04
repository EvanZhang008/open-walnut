/**
 * Batch (multi-select) task endpoints — POST /api/tasks/batch/phase and
 * POST /api/tasks/batch/delete.
 *
 * These exist because the Todo panel's multi-select bar had NO complete/delete path:
 * the batch dropdown only offered pin/priority/date, so "select 10 tasks → complete"
 * was impossible. See tests/core/task-batch-ops.test.ts for the store-level semantics.
 *
 * Route-level concerns covered here:
 *  - the `/batch/*` paths are matched as BATCH routes, not as `/:id` with id="batch"
 *    (they're registered before `/:id` for exactly that reason)
 *  - partial success is 200 with { changed|deleted, failed[] } — never 409/500 just
 *    because one task in the selection was rejected
 *  - request validation (empty/non-array task_ids, bad phase)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, getTask, listTasks, linkSession, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  closeDb();
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  closeSessionDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function makeTasks(titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const { task } = await addTask({ title, project: 'Marina' });
    ids.push(task.id);
  }
  return ids;
}

describe('POST /api/tasks/batch/phase', () => {
  it('completes every task in the selection', async () => {
    const ids = await makeTasks(['A', 'B', 'C']);

    const res = await request(createApp())
      .post('/api/tasks/batch/phase')
      .send({ task_ids: ids, phase: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(res.body.changed).toHaveLength(3);
    expect(res.body.failed).toEqual([]);
    for (const id of ids) {
      expect((await getTask(id)).phase).toBe('COMPLETE');
    }
  });

  it('reopens done tasks', async () => {
    const ids = await makeTasks(['A', 'B']);
    const app = createApp();
    await request(app).post('/api/tasks/batch/phase').send({ task_ids: ids, phase: 'COMPLETE' });

    const res = await request(app).post('/api/tasks/batch/phase').send({ task_ids: ids, phase: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toHaveLength(2);
    for (const id of ids) {
      expect((await getTask(id)).phase).toBe('TODO');
    }
  });

  it('returns 200 with failed[] when one task cannot change — the rest still apply', async () => {
    // A parent with an open child completes too (2026-10-04); the child is untouched.
    const [parent, sibling] = await makeTasks(['Parent', 'Sibling']);
    const { task: child } = await addTask({ title: 'Child', project: 'Marina', parent_task_id: parent });

    const res = await request(createApp())
      .post('/api/tasks/batch/phase')
      .send({ task_ids: [parent, 'zzzzzzzz', sibling], phase: 'COMPLETE' });

    // Partial success must NOT be an error status — the client needs the successes.
    expect(res.status).toBe(200);
    expect(res.body.changed.map((t: { id: string }) => t.id).sort()).toEqual([parent, sibling].sort());
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe('zzzzzzzz');
    expect((await getTask(sibling)).phase).toBe('COMPLETE');
    expect((await getTask(parent)).phase).toBe('COMPLETE');
    expect((await getTask(child.id)).phase).not.toBe('COMPLETE');
  });

  it('rejects a missing/empty task_ids array', async () => {
    const app = createApp();
    for (const body of [{ phase: 'COMPLETE' }, { task_ids: [], phase: 'COMPLETE' }, { task_ids: 'x', phase: 'COMPLETE' }]) {
      const res = await request(app).post('/api/tasks/batch/phase').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/task_ids/);
    }
  });

  it('rejects an invalid phase', async () => {
    const ids = await makeTasks(['A']);
    const res = await request(createApp())
      .post('/api/tasks/batch/phase')
      .send({ task_ids: ids, phase: 'NOT_A_PHASE' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phase must be one of/);
    expect((await getTask(ids[0])).phase).toBe('TODO');
  });

  it('reports an external-sync failure in syncFailed, keeping failed empty', async () => {
    // Plugin-sourced task, no plugin loaded: the phase change lands locally, only the
    // push fails. `failed` must stay empty or the client rolls back a correct row.
    const { task } = await addTask({ title: 'Remote task', project: 'Remote', source: 'ms-todo' })

    const res = await request(createApp())
      .post('/api/tasks/batch/phase')
      .send({ task_ids: [task.id], phase: 'COMPLETE' })

    expect(res.status).toBe(200)
    expect(res.body.changed).toHaveLength(1)
    expect(res.body.failed).toEqual([])
    expect(res.body.syncFailed).toHaveLength(1)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  })

  it('is matched as a batch route, not as PATCH /:id with id="batch"', async () => {
    // Regression guard for route ordering: `/batch/*` is registered before `/:id`.
    const res = await request(createApp())
      .post('/api/tasks/batch/phase')
      .send({ task_ids: ['nope'], phase: 'COMPLETE' });

    // Reaches the batch handler (200 + failed[]), not a 404 "no task matching batch".
    expect(res.status).toBe(200);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].error).toMatch(/No task found/);
  });
});

describe('POST /api/tasks/batch/delete with delay_ms (a held delete a page hands over as it goes)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A cancel that must reach the server inside the delay gets 2 s of it: on a loaded host one
  // request can take longer than 150 ms, and the schedule would end before the cancel lands.

  it('deletes them once the delay ends, not before', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const res = await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms: 150 });
    expect(res.status).toBe(202);
    expect(res.body.scheduled).toEqual([a]);
    expect((await listTasks()).map((t) => t.id).sort()).toEqual([a, b].sort());
    await expect.poll(async () => (await listTasks()).map((t) => t.id), { timeout: 10_000 }).toEqual([b]);
  });

  it('a cancel inside the delay keeps them, and says which it took back', async () => {
    const [a] = await makeTasks(['A']);
    await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms: 2_000 });
    const res = await request(createApp()).post('/api/tasks/batch/delete/cancel').send({ task_ids: [a, 'no-such-task'] });
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toEqual([a]);
    await wait(2_500);
    expect((await listTasks()).map((t) => t.id)).toEqual([a]);
  });

  it('a delete sent now takes the place of the scheduled one (it never runs twice)', async () => {
    const [a] = await makeTasks(['A']);
    await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms: 2_000 });
    const now = await request(createApp()).delete(`/api/tasks/${a}`);
    expect(now.status).toBe(204);
    const cancel = await request(createApp()).post('/api/tasks/batch/delete/cancel').send({ task_ids: [a] });
    expect(cancel.body.cancelled).toEqual([]);
  });

  it('a schedule that reaches the server after its hold was cancelled is ignored; a later hold still schedules', async () => {
    const [a] = await makeTasks(['A']);
    const heldAt = Date.now();
    // The returning page's cancel overtakes the going page's POST.
    const cancel = await request(createApp()).post('/api/tasks/batch/delete/cancel').send({ task_ids: [a], held_at: heldAt });
    expect(cancel.body.cancelled).toEqual([]);
    const late = await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms: 150, held_at: heldAt });
    expect(late.status).toBe(202);
    expect(late.body.scheduled).toEqual([]);
    await wait(400);
    expect((await listTasks()).map((t) => t.id)).toEqual([a]);
    // Deleted again later: a newer hold is not the one taken back.
    const again = await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms: 150, held_at: heldAt + 5_000 });
    expect(again.body.scheduled).toEqual([a]);
    await expect.poll(listTasks, { timeout: 10_000 }).toEqual([]);
  });

  it('a late cancel of an older hold leaves a newer delete of the same task scheduled', async () => {
    const [a] = await makeTasks(['A']);
    const first = Date.now();
    // Deleted, undone (its cancel delayed), deleted again: the newer hold is on the server.
    await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms: 150, held_at: first + 500 });
    const late = await request(createApp()).post('/api/tasks/batch/delete/cancel').send({ task_ids: [a], held_at: first });
    expect(late.body.cancelled).toEqual([]);
    await expect.poll(listTasks, { timeout: 10_000 }).toEqual([]);
  });

  it('a cancel of one keeps the rest of the same schedule, deleted together when it ends', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a, b], delay_ms: 2_000 });
    await request(createApp()).post('/api/tasks/batch/delete/cancel').send({ task_ids: [a] });
    await expect.poll(async () => (await listTasks()).map((t) => t.id).sort(), { timeout: 10_000 }).toEqual([a, c].sort());
  });

  it('refuses more ids than a schedule may carry', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `t-${i}`);
    expect((await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: ids, delay_ms: 150 })).status).toBe(400);
    expect((await request(createApp()).post('/api/tasks/batch/delete/cancel').send({ task_ids: ids })).status).toBe(400);
  });

  it('refuses a delay that is not a sensible number of ms', async () => {
    const [a] = await makeTasks(['A']);
    for (const delay_ms of [0, -5, 'soon', 600_000]) {
      const res = await request(createApp()).post('/api/tasks/batch/delete').send({ task_ids: [a], delay_ms });
      expect(res.status, String(delay_ms)).toBe(400);
    }
    expect((await listTasks()).map((t) => t.id)).toEqual([a]);
  });
});

describe('POST /api/tasks/batch/delete', () => {
  it('deletes every task in the selection', async () => {
    const ids = await makeTasks(['A', 'B', 'C']);

    const res = await request(createApp())
      .post('/api/tasks/batch/delete')
      .send({ task_ids: ids });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toHaveLength(3);
    expect(res.body.failed).toEqual([]);
    expect(await listTasks()).toHaveLength(0);
  });

  it('leaves unselected tasks alone', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);

    const res = await request(createApp())
      .post('/api/tasks/batch/delete')
      .send({ task_ids: [a, c] });

    expect(res.status).toBe(200);
    const remaining = await listTasks();
    expect(remaining.map((t) => t.id)).toEqual([b]);
  });

  it('returns 200 with failed[] for a task with an active session — the rest still delete', async () => {
    const [busy, free] = await makeTasks(['Busy', 'Free']);
    await createSessionRecord('sess-route-batch', busy, 'Marina', undefined, { initialProcessStatus: 'running' });
    await linkSession(busy, 'sess-route-batch');

    const res = await request(createApp())
      .post('/api/tasks/batch/delete')
      .send({ task_ids: [busy, free] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toHaveLength(1);
    expect(res.body.deleted[0].id).toBe(free);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].error).toMatch(/active session/i);
    expect((await listTasks()).map((t) => t.id)).toEqual([busy]);
  });

  it('force=true deletes a task with an active session', async () => {
    const [busy] = await makeTasks(['Busy']);
    await createSessionRecord('sess-route-batch-force', busy, 'Marina', undefined, { initialProcessStatus: 'running' });
    await linkSession(busy, 'sess-route-batch-force');

    const res = await request(createApp())
      .post('/api/tasks/batch/delete')
      .send({ task_ids: [busy], force: true });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toHaveLength(1);
    expect(res.body.failed).toEqual([]);
    expect(await listTasks()).toHaveLength(0);
  });

  it('rejects a missing/empty task_ids array', async () => {
    const app = createApp();
    for (const body of [{}, { task_ids: [] }, { task_ids: 42 }]) {
      const res = await request(app).post('/api/tasks/batch/delete').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/task_ids/);
    }
  });
});
