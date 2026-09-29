/**
 * The seam behind "a new session shows its first message at once": a real
 * POST /api/sessions/quick-start records the launch prompt, and the real
 * `session:get-queue` WS method hands it back beside the queue until the first
 * turn's result. Mocks match quick-start-launch-memory.test.ts: nothing spawns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
  getDaemonConnection: async () => ({ send: async () => ({ ok: true }) }),
}));
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));
vi.mock('../../../src/core/session-message-queue.js', () => ({
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession: async () => {},
  editMessage: async () => false,
  deleteMessage: async () => false,
  isMessageQueued: async () => false,
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js';
import { _getRpcMethodForTesting } from '../../../src/web/ws/handler.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { clearLaunchPrompts } from '../../../src/core/sessions/launch-prompts.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

type QueuePayload = { messages: unknown[]; launchPrompt?: { id: string; text: string; at: string } };

async function getQueue(sessionId: string): Promise<QueuePayload> {
  const method = _getRpcMethodForTesting('session:get-queue');
  if (!method) throw new Error('session:get-queue is not registered');
  return await method({ sessionId }, undefined as never) as QueuePayload;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  bus.clear();
  clearLaunchPrompts();
  registerSessionChatRpc();
});

afterEach(async () => {
  bus.clear();
  clearLaunchPrompts();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('session:get-queue carries the launch prompt', () => {
  it('from the quick-start answer until the first turn ends', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'who owns the fire cracker vm?' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sessionId = res.body.sessionId as string;
    expect(sessionId).toBeTruthy();

    // Already there when the answer reaches the browser that opens the panel.
    const open = await getQueue(sessionId);
    expect(open.messages).toEqual([]);
    expect(open.launchPrompt).toMatchObject({ id: `launch-${sessionId}`, text: 'who owns the fire cracker vm?' });

    bus.emit(EventNames.SESSION_RESULT, { sessionId, result: 'done' }, ['web-ui'], { source: 'session-runner' });
    expect((await getQueue(sessionId)).launchPrompt).toBeUndefined();
  });

  it('names the launch by the words, not by the image preamble the CLI gets', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start').send({
      cwd: '/tmp',
      message: 'what is in this picture?',
      // 1x1 PNG
      images: [{ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mediaType: 'image/png', name: 'a.png' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const q = await getQueue(res.body.sessionId as string);
    expect(q.launchPrompt?.text).toBe('what is in this picture?');
  });

  it('is absent for a session that never launched with a prompt', async () => {
    expect((await getQueue('00000000-0000-4000-8000-000000000000')).launchPrompt).toBeUndefined();
  });
});
