/**
 * POST /api/sessions/quick-start — when auto-organize runs.
 *
 * The rule: organize runs for a task the caller left unfiled, and ALSO for one
 * filed under an EXISTING project the draft only took from the folder
 * (`projectFromFolder`), passing that project along so the organize pass can
 * decide whether the folder claim is final (tests/core/session-organize-
 * folder-default.test.ts). A project the user picked, or one this launch creates
 * from the folder's basename, is never second-guessed.
 *
 * Background AI is off under vitest, so the gate is flipped here and the organize
 * module is a spy: this file pins the wiring, not the model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/core/sessions/host-start-gate.js', () => ({ hostStartGate: async () => null }));
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
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
  getQueue: async () => [],
  revertToPending: async () => {},
}));
vi.mock('../../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => false,
}));
// With background AI switched on, every other background pass the launch wakes
// (titles, project summaries) would reach a real model: fail them fast instead.
vi.mock('../../../src/model/model.js', () => ({
  sendMessage: async () => { throw new Error('no model in this test'); },
}));
const organizeSpy = vi.fn(async () => {});
vi.mock('../../../src/core/session-organize.js', () => ({
  organizeQuickStartTask: (...args: unknown[]) => organizeSpy(...args),
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager, getTask, setProjectMetadata } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

/** The organize pass is fire-and-forget behind a dynamic import, so a "never
 *  called" check has to give a call time to arrive before trusting zero. */
async function organizeCalls(): Promise<unknown[][]> {
  await new Promise((r) => setTimeout(r, 300));
  return organizeSpy.mock.calls as unknown[][];
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  organizeSpy.mockClear();
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('quick-start → auto-organize gate', () => {
  it('an existing folder-derived project is handed to organize as the folder default', async () => {
    await setProjectMetadata('Context Agent', { default_cwd: '/work/hub/context/' });
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '/work/hub/context/teams/marina', message: 'triage tickets', project: 'context agent', projectFromFolder: true });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    // Filed under the folder's project right away; organize may move it later.
    expect(task.project).toBe('Context Agent');
    await vi.waitFor(() => expect(organizeSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(organizeSpy.mock.calls[0]).toEqual([
      res.body.taskId, '/work/hub/context/teams/marina', 'triage tickets', { folderProject: 'Context Agent' },
    ]);
  });

  it('an unfiled launch still organizes, with no folder default', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '/work/hub/context/teams/marina', message: 'triage tickets' });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(organizeSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(organizeSpy.mock.calls[0][3]).toEqual({});
  });

  it("a user's project pick is never second-guessed", async () => {
    await setProjectMetadata('Context Agent', { default_cwd: '/work/hub/context' });
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '/work/hub/context/teams/marina', message: 'triage tickets', project: 'Context Agent' });

    expect(res.status).toBe(200);
    expect(await organizeCalls()).toHaveLength(0);
  });

  it('a project this launch creates from the basename is not organized', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '/repos/tidepool', message: 'go', project: 'tidepool', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('tidepool');
    expect(await organizeCalls()).toHaveLength(0);
  });
});
