import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

const { memoryNotesSearchMock, listSessionsMock } = vi.hoisted(() => ({
  memoryNotesSearchMock: vi.fn(),
  listSessionsMock: vi.fn(),
}));

vi.mock('../../../src/constants.js', () =>
  createMockConstants('walnut-search-reference-bypass'));
vi.mock('../../../src/core/memory-search.js', () => ({
  memoryNotesSearch: memoryNotesSearchMock,
}));
vi.mock('../../../src/core/session-tracker.js', () => ({
  listSessions: listSessionsMock,
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  _resetForTesting,
  addSessionToHistory,
  addTask,
  updateTaskRaw,
} from '../../../src/core/task-manager.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { searchRouter } from '../../../src/web/routes/search.js';

const SESSION_ID = '12345678-1234-4abc-8def-1234567890ab';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  _resetForTesting();
  memoryNotesSearchMock.mockReset().mockResolvedValue([]);
  listSessionsMock.mockReset();
  listSessionsMock.mockResolvedValue([{
    claudeSessionId: 'standalone-session-reference',
    title: 'Standalone reference session',
  }]);
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/search structured references', () => {
  it('returns an exact session-id task without invoking QMD', async () => {
    const { task } = await addTask({
      title: 'Structured reference target',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    await addSessionToHistory(task.id, SESSION_ID);

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: SESSION_ID, types: 'task' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        type: 'task',
        taskId: task.id,
        title: 'Structured reference target',
        matchField: 'session_id',
        score: 1,
      }),
    ]);
    expect(memoryNotesSearchMock).not.toHaveBeenCalled();
  });

  it('bypasses QMD for every structured task reference field', async () => {
    const { task } = await addTask({
      title: 'All structured references',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    await updateTaskRaw(task.id, {
      session_id: 'legacy-session-reference',
      session_ids: ['historical-session-reference'],
      plan_session_id: 'plan-session-reference',
      exec_session_id: 'exec-session-reference',
      external_url: 'https://example.test/tasks/structured-reference',
    });

    const queries = [
      task.id,
      'legacy-session-reference',
      'historical-session-reference',
      'plan-session-reference',
      'exec-session-reference',
      'https://example.test/tasks/structured-reference',
    ];
    for (const query of queries) {
      const res = await request(createApp())
        .get('/api/search')
        .query({ q: query, types: 'task' });

      expect(res.status).toBe(200);
      expect(res.body.results[0]).toEqual(expect.objectContaining({
        type: 'task',
        taskId: task.id,
      }));
    }
    expect(memoryNotesSearchMock).not.toHaveBeenCalled();
  });

  it('returns a standalone session ID without invoking QMD', async () => {
    const res = await request(createApp())
      .get('/api/search')
      .query({
        q: 'standalone-session-reference',
        types: 'session',
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        type: 'session',
        sessionId: 'standalone-session-reference',
        matchField: 'session_id',
      }),
    ]);
    expect(memoryNotesSearchMock).not.toHaveBeenCalled();
  });

  it('joins an exact SessionRecord.taskId when task session fields are stale', async () => {
    const { task } = await addTask({
      title: 'Record-owned task',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    listSessionsMock.mockResolvedValue([{
      claudeSessionId: SESSION_ID,
      taskId: task.id,
      title: 'Record-owned Codex session',
    }]);
    memoryNotesSearchMock.mockResolvedValue([{
      title: 'Unrelated semantic result',
      snippet: 'Numeric noise',
      taskId: 'unrelated-task',
      finalScore: 99,
      source: 'task',
    }]);

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: SESSION_ID, types: 'task,memory' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        type: 'task',
        taskId: task.id,
        sessionId: SESSION_ID,
        score: 1,
      }),
    ]);
    expect(memoryNotesSearchMock).not.toHaveBeenCalled();
  });

  it('pins the authoritative partial session owner and still merges QMD', async () => {
    const { task: staleTask } = await addTask({
      title: 'Stale task-side owner',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    await updateTaskRaw(staleTask.id, { session_ids: [SESSION_ID] });
    const { task: authoritativeTask } = await addTask({
      title: 'Record-owned task',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    listSessionsMock.mockResolvedValue([{
      claudeSessionId: SESSION_ID,
      taskId: authoritativeTask.id,
      title: 'Record-owned session',
    }]);
    memoryNotesSearchMock.mockResolvedValue([{
      title: 'Semantic companion result',
      snippet: 'Related implementation',
      taskId: 'semantic-task',
      finalScore: 1,
      source: 'task',
    }]);

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: SESSION_ID.slice(0, 8), types: 'task' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        taskId: authoritativeTask.id,
        sessionId: SESSION_ID,
        score: 0.99,
      }),
      expect.objectContaining({
        taskId: 'semantic-task',
      }),
    ]);
    expect(memoryNotesSearchMock).toHaveBeenCalledOnce();
  });

  it('disables QMD reranking for an ordinary interactive task query', async () => {
    memoryNotesSearchMock.mockResolvedValue([{
      title: 'Semantic result',
      snippet: 'Related achievement',
      taskId: 'semantic-task-id',
      finalScore: 0.82,
      source: 'task',
    }]);

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: 'career accomplishments', types: 'task' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        type: 'task',
        taskId: 'semantic-task-id',
      }),
    ]);
    expect(memoryNotesSearchMock).toHaveBeenCalledWith(
      'career accomplishments',
      ['task'],
      20,
      undefined,
      { rerank: false, overfetchMultiplier: 1 },
    );
  });

  it('falls back to session metadata when QMD session search fails', async () => {
    listSessionsMock.mockResolvedValue([{
      claudeSessionId: 'session-fallback-id',
      title: 'Authentication middleware investigation',
      description: 'Debugged refresh token rotation',
    }]);
    memoryNotesSearchMock.mockRejectedValue(new Error('QMD unavailable'));

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: 'refresh token', types: 'session' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        type: 'session',
        sessionId: 'session-fallback-id',
        matchField: 'description',
      }),
    ]);
  });

  it('disables QMD reranking for an ordinary interactive session query', async () => {
    memoryNotesSearchMock.mockResolvedValue([{
      title: 'Semantic session result',
      snippet: 'Related implementation work',
      sessionId: 'semantic-session-id',
      finalScore: 0.76,
      source: 'session',
    }]);

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: 'implementation discussion', types: 'session' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({
        type: 'session',
        sessionId: 'semantic-session-id',
      }),
    ]);
    expect(memoryNotesSearchMock).toHaveBeenCalledWith(
      'implementation discussion',
      ['session'],
      20,
      undefined,
      { rerank: false, overfetchMultiplier: 1 },
    );
  });

  it('surfaces a total QMD failure instead of returning an authoritative empty set', async () => {
    memoryNotesSearchMock.mockRejectedValue(new Error('QMD unavailable'));

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: 'semantic-only phrase', types: 'task' });

    expect(res.status).toBe(500);
  });

  it('uses BM25 directly when semantic search is disabled', async () => {
    const previous = process.env.WALNUT_DISABLE_SEARCH;
    process.env.WALNUT_DISABLE_SEARCH = '1';
    try {
      const { task } = await addTask({
        title: 'Disabled search lexical fallback',
        project: 'Quick Start',
        source: 'local',
        _skipPluginOps: true,
      });

      const res = await request(createApp())
        .get('/api/search')
        .query({ q: 'lexical fallback', types: 'task' });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        expect.objectContaining({ taskId: task.id }),
      ]);
      expect(memoryNotesSearchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
      else process.env.WALNUT_DISABLE_SEARCH = previous;
    }
  });
});
