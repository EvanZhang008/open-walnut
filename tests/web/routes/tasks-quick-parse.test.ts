import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const sendMessageMock = vi.fn();
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-quick-task-route'));
vi.mock('../../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function lastUserContent(): string {
  const call = sendMessageMock.mock.calls.at(-1)![0] as {
    messages: Array<{ content: string }>;
  };
  return call.messages[0].content;
}

const validBody = { timeZone: 'America/Los_Angeles' };

beforeEach(async () => {
  sendMessageMock.mockReset();
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('POST /api/tasks/quick-parse', () => {
  it('returns the parsed task shape for valid text without envelope metadata', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"File my tax","due_date":"2026-07-15T10:00:00","pinTier":"focus","priority":"important","starred":true}',
    ));

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'file my tax tomorrow at 10am pinned focus important and starred', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: 'File my tax',
      due_date: '2026-07-15T10:00:00',
      pinTier: 'focus',
      priority: 'important',
      starred: true,
    });
    expect(res.body).not.toHaveProperty('parseMs');
    expect(res.body).not.toHaveProperty('model');
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('passes the validated browser timezone into the parser prompt', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy groceries"}'));

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'buy groceries tomorrow', ...validBody });

    expect(res.status).toBe(200);
    expect(lastUserContent()).toContain('IANA timezone: America/Los_Angeles');
  });

  it.each([
    ['missing text', validBody],
    ['non-string text', { text: 42, ...validBody }],
    ['text over 500 characters', { text: 'x'.repeat(501), ...validBody }],
    ['missing timeZone', { text: 'Buy groceries' }],
    ['non-string timeZone', { text: 'Buy groceries', timeZone: 42 }],
    ['invalid timeZone', { text: 'Buy groceries', timeZone: 'Not/AZone' }],
  ])('rejects %s', async (_name, body) => {
    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send(body);

    expect(res.status).toBe(400);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('returns the original title when the model fails', async () => {
    sendMessageMock.mockRejectedValue(new Error('model unavailable'));
    const text = 'Prepare monthly budget tomorrow';

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text, ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: text });
  });

  it('includes the seeded category digest in model content', async () => {
    await addTask({ title: 'Buy groceries', category: 'Personal', project: 'Errands' });
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Call the clinic","category":"Personal","project":"Errands"}',
    ));

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'call the clinic', ...validBody });

    expect(res.status).toBe(200);
    expect(lastUserContent()).toContain(
      'Your categories and projects (name, open task count, recent task titles):',
    );
    expect(lastUserContent()).toContain('  - Errands: "Buy groceries"');
  });

  it('drops an unknown model-proposed category', async () => {
    await addTask({ title: 'Buy groceries', category: 'Personal', project: 'Errands' });
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Call the clinic","category":"Unknown","project":"Errands"}',
    ));

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'call the clinic', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'Call the clinic' });
  });
});
