/**
 * ?slim=1 session rows carry the OWNING task's phase/updated/project.
 *
 * The AI search child judges slim rows via curl; a session row's `id` is
 * already the owner task id, but until 2026-09-05 only task rows were
 * enriched, so "prefer the active, recently-updated task" had no signal on
 * the lane that finds placeholder-titled tasks. search() is mocked here
 * because the lexical test server has no session index.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-search-slim-owner'));
vi.mock('../../../src/core/search.js', () => ({ search: searchMock }));

import express from 'express';
import request from 'supertest';
import { searchRouter } from '../../../src/web/routes/search.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, updateTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  searchMock.mockReset();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/search?slim=1 — session rows', () => {
  it('a session row is enriched from the task that owns the transcript', async () => {
    const { task } = await addTask({ title: 'Ask-question thread forking design', project: 'walnut' });
    await updateTask(task.id, { phase: 'IN_PROGRESS' });
    searchMock.mockResolvedValue([
      { type: 'session', title: 'Ask-question thread forking design', snippet: 'btw side question', taskId: task.id, sessionId: 'sid-1', score: 0.43, matchField: 'description' },
      { type: 'session', title: 'orphan transcript', snippet: 'no owner', sessionId: 'sid-2', score: 0.2, matchField: 'description' },
      { type: 'memory', title: 'a note', snippet: 'memory rows are never task-enriched', path: '/x/note.md', score: 0.1, matchField: 'content' },
    ]);

    const res = await request(createApp()).get('/api/search?q=side%20question&types=task,session&slim=1');

    expect(res.status).toBe(200);
    const [owned, orphan, memory] = res.body.results;
    expect(owned).toMatchObject({
      type: 'session',
      id: task.id,
      phase: 'IN_PROGRESS',
      project: 'walnut',
      ref: `<session-ref id="sid-1" label="Ask-question thread forking design"/>`,
    });
    expect(owned.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No owner → bare row, still a valid session ref.
    expect(orphan).toMatchObject({ type: 'session', id: 'sid-2' });
    expect(orphan.phase).toBeUndefined();
    expect(orphan.updated).toBeUndefined();
    expect(memory.phase).toBeUndefined();
    expect(memory.id).toBe('/x/note.md');
  });
});
