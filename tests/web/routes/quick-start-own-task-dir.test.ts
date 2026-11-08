/**
 * POST /api/sessions/quick-start with `ownTaskDir` (the browser extension's New task, which has no
 * folder picker): a new task on this machine with no folder starts in its own task directory,
 * made right after the task is filed and recorded as its folder, and titled from the person's own
 * words at once (never "Session: <its id>", which named the task by its folder). Every other launch without a cwd is still refused, as for an older
 * client, and the flag never moves a launch that names a folder, a host or an existing task.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
// The host Start gate has its own tests (tests/core/sessions/host-start-gate.test.ts);
// these launches are the ones past it.
vi.mock('../../../src/core/sessions/host-start-gate.js', () => ({ hostStartGate: async () => null }));

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));

// Capture daemon RPC calls for the remote branch
const daemonSendCalls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
/** The dial fails as the pool's link failure, with the dial's raw words. */
const dial = vi.hoisted(() => ({ fails: false }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
  getDaemonConnection: async () => {
    if (dial.fails) {
      const { markLinkFailure } = await import('../../../src/providers/link-failure.js');
      throw markLinkFailure(new Error('ssh: connect to host testhost.example port 22: Connection refused'), 'no-link');
    }
    return {
      send: async (cmd: string, params: Record<string, unknown>) => {
        daemonSendCalls.push({ cmd, params });
        return { ok: true, created: true, resolvedPath: params.path };
      },
    };
  },
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

// Remote host must exist in config for the daemon branch. Merge onto the REAL
// config — task-manager reads config.defaults.priority etc., so a bare
// {hosts} replacement 500s every quick-start.
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/config-manager.js')>();
  return {
    ...mod,
    getConfig: async () => ({
      ...(await mod.getConfig()),
      hosts: { testhost: { hostname: 'testhost.example', user: 'u' } },
    }),
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager, getTask } from '../../../src/core/task-manager.js';
import { titleFromWords } from '../../../src/core/sessions/quick-start.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

let tmpRoot: string;
const prevRoot = process.env.WALNUT_TASK_DIR_ROOT;

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  daemonSendCalls.length = 0;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-own-dir-'));
  process.env.WALNUT_TASK_DIR_ROOT = path.join(tmpRoot, 'tasks');
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.WALNUT_TASK_DIR_ROOT;
  else process.env.WALNUT_TASK_DIR_ROOT = prevRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('POST /api/sessions/quick-start: ownTaskDir', () => {
  it('a new task with no folder starts in its own task directory, made and recorded as its folder', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '', message: 'Find the receipt for order 40917', ownTaskDir: true, taskMeta: { pinTier: 'focus' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const taskId = String(res.body.taskId);
    const dir = path.join(tmpRoot, 'tasks', taskId);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    const task = await getTask(taskId);
    expect(task.cwd).toBe(dir);
    // Named by the person's words, not by its folder (review round 5).
    expect(task.title).toBe('Find the receipt for order 40917');
    expect(res.body.sessionId).toBeTruthy();
  });

  it('long words are cut to a row\'s length, from their first line', async () => {
    const long = 'Compare the three internet plans for the new office and pick the cheapest one that has a static address\nthen book the install';
    const a = await request(createApp()).post('/api/sessions/quick-start').send({ cwd: '', message: long, ownTaskDir: true });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const t = await getTask(String(a.body.taskId));
    expect(t.title.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(t.title)).toBe(true);
    expect(t.title).not.toContain('Session:');
    expect(titleFromWords('\n\n  Book the room  \nmore')).toBe('Book the room');
    expect(titleFromWords('   ')).toBe('');
  });

  it('the flag takes nothing from a launch that names its folder', async () => {
    const own = path.join(tmpRoot, 'repo');
    await fs.mkdir(own);
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: own, message: 'go', ownTaskDir: true });
    expect(res.status).toBe(200);
    expect((await getTask(String(res.body.taskId))).cwd).toBe(own);
    await expect(fs.stat(path.join(tmpRoot, 'tasks', String(res.body.taskId)))).rejects.toThrow();
  });

  it('a new task from the home folder reads naturally at once: the person\'s words, filed under "Home"', async () => {
    // 2026-11-10 review: a new user's New task from the default folder (~) read "New project: ~" and
    // "Session: <their user name>" until a model titled it.
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: '~', message: 'Write a short plan for my week', project: 'Home', projectFromFolder: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const task = await getTask(String(res.body.taskId));
    expect(task.cwd).toBe(os.homedir());
    expect(task.title).toBe('Write a short plan for my week');
    expect(task.project).toBe('Home');
  });

  it('a New task a person typed words into is named by them from any folder; no words, a command or an agent keep "Session: <folder>"', async () => {
    // Review round 2 (WebKit): "Second task" from ~/Projects read "Session: Projects" until a model titled it.
    const own = path.join(tmpRoot, 'tidepool');
    await fs.mkdir(own);
    const named = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: own, message: 'Second task', project: 'tidepool', projectFromFolder: true });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    const t2 = await getTask(String(named.body.taskId));
    expect(t2.title).toBe('Second task');
    expect(t2.project).toBe('tidepool');
    // Long words: cut the way the title brake cuts.
    const long = 'Compare the three internet plans for the new office and pick the cheapest one that has a static address';
    const cut = await request(createApp()).post('/api/sessions/quick-start').send({ cwd: own, message: long });
    const t3 = await getTask(String(cut.body.taskId));
    expect(t3.title.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(t3.title)).toBe(true);
    // No words, or a slash command: the folder is all there is to say.
    const empty = await request(createApp()).post('/api/sessions/quick-start').send({ cwd: own, message: '' });
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect((await getTask(String(empty.body.taskId))).title).toBe('Session: tidepool');
    const command = await request(createApp()).post('/api/sessions/quick-start').send({ cwd: own, message: '/review the diff' });
    expect((await getTask(String(command.body.taskId))).title).toBe('Session: tidepool');
    // An agent's launch through the same route: its words are not the person's.
    const agent = await request(createApp()).post('/api/sessions/quick-start')
      .set('x-walnut-caller-kind', 'automation').send({ cwd: own, message: 'Second task' });
    expect(agent.status, JSON.stringify(agent.body)).toBe(200);
    expect((await getTask(String(agent.body.taskId))).title).toBe('Session: tidepool');
  });

  it('without the flag (an older client), or on a remote host, an empty cwd is still refused', async () => {
    const plain = await request(createApp()).post('/api/sessions/quick-start').send({ cwd: '', message: 'go' });
    expect(plain.status).toBe(400);
    expect(plain.body.error).toBe('cwd is required');
    const remote = await request(createApp()).post('/api/sessions/quick-start').send({ cwd: '', host: 'testhost', message: 'go', ownTaskDir: true });
    expect(remote.status).toBe(400);
    expect(remote.body.error).toBe('cwd is required');
  });
});
