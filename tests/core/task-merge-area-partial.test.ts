/**
 * A batch merge whose second victim is classified into an area after the first victim was
 * already merged (task-manager.ts mergeTasksIntoNow): the first stays merged (never rolled back),
 * the second and the rest are not, and both the core error and the HTTP answer say exactly that.
 *
 * The barrier is the first merge's session relink, the step right after its task commit: the
 * wrapped relinkSessionsToTask marks the second victim there and only then returns, so the second
 * merge's area check is guaranteed to see the mark. No sleeps. Real task and session stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-merge-area-partial'));

const barrier = vi.hoisted(() => ({ onRelink: null as null | ((from: string) => Promise<void>) }));
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-tracker.js')>();
  return {
    ...real,
    relinkSessionsToTask: async (...args: Parameters<typeof real.relinkSessionsToTask>) => {
      const moved = await real.relinkSessionsToTask(...args);
      if (barrier.onRelink) await barrier.onRelink(args[0]);
      return moved;
    },
  };
});

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../src/constants.js';
import {
  _resetForTesting, addTask, getTask, mergeTasksInto, updateTaskRaw, AreaMergeRefusedError,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import { tasksRouter } from '../../src/web/routes/tasks.js';
import { errorHandler } from '../../src/web/middleware/error-handler.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/tasks', tasksRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  closeDb();
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
  barrier.onRelink = null;
});

afterEach(() => {
  barrier.onRelink = null;
  closeDb();
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** A survivor with no session, three ordinary victims; the second is marked at the first relink. */
async function setup() {
  const { task: survivor } = await addTask({ title: 'Survivor', project: '', source: 'local' });
  const victims = [];
  for (const title of ['Copy one', 'Copy two', 'Copy three']) victims.push((await addTask({ title, project: '', source: 'local' })).task);
  const [v1, v2, v3] = victims as [typeof survivor, typeof survivor, typeof survivor];
  await createSessionRecord('copy-one-sid', v1.id, '', '/tmp', { initialProcessStatus: 'stopped' });
  await updateTaskRaw(v1.id, { session_id: 'copy-one-sid', session_ids: ['copy-one-sid'] });
  let marked = false;
  barrier.onRelink = async (from) => {
    if (from !== v1.id || marked) return;
    marked = true;
    await updateTaskRaw(v2.id, { router_area_id: 'personal' }, { source: 'router-areas' });
  };
  return { survivor, v1, v2, v3, wasMarked: () => marked };
}

describe('a victim classified into an area mid-batch', () => {
  it('core: keeps the first merge, refuses the second, does not try the third, and says so', async () => {
    const { survivor, v1, v2, v3, wasMarked } = await setup();
    const err = await mergeTasksInto(survivor.id, [v1.id, v2.id, v3.id]).then(() => null, (e: unknown) => e);
    expect(wasMarked()).toBe(true);
    expect(err).toBeInstanceOf(AreaMergeRefusedError);
    const refused = err as AreaMergeRefusedError;
    expect(refused).toMatchObject({ code: 'area_merge_refused', status: 409, role: 'victim', taskId: v2.id });
    expect(refused.partial).toEqual({ mergedIds: [v1.id], sessionsRelinked: 1, notMerged: [], notAttempted: [v3.id] });
    expect(refused.message).toMatch(/1 earlier victim was already merged/);
    expect(refused.message).not.toMatch(/Nothing was merged/);
    // What happened stays: v1 merged (its session moved), v2 and v3 untouched.
    await expect(getTask(v1.id)).rejects.toThrow(/No task found/);
    expect((await getSessionByClaudeId('copy-one-sid'))?.taskId).toBe(survivor.id);
    expect((await getTask(v2.id)).router_area_id).toBe('personal');
    expect((await getTask(v3.id)).id).toBe(v3.id);
  });

  it('HTTP: answers 409 with the victims merged, the refused one and the ones not tried', async () => {
    const { survivor, v1, v2, v3 } = await setup();
    const res = await request(app()).post(`/api/tasks/${survivor.id}/merge`).send({ victim_ids: [v1.id, v2.id, v3.id] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'area_merge_refused', role: 'victim', task_id: v2.id,
      merged: 1, merged_ids: [v1.id], sessions_relinked: 1,
      refused: [{ id: v2.id, role: 'victim' }], not_attempted: [v3.id],
    });
    expect(res.body.error).toMatch(/already merged/);
    expect(res.body.not_merged).toBeUndefined();
  });
});
