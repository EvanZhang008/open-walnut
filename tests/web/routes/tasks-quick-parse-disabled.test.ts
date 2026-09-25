/**
 * POST /api/tasks/quick-parse with the background parse NOT opted in.
 *
 * `agent.quick_parse` defaults OFF. Two things must hold, and the second is the
 * one a future refactor is likely to lose:
 *
 *   1. No model call. On a CLI provider each one spawns a whole `claude -p` and
 *      blows the 10s abort in quick-task-parse.ts, so a disabled parse that still
 *      reached the model would keep the exact cost the flag exists to remove.
 *   2. No project digest. buildProjectDigest walks EVERY task (6,431 on the real
 *      board) on the one event loop every route shares, and its output only ever
 *      feeds the prompt — so a gate placed after it would still pay for a prompt
 *      it never sends. The gate has to come first, and this pins that ordering.
 *
 * The enabled path lives in tasks-quick-parse.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const sendMessageMock = vi.fn();
const buildProjectDigestMock = vi.fn();
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-quick-parse-off'));
vi.mock('../../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
vi.mock('../../../src/core/quick-task-digest.js', () => ({
  buildProjectDigest: (...args: unknown[]) => buildProjectDigestMock(...args),
}));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { updateConfig } from '../../../src/core/config-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

const validBody = { timeZone: 'America/Los_Angeles' };
// The gate never runs a leg, and says so, so the client cannot read its silence as "no opinion".
const NO_LEGS = { classify: 'skipped', dates: 'skipped' };

beforeEach(async () => {
  sendMessageMock.mockReset();
  buildProjectDigestMock.mockReset();
  buildProjectDigestMock.mockResolvedValue({ digest: 'should never be built', projects: [] });
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('POST /api/tasks/quick-parse — not opted in', () => {
  it('answers the sentence itself without calling a model, when the flag is unset', async () => {
    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'file my tax tomorrow at 10am pinned focus important', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'file my tax tomorrow at 10am pinned focus important', legs: NO_LEGS });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not build the project digest — the gate runs BEFORE the all-tasks walk', async () => {
    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'ship the release notes on friday', ...validBody });

    expect(res.status).toBe(200);
    expect(buildProjectDigestMock).not.toHaveBeenCalled();
  });

  it('treats an explicit false exactly like an unset flag', async () => {
    await updateConfig({ agent: { quick_parse: false } });

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'call the dentist next tuesday', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'call the dentist next tuesday', legs: NO_LEGS });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(buildProjectDigestMock).not.toHaveBeenCalled();
  });

  it('invents no fields: only a title comes back, never a date/project/tier guess', async () => {
    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'book the Kyoto flights tomorrow 10am urgent', ...validBody });

    expect(Object.keys(res.body)).toEqual(['title', 'legs']);
    expect(res.body).not.toHaveProperty('due_date');
    expect(res.body).not.toHaveProperty('project');
    expect(res.body).not.toHaveProperty('pinTier');
  });

  it('caps the echoed title at 200 chars so a long note cannot return an oversized field', async () => {
    // 500 is the route's own request cap, so this is the longest text it accepts.
    const long = 'a'.repeat(500);

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: long, ...validBody });

    expect(res.status).toBe(200);
    expect(res.body.title).toHaveLength(200);
  });

  it('still rejects a malformed request rather than echoing it back', async () => {
    const app = createApp();

    // The gate must not swallow validation: an empty text and a bad timezone are
    // still 400s, not a cheerful { title: '' }.
    expect((await request(app).post('/api/tasks/quick-parse').send({ text: '   ', ...validBody })).status).toBe(400);
    expect((await request(app).post('/api/tasks/quick-parse').send({ text: 'ok', timeZone: 'Not/AZone' })).status).toBe(400);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('turns back on when the user opts in, so the flag is a switch and not a removal', async () => {
    await updateConfig({ agent: { quick_parse: true } });
    sendMessageMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"title":"File my tax"}' }],
      stopReason: 'end_turn',
    });

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'file my tax tomorrow', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'File my tax', legs: { classify: 'skipped', dates: 'ok' } });
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(buildProjectDigestMock).toHaveBeenCalledOnce();
  });
});
