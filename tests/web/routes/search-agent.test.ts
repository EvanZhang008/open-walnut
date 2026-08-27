/**
 * Wire contract of GET /api/search/agent — validation, status/code mapping,
 * headers. The core module is mocked; see tests/core/task-search-agent*.ts
 * for the pipeline itself.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('../../../src/core/task-search-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/task-search-agent.js')>()),
  runTaskSearchAgent: runMock,
}));

import { AgentSearchError } from '../../../src/core/task-search-agent.js';
import { searchAgentRouter } from '../../../src/web/routes/search-agent.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use('/api/search/agent', searchAgentRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  runMock.mockReset();
  delete process.env.WALNUT_AGENT_SEARCH_DEADLINE_MS;
});

afterEach(() => {
  delete process.env.WALNUT_AGENT_SEARCH_DEADLINE_MS;
});

describe('GET /api/search/agent', () => {
  it('400s on a missing or too-short q without touching the core', async () => {
    expect((await request(createApp()).get('/api/search/agent')).status).toBe(400);
    expect((await request(createApp()).get('/api/search/agent?q=abc')).status).toBe(400);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('400s on an over-long q', async () => {
    const res = await request(createApp()).get(`/api/search/agent?q=${'x'.repeat(401)}`);
    expect(res.status).toBe(400);
  });

  it('passes through the 200 payload with Cache-Control: no-store', async () => {
    const payload = { results: [{ taskId: 't1', title: 'T', evidence: 'e' }], model: 'haiku', tookMs: 5, cached: false };
    runMock.mockResolvedValue(payload);
    const res = await request(createApp()).get('/api/search/agent?q=which task adds docx');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(runMock).toHaveBeenCalledWith('which task adds docx');
  });

  it.each([
    [503, 'ai_disabled'],
    [429, 'busy'],
    [502, 'agent_failed'],
    [502, 'unparseable'],
  ])('maps AgentSearchError to %d {code:%s}', async (status, code) => {
    runMock.mockRejectedValue(new AgentSearchError('nope', status, { code }));
    const res = await request(createApp()).get('/api/search/agent?q=some query');
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 504 {code:timeout} when the agent outlives the route deadline', async () => {
    process.env.WALNUT_AGENT_SEARCH_DEADLINE_MS = '50';
    runMock.mockReturnValue(new Promise(() => {})); // hangs forever
    const res = await request(createApp()).get('/api/search/agent?q=slow query here');
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('timeout');
  });

  it('routes unexpected errors to the shared error handler, not a raw crash', async () => {
    runMock.mockRejectedValue(new Error('disk on fire'));
    const res = await request(createApp()).get('/api/search/agent?q=some query');
    expect(res.status).toBe(500);
  });
});
