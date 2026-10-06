/**
 * One-request bulk endpoints for the folder and project menus:
 *   - POST /api/focus/batch                 pin / retier / unpin many tasks
 *   - POST /api/tasks/batch/plugin-field    set one plugin task field on many tasks
 *
 * A folder holds 50+ open tasks; the per-task routes would cost 100+ requests
 * from one click and starve the browser's connection pool. Store-level pin
 * semantics live in tests/core/pin-tier-bulk.test.ts; this file covers the HTTP
 * contract: validation, the 200 partial-success shape, the tier split spread on
 * the response, and the single CONFIG_CHANGED per batch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { focusRouter } from '../../../src/web/routes/focus.js';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, getTask, togglePin, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { registry } from '../../../src/core/integration-registry.js';
import { createNoopSync } from '../../core/plugin-test-utils.js';
import type { TaskFieldSpec } from '../../../src/core/integration-types.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/focus', focusRouter);
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

beforeEach(async () => {
  closeDb();
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetForTesting();
  registry.clear();
  await rmWalnutHome();
});

afterEach(async () => {
  vi.restoreAllMocks();
  bus.clear();
  registry.clear();
  closeDb();
  closeSessionDb();
  await rmWalnutHome();
});

async function makeTasks(titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const { task } = await addTask({ title, project: 'Marina' });
    ids.push(task.id);
  }
  return ids;
}

describe('POST /api/focus/batch', () => {
  it('rejects a bad task_ids list or tier', async () => {
    const app = createApp();
    const [a] = await makeTasks(['A']);
    const cases: Array<[unknown, RegExp]> = [
      [{ tier: 'focus' }, /task_ids/],
      [{ task_ids: [], tier: 'focus' }, /task_ids/],
      [{ task_ids: 'x', tier: 'focus' }, /task_ids/],
      [{ task_ids: [a, 7], tier: 'focus' }, /task_ids/],
      [{ task_ids: Array.from({ length: 501 }, (_, i) => `t${i}`), tier: 'focus' }, /at most 500/],
      // Unpin must be an explicit null, never an omitted field.
      [{ task_ids: [a] }, /tier must be/],
      [{ task_ids: [a], tier: 3 }, /tier must be/],
      [{ task_ids: [a], tier: 'not-a-tier' }, /^Unknown tier/],
    ];
    for (const [body, error] of cases) {
      const res = await request(app).post('/api/focus/batch').send(body as object);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error).toMatch(error);
    }
    expect((await getTask(a)).pinned).toBeFalsy();
  });

  it('pins, reports failures and returns the tier split; GET shows the same split', async () => {
    const app = createApp();
    const [a, b] = await makeTasks(['A', 'B']);
    const emit = vi.spyOn(bus, 'emit');

    const res = await request(app)
      .post('/api/focus/batch')
      .send({ task_ids: [a, 'no-such-task', b], tier: 'focus' });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([a, b]);
    expect(res.body.failed).toEqual([{ id: 'no-such-task', ok: false, error: 'not_found' }]);
    expect(res.body.focus_tasks).toEqual([a, b]);
    expect(res.body.pinned_tasks).toEqual([a, b]);
    const focusBar = emit.mock.calls.filter(([name, data]) =>
      name === EventNames.CONFIG_CHANGED && (data as { key?: string }).key === 'focus_bar');
    expect(focusBar).toHaveLength(1);

    const split = await request(app).get('/api/focus/tasks');
    expect(split.status).toBe(200);
    const { changed: _changed, failed: _failed, ...fromBatch } = res.body;
    expect(split.body).toEqual(fromBatch);
  });

  it('unpins with tier null and sends no CONFIG_CHANGED when nothing changed', async () => {
    const app = createApp();
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    for (const id of [a, b, c]) await togglePin(id);

    const res = await request(app).post('/api/focus/batch').send({ task_ids: [a, c], tier: null });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([a, c]);
    expect(res.body.pinned_tasks).toEqual([b]);
    expect((await getTask(b)).pin_order).toBe(0);

    const emit = vi.spyOn(bus, 'emit');
    const again = await request(app).post('/api/focus/batch').send({ task_ids: [a, c], tier: null });
    expect(again.status).toBe(200);
    expect(again.body.changed).toEqual([]);
    expect(emit.mock.calls.filter(([name]) => name === EventNames.CONFIG_CHANGED)).toEqual([]);
  });

  it('accepts a registered custom tier and spreads custom_tier_tasks', async () => {
    const app = createApp();
    const created = await request(app).post('/api/focus/tiers').send({ label: 'Marina review' });
    expect(created.status).toBe(200);
    const tierId = created.body.tier.id as string;
    const [a, b] = await makeTasks(['A', 'B']);

    const res = await request(app).post('/api/focus/batch').send({ task_ids: [a, b], tier: tierId });
    expect(res.status).toBe(200);
    expect(res.body.custom_tier_tasks[tierId]).toEqual([a, b]);
    expect(res.body.satellite_tasks).toEqual([]);
  });
});

function registerFieldPlugin(id: string, taskFields: TaskFieldSpec[]): void {
  registry.register(id, {
    id,
    name: id,
    config: {},
    sync: createNoopSync(),
    migrations: [],
    httpRoutes: [],
    taskFields,
  });
}

describe('POST /api/tasks/batch/plugin-field', () => {
  it('rejects a bad body, an undeclared field, and a clear of a non-clearable field', async () => {
    registerFieldPlugin('tracker', [
      { key: 'sprint', label: 'Sprint', type: 'enum', optionsRoute: '/sprints', coreField: 'sprint' },
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards', clearable: false },
    ]);
    const app = createApp();
    const [a] = await makeTasks(['A']);
    const cases: Array<[unknown, RegExp]> = [
      [{ pluginId: 'tracker', key: 'sprint', value: 'S1' }, /task_ids/],
      [{ task_ids: [], pluginId: 'tracker', key: 'sprint', value: 'S1' }, /task_ids/],
      [{ task_ids: Array.from({ length: 501 }, (_, i) => `t${i}`), pluginId: 'tracker', key: 'sprint', value: 'S1' }, /at most 500/],
      [{ task_ids: [a], key: 'sprint', value: 'S1' }, /pluginId and key/],
      [{ task_ids: [a], pluginId: 'tracker', key: 'sprint', value: 5 }, /value must be/],
      [{ task_ids: [a], pluginId: 'tracker', key: 'nope', value: 'S1' }, /does not declare/],
      [{ task_ids: [a], pluginId: 'ghost', key: 'sprint', value: 'S1' }, /does not declare/],
      [{ task_ids: [a], pluginId: 'tracker', key: 'board', value: null }, /not clearable/],
    ];
    for (const [body, error] of cases) {
      const res = await request(app).post('/api/tasks/batch/plugin-field').send(body as object);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error).toMatch(error);
    }
    expect((await getTask(a)).sprint).toBeFalsy();
  });

  it('sets a sprint on every task and reports a missing id as not_found', async () => {
    registerFieldPlugin('tracker', [
      { key: 'sprint', label: 'Sprint', type: 'enum', optionsRoute: '/sprints', coreField: 'sprint' },
    ]);
    const app = createApp();
    const [a, b] = await makeTasks(['A', 'B']);

    const res = await request(app)
      .post('/api/tasks/batch/plugin-field')
      .send({ task_ids: [a, 'no-such-task', b, a], pluginId: 'tracker', key: 'sprint', value: 'Oct 6 - Oct 17' });

    expect(res.status).toBe(200);
    expect(res.body.changed.map((t: { id: string }) => t.id)).toEqual([a, b]);
    expect(res.body.failed).toEqual([{ id: 'no-such-task', ok: false, error: 'not_found' }]);
    expect((await getTask(a)).sprint).toBe('Oct 6 - Oct 17');
    expect((await getTask(b)).sprint).toBe('Oct 6 - Oct 17');

    const cleared = await request(app)
      .post('/api/tasks/batch/plugin-field')
      .send({ task_ids: [a, b], pluginId: 'tracker', key: 'sprint', value: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.failed).toEqual([]);
    expect((await getTask(a)).sprint).toBeFalsy();
    expect((await getTask(b)).sprint).toBeFalsy();
  });

  it('writes an ext-backed field on every task', async () => {
    registerFieldPlugin('tracker', [
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards' },
    ]);
    const [a, b] = await makeTasks(['A', 'B']);

    const res = await request(createApp())
      .post('/api/tasks/batch/plugin-field')
      .send({ task_ids: [a, b], pluginId: 'tracker', key: 'board', value: 'Marina board' });

    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([]);
    for (const id of [a, b]) {
      expect(((await getTask(id)).ext?.tracker as Record<string, unknown>)?.board).toBe('Marina board');
    }
  });
});
