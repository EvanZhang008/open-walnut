/**
 * Integration tests for chat history REST endpoints.
 * GET /api/chat/history and POST /api/chat/clear
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { chatHistoryRouter } from '../../../src/web/routes/chat-history.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import * as chatHistory from '../../../src/core/chat-history.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatHistoryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/chat/history', () => {
  it('returns empty messages with pagination when no history exists', async () => {
    const app = createApp();
    const res = await request(app).get('/api/chat/history');

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.pagination).toEqual({
      page: 1,
      pageSize: 100,
      totalMessages: 0,
      totalPages: 1,
      hasMore: false,
    });
  });

  it('returns persisted display messages', async () => {
    // Seed some history directly
    await chatHistory.addTurn(
      [{ role: 'user', content: 'hello' }],
      [{ role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' }],
    );
    await chatHistory.addTurn(
      [{ role: 'assistant', content: 'hi there' }],
      [{ role: 'assistant', content: 'hi there', timestamp: '2025-01-01T00:00:01Z' }],
    );

    const app = createApp();
    const res = await request(app).get('/api/chat/history');

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].content).toBe('hello');
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[1].content).toBe('hi there');
    expect(res.body.messages[1].role).toBe('assistant');
  });

  it('supports page and pageSize query parameters', async () => {
    // Add 5 user+assistant turn pairs = 10 logical messages
    for (let i = 0; i < 5; i++) {
      await chatHistory.addAIMessages([
        { role: 'user', content: `msg-${i}` },
        { role: 'assistant', content: `reply-${i}` },
      ]);
    }

    const app = createApp();

    // Page 1 with pageSize=4 → last 4 logical messages
    const res1 = await request(app).get('/api/chat/history?page=1&pageSize=4');
    expect(res1.status).toBe(200);
    expect(res1.body.pagination).toMatchObject({
      page: 1,
      pageSize: 4,
      totalMessages: 10,
      hasMore: true,
    });
    expect(res1.body.messages).toHaveLength(4);

    // Page 2 → next 4
    const res2 = await request(app).get('/api/chat/history?page=2&pageSize=4');
    expect(res2.status).toBe(200);
    expect(res2.body.pagination.page).toBe(2);
    expect(res2.body.pagination.hasMore).toBe(true);
    expect(res2.body.messages).toHaveLength(4);

    // Page 3 → remaining 2
    const res3 = await request(app).get('/api/chat/history?page=3&pageSize=4');
    expect(res3.status).toBe(200);
    expect(res3.body.pagination.hasMore).toBe(false);
    expect(res3.body.messages).toHaveLength(2);
  });

  it('tool_result entries do not count toward pageSize', async () => {
    await chatHistory.addAIMessages([
      { role: 'user', content: 'search for something' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'found it' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'Results' }] },
    ] as Array<{ role: string; content: unknown }>);

    const app = createApp();
    const res = await request(app).get('/api/chat/history');

    // 3 logical messages (user, assistant, assistant) — tool_result doesn't count
    expect(res.body.pagination.totalMessages).toBe(3);
    // But all 4 entries are returned
    expect(res.body.messages).toHaveLength(4);
  });
});

describe('POST /api/chat/clear', () => {
  it('clears all history', async () => {
    await chatHistory.addTurn(
      [{ role: 'user', content: 'hello' }],
      [{ role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' }],
    );

    const app = createApp();
    const clearRes = await request(app).post('/api/chat/clear');
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.ok).toBe(true);

    // Verify history is empty
    const historyRes = await request(app).get('/api/chat/history');
    expect(historyRes.body.messages).toEqual([]);
  });

  it('is safe to call when already empty', async () => {
    const app = createApp();
    const res = await request(app).post('/api/chat/clear');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('persists the clear — subsequent reads see empty history', async () => {
    await chatHistory.addTurn(
      [{ role: 'user', content: 'data' }],
      [{ role: 'user', content: 'data', timestamp: '2025-01-01T00:00:00Z' }],
    );

    const app = createApp();
    await request(app).post('/api/chat/clear');

    // Create a fresh app to force re-read from disk
    const app2 = createApp();
    const res = await request(app2).get('/api/chat/history');
    expect(res.body.messages).toEqual([]);
  });
});
