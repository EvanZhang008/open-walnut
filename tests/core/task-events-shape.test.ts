/**
 * Bus payload SHAPES for the two project-layer events that cross a process
 * boundary: `task:reordered` and `project:created`.
 *
 * Why shape tests rather than behavior tests: both payloads are consumed by code
 * the type-checker cannot reach — the web client's WS handler and
 * git-versioning's switch. Renaming `project` back to `category`, or firing
 * PROJECT_CREATED on every ensureProject() call, compiles fine and only shows up
 * as a live UI that never refreshes its project list (or one that thrashes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-events-shape'));

import { bus, EventNames } from '../../src/core/event-bus.js';
import { tasksRouter } from '../../src/web/routes/tasks.js';
import { errorHandler } from '../../src/web/middleware/error-handler.js';
import {
  _resetForTesting,
  addTask,
  ensureProject,
  listTasks,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

const PROBE = 'events-shape-probe';

interface Captured { name: string; data: Record<string, unknown> }

/** Record every event that crosses the bus for the duration of a test. */
function capture(): Captured[] {
  const seen: Captured[] = [];
  bus.subscribe(PROBE, (event) => {
    seen.push({ name: event.name, data: (event.data ?? {}) as Record<string, unknown> });
  }, { global: true });
  return seen;
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  app = createApp();
});

afterEach(async () => {
  bus.unsubscribe(PROBE);
  closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('TaskReorderedEvent shape', () => {
  it('emits exactly { project, taskIds } for a named project', async () => {
    const { task: a } = await addTask({ title: 'A', project: 'Marina' });
    const { task: b } = await addTask({ title: 'B', project: 'Marina' });

    const seen = capture();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ project: 'Marina', taskIds: [b.id, a.id] });
    expect(res.status).toBe(200);

    const reordered = seen.filter((e) => e.name === EventNames.TASK_REORDERED);
    expect(reordered).toHaveLength(1);
    // Exactly two keys — no `category`, no extras a consumer might start relying on.
    expect(Object.keys(reordered[0].data).sort()).toEqual(['project', 'taskIds']);
    expect(reordered[0].data.project).toBe('Marina');
    expect(reordered[0].data.taskIds).toEqual([b.id, a.id]);
    expect(reordered[0].data).not.toHaveProperty('category');
  });

  it("carries project: '' for Inbox — an empty string, not omitted/null", async () => {
    // '' is a REAL group (Inbox), so the payload must be present-but-empty. A
    // consumer doing `if (project)` would silently drop every Inbox reorder.
    const { task: a } = await addTask({ title: 'Inbox A' });
    const { task: b } = await addTask({ title: 'Inbox B' });

    const seen = capture();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ project: '', taskIds: [b.id, a.id] });
    expect(res.status).toBe(200);

    const reordered = seen.filter((e) => e.name === EventNames.TASK_REORDERED);
    expect(reordered).toHaveLength(1);
    expect(reordered[0].data).toHaveProperty('project');
    expect(reordered[0].data.project).toBe('');
    expect(reordered[0].data.taskIds).toEqual([b.id, a.id]);

    // …and the reorder actually landed (the event isn't reporting a no-op).
    const inboxOrder = (await listTasks()).filter((t) => (t.project || '') === '').map((t) => t.id);
    expect(inboxOrder).toEqual([b.id, a.id]);
  });

  it('does not emit on a rejected reorder (validation 400)', async () => {
    const seen = capture();
    // `project` must be a string — a missing one is a client bug, not Inbox.
    expect((await request(app).patch('/api/tasks/reorder').send({ taskIds: ['x'] })).status).toBe(400);
    expect((await request(app).patch('/api/tasks/reorder').send({ project: '', taskIds: [] })).status).toBe(400);
    expect(seen.filter((e) => e.name === EventNames.TASK_REORDERED)).toHaveLength(0);
  });
});

describe('PROJECT_CREATED from ensureProject', () => {
  it('fires exactly once — on the first create, never on a repeat', async () => {
    const seen = capture();

    const first = await ensureProject('Marina');
    expect(first).toEqual({ name: 'Marina', source: 'local', created: true });

    const second = await ensureProject('Marina');
    expect(second.created).toBe(false);
    // Case variants resolve to the SAME row, so they must not re-announce either.
    const third = await ensureProject('marina');
    expect(third.created).toBe(false);
    expect(third.name).toBe('Marina');

    const created = seen.filter((e) => e.name === EventNames.PROJECT_CREATED);
    expect(created).toHaveLength(1);
    expect(Object.keys(created[0].data).sort()).toEqual(['name', 'source']);
    expect(created[0].data).toEqual({ name: 'Marina', source: 'local' });
  });

  it('reports the provider source on a claimed project, and never re-claims on repeat', async () => {
    const seen = capture();

    await ensureProject('Synced', 'ms-todo');
    // A second call passing a DIFFERENT source must not silently re-claim…
    const again = await ensureProject('Synced', 'local');
    expect(again).toEqual({ name: 'Synced', source: 'ms-todo', created: false });

    const created = seen.filter((e) => e.name === EventNames.PROJECT_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0].data).toEqual({ name: 'Synced', source: 'ms-todo' });
  });

  it('is a silent no-op for Inbox ("" and whitespace) — it has no registry row', async () => {
    const seen = capture();
    expect(await ensureProject('')).toEqual({ name: '', source: 'local', created: false });
    expect(await ensureProject('   ')).toEqual({ name: '', source: 'local', created: false });
    expect(seen.filter((e) => e.name === EventNames.PROJECT_CREATED)).toHaveLength(0);
  });

  it('fires once when addTask auto-creates the project, and not for the next task in it', async () => {
    const seen = capture();

    await addTask({ title: 'First', project: 'Marina' });
    await addTask({ title: 'Second', project: 'Marina' });
    // An explicit ensureProject afterwards is also a repeat.
    await ensureProject('Marina');

    const created = seen.filter((e) => e.name === EventNames.PROJECT_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0].data).toEqual({ name: 'Marina', source: 'local' });
  });
});
