import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

/**
 * The reference lanes (ids, commit SHAs, external URLs) run in FRONT of the
 * ranked index lane: a pasted identifier is a navigation command, so it must
 * never be displaced by semantically-adjacent noise. Both an EXACT id and an id
 * PREFIX answer alone and never wake the index — an opaque token has no prose
 * for the ranked lane to match, so consulting it only paid for an embedder warm
 * (search/id-lookup.ts). A commit SHA, an external URL, and a foreign-format id
 * still travel the reference lanes below. The index lane is mocked by name here
 * so "was it consulted at all?" is directly assertable.
 */
const { searchLaneMock, listSessionsMock } = vi.hoisted(() => ({
  searchLaneMock: vi.fn(),
  listSessionsMock: vi.fn(),
}));

vi.mock('../../../src/constants.js', () =>
  createMockConstants('walnut-search-reference-bypass'));
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  searchV2Lane: searchLaneMock,
}));
vi.mock('../../../src/core/session-tracker.js', () => ({
  listSessions: listSessionsMock,
}));

/** One index hit. `ref` is the task id / session id / file path. */
function laneHit(over: Record<string, unknown>) {
  return {
    kind: 'task',
    ref: 'unset',
    title: '',
    text: '',
    score: 0.5,
    components: { coverage: 1, cosine: 0 },
    semantic: 'off',
    ...over,
  };
}

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
  searchLaneMock.mockReset().mockResolvedValue([]);
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
  it('returns an exact session-id task without invoking the index', async () => {
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
    expect(searchLaneMock).not.toHaveBeenCalled();
  });

  it('bypasses the index for every structured task reference field', async () => {
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
    expect(searchLaneMock).not.toHaveBeenCalled();
  });

  it('returns a standalone session ID without invoking the index', async () => {
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
    expect(searchLaneMock).not.toHaveBeenCalled();
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
    searchLaneMock.mockResolvedValue([laneHit({
      ref: 'unrelated-task',
      title: 'Unrelated semantic result',
      text: 'Numeric noise',
      score: 99,
    })]);

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
    expect(searchLaneMock).not.toHaveBeenCalled();
  });

  it('answers a partial session id with its authoritative owner alone, never waking the index', async () => {
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
    searchLaneMock.mockResolvedValue([laneHit({
      ref: 'semantic-task',
      title: 'Semantic companion result',
      text: 'Related implementation',
      score: 1,
    })]);

    const res = await request(createApp())
      .get('/api/search')
      .query({ q: SESSION_ID.slice(0, 8), types: 'task' });

    expect(res.status).toBe(200);
    // A PREFIX is a lookup too: the owner comes from SessionRecord.taskId (which
    // is authoritative over the stale task-side session_ids link) and is scored
    // 0.99 for "prefix, not exact". The ranked lane is not consulted at all — the
    // companion hit it was ready to serve would have ranked below the owner
    // anyway, and asking for it cost an embedder warm on every pasted id.
    expect(res.body.results).toEqual([
      expect.objectContaining({
        taskId: authoritativeTask.id,
        sessionId: SESSION_ID,
        score: 0.99,
      }),
    ]);
    expect(searchLaneMock).not.toHaveBeenCalled();
  });

  it('asks the index lane for the task kind on an ordinary interactive query', async () => {
    searchLaneMock.mockResolvedValue([laneHit({
      ref: 'semantic-task-id',
      title: 'Semantic result',
      text: 'Related achievement',
      score: 0.82,
    })]);

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
    // The call shape IS the contract on this interactive path: one lane call,
    // the caller's limit, and no extra scoring knob (an in-process quality pass
    // here used to freeze every route in the app for seconds per query).
    expect(searchLaneMock).toHaveBeenCalledWith(
      'career accomplishments',
      { kinds: ['task'], limit: 20 },
    );
  });

  it('falls back to session metadata when the index session lane fails', async () => {
    listSessionsMock.mockResolvedValue([{
      claudeSessionId: 'session-fallback-id',
      title: 'Authentication middleware investigation',
      description: 'Debugged refresh token rotation',
    }]);
    searchLaneMock.mockRejectedValue(new Error('index unavailable'));

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

  it('asks the index lane for the session kind on an ordinary interactive query', async () => {
    searchLaneMock.mockResolvedValue([laneHit({
      kind: 'session',
      ref: 'semantic-session-id',
      title: 'Semantic session result',
      text: 'Related implementation work',
      score: 0.76,
    })]);

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
    expect(searchLaneMock).toHaveBeenCalledWith(
      'implementation discussion',
      { kinds: ['session'], limit: 20 },
    );
  });

  it('surfaces a total index failure instead of returning an authoritative empty set', async () => {
    searchLaneMock.mockRejectedValue(new Error('index unavailable'));

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
      expect(searchLaneMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
      else process.env.WALNUT_DISABLE_SEARCH = previous;
    }
  });
});
