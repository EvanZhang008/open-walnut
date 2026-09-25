/**
 * POST /api/tasks/quick-parse carries `legs` (C53).
 *
 * The draft column reverts an AI chip only when the leg that owns the field
 * answered 'ok'. A failed leg still answers 200 with fewer fields, so without
 * `legs` in the response a timeout would read as "Walnut changed its mind" and
 * wipe a visible Due chip. Claims pinned here:
 *   - every answer of this route names both legs, including the disabled gate,
 *   - a failed LLM leg answers 200 with dates 'failed' and no dates,
 *   - the frozen /api/v1 twin is untouched (it serializes `parse` alone).
 *
 * Real: route, parseQuickTask. Fake: sendMessage, getConfig (Jev not configured).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-quick-parse-legs'));

const sendMessageMock = vi.fn();
vi.mock('../../../src/model/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/model/model.js')>()),
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
const config = { version: 1, user: {}, agent: { main_provider: 'bedrock', quick_parse: true as boolean } };
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: async () => config,
}));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { taskExtrasV1Router } from '../../../src/web/routes/task-extras-v1.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use('/api/v1', taskExtrasV1Router);
  app.use(errorHandler);
  return app;
}

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

const body = { text: 'pay the invoice friday', timeZone: 'America/Los_Angeles' };

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  sendMessageMock.mockReset();
  config.agent.quick_parse = true;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('POST /api/tasks/quick-parse legs', () => {
  it('a parse whose LLM leg answers carries legs next to the fields', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay the invoice","due_date":"2026-10-02","priority":"important"}'));
    const res = await request(createApp()).post('/api/tasks/quick-parse').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Pay the invoice', due_date: '2026-10-02', priority: 'important' });
    expect(res.body.legs).toEqual({ classify: 'skipped', dates: 'ok' });
  });

  it('a failed LLM leg still answers 200, with dates failed and no dates', async () => {
    sendMessageMock.mockRejectedValue(new Error('model unavailable'));
    const res = await request(createApp()).post('/api/tasks/quick-parse').send(body);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('pay the invoice friday');
    expect(res.body).not.toHaveProperty('due_date');
    expect(res.body.legs).toEqual({ classify: 'skipped', dates: 'failed' });
  });

  it('the disabled gate answers with both legs skipped and never calls a model', async () => {
    config.agent.quick_parse = false;
    const res = await request(createApp()).post('/api/tasks/quick-parse').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'pay the invoice friday', legs: { classify: 'skipped', dates: 'skipped' } });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('a bad request is still a 400 with no legs', async () => {
    const res = await request(createApp()).post('/api/tasks/quick-parse').send({ text: '', timeZone: 'UTC' });
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('legs');
  });
});

describe('POST /api/v1/tasks/quick-parse stays frozen', () => {
  it('answers the same fields with no legs, on both the parse and the disabled gate', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay the invoice","due_date":"2026-10-02"}'));
    const parsed = await request(createApp()).post('/api/v1/tasks/quick-parse').send(body);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual({ title: 'Pay the invoice', due_date: '2026-10-02' });

    config.agent.quick_parse = false;
    const gated = await request(createApp()).post('/api/v1/tasks/quick-parse').send(body);
    expect(gated.body).toEqual({ title: 'pay the invoice friday' });
  });
});
