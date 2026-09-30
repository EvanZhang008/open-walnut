/**
 * GET /api/tasks answers with the same blocked flags and session status in
 * every projection, from one id map and one session read per request.
 *
 * Why: the handler used to rebuild a map over every listed task for each task
 * with dependencies (isTaskBlocked per row) and copy the whole session store
 * to enrich a handful of rows. These cases pin the response those shortcuts
 * must not change: is_blocked is set only on tasks with dependencies, is
 * judged against the LISTED tasks (a dependency outside the list does not
 * block), and the session pills still find sessions linked only by taskId.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-tasks-list-blocked'));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import {
  addTask,
  completeTask,
  isTaskBlocked,
  linkSessionSlot,
  updateTask,
  _resetForTesting,
} from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import {
  createSessionRecord,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
  _sessionStoreStatsForTesting,
} from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import type { Task } from '../../../src/core/types.js';

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

interface Board {
  open: string; done: string; outside: string;
  blockedByOpen: string; freeByDone: string; mixed: string; blockedOutside: string; plain: string;
}

/** Dependencies in every state, plus sessions linked by slot, by taskId only, and archived. */
async function seedBoard(): Promise<Board> {
  const id = async (title: string, project = 'Main') => (await addTask({ title, project })).task.id;
  const b: Board = {
    open: await id('Open prerequisite'),
    done: await id('Done prerequisite'),
    outside: await id('Prerequisite in another project', 'Other'),
    blockedByOpen: '', freeByDone: '', mixed: '', blockedOutside: '', plain: '',
  };
  await completeTask(b.done);
  b.blockedByOpen = await id('Waits on the open one');
  b.freeByDone = await id('Waits on the done one');
  b.mixed = await id('Waits on both');
  b.blockedOutside = await id('Waits on another project');
  b.plain = await id('No dependencies');
  await updateTask(b.blockedByOpen, { add_depends_on: [b.open] });
  await updateTask(b.freeByDone, { add_depends_on: [b.done] });
  await updateTask(b.mixed, { add_depends_on: [b.done, b.open] });
  await updateTask(b.blockedOutside, { add_depends_on: [b.outside] });

  await createSessionRecord('sess-slot', b.blockedByOpen, 'Main', undefined, { initialProcessStatus: 'running' });
  await linkSessionSlot(b.blockedByOpen, 'sess-slot', 'exec');
  // Linked only through the session record: the enrichment must still find it.
  await createSessionRecord('sess-orphan', b.plain, 'Main', undefined, { initialProcessStatus: 'idle' });
  await createSessionRecord('sess-archived', b.plain, 'Main', undefined, { initialProcessStatus: 'stopped' });
  await updateSessionRecord('sess-archived', { archived: true });
  // Sessions of unrelated tasks and stopped history rows the list never shows.
  for (let i = 0; i < 12; i++) {
    await createSessionRecord(`sess-other-${i}`, `unlisted-task-${i}`, 'Else', undefined, { initialProcessStatus: 'stopped' });
  }
  return b;
}

const byId = (tasks: Array<Record<string, any>>) => new Map(tasks.map((t) => [t.id as string, t]));

describe('GET /api/tasks blocked flags and session status', () => {
  for (const [label, query] of [['full', ''], ['slim', '?slim=1'], ['list', '?fields=list']] as const) {
    it(`answers the ${label} projection with the old per-task blocked rule`, async () => {
      const b = await seedBoard();
      const res = await request(createApp()).get(`/api/tasks${query}`);
      expect(res.status).toBe(200);
      const tasks = res.body.tasks as Array<Record<string, any>>;
      const rows = byId(tasks);
      expect(rows.size).toBe(8);

      expect(rows.get(b.blockedByOpen)!.is_blocked).toBe(true);
      expect(rows.get(b.freeByDone)!.is_blocked).toBe(false);
      expect(rows.get(b.mixed)!.is_blocked).toBe(true);
      expect(rows.get(b.blockedOutside)!.is_blocked).toBe(true);
      for (const key of ['open', 'done', 'outside', 'plain'] as const) {
        expect(rows.get(b[key])!, key).not.toHaveProperty('is_blocked');
      }
      // The same answer the per-task isTaskBlocked gives against the listed rows.
      for (const t of tasks) {
        if (!t.depends_on?.length) continue;
        expect(t.is_blocked, t.title).toBe(isTaskBlocked(t as Task, tasks as Task[]));
      }

      const slot = rows.get(b.blockedByOpen)!;
      expect(slot.session_id).toBe('sess-slot');
      expect(slot.session_status?.process_status).toBe('running');
      expect(slot.exec_session_status?.process_status).toBe('running');

      const plain = rows.get(b.plain)!;
      expect(plain.session_ids).toEqual(['sess-orphan']);
      expect(plain.session_history_count).toBe(2);
      expect(plain.session_id).toBe('sess-orphan');
      expect(plain.session_status?.process_status).toBe('idle');
    });
  }

  it('judges a dependency outside the listed tasks as not blocking, as before', async () => {
    const b = await seedBoard();
    const res = await request(createApp()).get('/api/tasks?fields=list&project=Main');
    expect(res.status).toBe(200);
    const rows = byId(res.body.tasks);
    expect(rows.has(b.outside)).toBe(false);
    expect(rows.get(b.blockedOutside)!.is_blocked).toBe(false);
    expect(rows.get(b.blockedByOpen)!.is_blocked).toBe(true);
  });

  it('copies only the sessions the listed tasks link, not the whole store', async () => {
    const b = await seedBoard();
    const app = createApp();
    const before = _sessionStoreStatsForTesting();
    const res = await request(app).get(`/api/tasks?fields=list&ids=${b.blockedByOpen},${b.plain}`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
    const after = _sessionStoreStatsForTesting();
    expect(after.cloneReads - before.cloneReads).toBe(0);
    // sess-slot, sess-orphan and sess-archived: none of the 12 unrelated rows.
    expect(after.clonedRows - before.clonedRows).toBe(3);
  });
});
