import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/sessions', () => {
  it('returns empty session list initially', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('returns sessions after creating some', async () => {
    await createSessionRecord('sess-a', 'task-1', 'project-a');
    await createSessionRecord('sess-b', 'task-2', 'project-b');

    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });
});

describe('GET /api/sessions/recent', () => {
  it('returns recent sessions sorted by lastActiveAt', async () => {
    await createSessionRecord('old-sess', 'task-1', 'proj');
    await new Promise((r) => setTimeout(r, 10));
    await createSessionRecord('new-sess', 'task-2', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].claudeSessionId).toBe('new-sess');
  });

  it('respects limit parameter', async () => {
    await createSessionRecord('s1', 'task-1', 'proj');
    await createSessionRecord('s2', 'task-2', 'proj');
    await createSessionRecord('s3', 'task-3', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });
});

describe('GET /api/sessions/summaries', () => {
  it('returns summaries array', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/summaries');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.summaries)).toBe(true);
  });
});

describe('GET /api/sessions/task/:taskId', () => {
  it('returns sessions for a task', async () => {
    await createSessionRecord('s1', 'task-x', 'proj');
    await createSessionRecord('s2', 'task-x', 'proj');
    await createSessionRecord('s3', 'task-y', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/task/task-x');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });

  it('returns empty array for unknown task', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/task/no-such-task');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });
});

describe('PATCH /api/sessions/:sessionId', () => {
  it('updates session title', async () => {
    await createSessionRecord('patch-sess', 'task-1', 'project-a');

    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/patch-sess')
      .send({ title: 'Fix authentication bug' });

    expect(res.status).toBe(200);
    expect(res.body.session.title).toBe('Fix authentication bug');
    expect(res.body.session.claudeSessionId).toBe('patch-sess');
  });

  it('returns 404 for unknown session', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/nonexistent')
      .send({ title: 'test' });

    expect(res.status).toBe(404);
  });

  it('rejects non-string title with 400', async () => {
    await createSessionRecord('val-sess', 'task-1', 'project-a');

    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/val-sess')
      .send({ title: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('title must be a string');
  });

  it('rejects title exceeding 500 chars with 400', async () => {
    await createSessionRecord('long-sess', 'task-1', 'project-a');

    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/long-sess')
      .send({ title: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('max 500 chars');
  });
});

describe('GET /api/sessions/:sessionId/history', () => {
  it('returns 404 for unknown session with no JSONL file', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/nonexistent-session/history');
    expect(res.status).toBe(404);
  });

  it('returns messages for a known session', async () => {
    // Create session record first
    await createSessionRecord('hist-session', 'task-1', 'project-a');

    const app = createApp();
    // Even without JSONL file, should return 200 with empty messages (record exists)
    const res = await request(app).get('/api/sessions/hist-session/history');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});
