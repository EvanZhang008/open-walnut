/**
 * POST /api/tasks — `client_request_id` echo (2026-09-15).
 *
 * The route emits task:created BEFORE it writes the HTTP response, so the
 * broadcast regularly reaches the creating browser first. An optimistic client
 * that only learns the real id from the response cannot recognise that broadcast
 * and inserts a second row beside its own optimistic one (seen on the pinned
 * board: the same new task twice in Focus for the width of the response). The
 * client now mints an opaque id per create; the route echoes it on the event and
 * never stores it. Same fixture shape as tasks-create-focus-tier.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js';
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
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

/** Collect every task:created payload emitted (to the web-ui audience) while
 *  `run` executes. Named subscriber, like the web-ui bridge the browser sits behind. */
async function createdEventsDuring<T>(run: () => Promise<T>): Promise<{ result: T; events: Array<Record<string, unknown>> }> {
  const events: Array<Record<string, unknown>> = [];
  bus.subscribe('web-ui', (event: BusEvent) => {
    if (event.name === EventNames.TASK_CREATED) events.push(event.data as Record<string, unknown>);
  });
  try {
    return { result: await run(), events };
  } finally {
    bus.unsubscribe('web-ui');
  }
}

describe('POST /api/tasks — client_request_id', () => {
  it('echoes the id on task:created and keeps it off the task', async () => {
    const { result: res, events } = await createdEventsDuring(() =>
      request(createApp()).post('/api/tasks').send({ title: 'Correlated', client_request_id: 'req-abc-123' }));
    expect(res.status).toBe(201);
    expect(events).toHaveLength(1);
    expect(events[0].clientRequestId).toBe('req-abc-123');
    expect((events[0].task as { id: string }).id).toBe(res.body.task.id);
    // Never stored: not on the created task, not readable back.
    expect(JSON.stringify(res.body.task)).not.toContain('req-abc-123');
    const detail = await request(createApp()).get(`/api/tasks/${res.body.task.id}`);
    expect(JSON.stringify(detail.body)).not.toContain('req-abc-123');
  });

  it('emits NO clientRequestId key when the client sent none', async () => {
    const { result: res, events } = await createdEventsDuring(() =>
      request(createApp()).post('/api/tasks').send({ title: 'Plain' }));
    expect(res.status).toBe(201);
    expect(events).toHaveLength(1);
    expect('clientRequestId' in events[0]).toBe(false);
  });

  it('rejects a non-string or over-long id with 400, creating nothing', async () => {
    const { events } = await createdEventsDuring(async () => {
      const asNumber = await request(createApp()).post('/api/tasks').send({ title: 'x', client_request_id: 42 });
      expect(asNumber.status).toBe(400);
      const tooLong = await request(createApp()).post('/api/tasks').send({ title: 'x', client_request_id: 'a'.repeat(65) });
      expect(tooLong.status).toBe(400);
    });
    expect(events).toHaveLength(0);
  });
});
