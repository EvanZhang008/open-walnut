/**
 * POST /api/sessions/quick-start — createCwd flag ("create & start").
 *
 * createCwd:true mkdirs the cwd (recursive) BEFORE quickStartSession; without
 * the flag behavior is unchanged (no mkdir, task still created — existence is
 * checked later at spawn). mkdir failure → 400 with the error message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));

// Capture daemon RPC calls for the remote branch
const daemonSendCalls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
  getDaemonConnection: async () => ({
    send: async (cmd: string, params: Record<string, unknown>) => {
      daemonSendCalls.push({ cmd, params });
      return { ok: true, created: true, resolvedPath: params.path };
    },
  }),
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
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

let tmpRoot: string;

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  daemonSendCalls.length = 0;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-createcwd-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('POST /api/sessions/quick-start — createCwd', () => {
  it('createCwd:true creates the local directory before starting', async () => {
    const app = createApp();
    const target = path.join(tmpRoot, 'brand/new/dir');
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: target, message: 'go', createCwd: true });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toBeTruthy();
    const st = await fs.stat(target);
    expect(st.isDirectory()).toBe(true);
  });

  it('without the flag: no mkdir, request still succeeds (spawn-time check is the net)', async () => {
    const app = createApp();
    const target = path.join(tmpRoot, 'never/created');
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: target, message: 'go' });

    expect(res.status).toBe(200);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('mkdir failure → 400 with the error surfaced', async () => {
    const app = createApp();
    // A path whose parent is a FILE — mkdir must fail with ENOTDIR
    const fileParent = path.join(tmpRoot, 'iamafile');
    await fs.writeFile(fileParent, 'x');
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: path.join(fileParent, 'child'), message: 'go', createCwd: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot create directory');
  });

  it('rejects shell metacharacters in cwd when createCwd is set', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/$(evil)', message: 'go', createCwd: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid characters');
  });

  it('local ~/ cwd expands against the home directory once, at the route edge', async () => {
    const home = vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    try {
      const app = createApp();
      const res = await request(app).post('/api/sessions/quick-start')
        .send({ cwd: '~/nested/plug', message: 'go', createCwd: true });
      expect(res.status).toBe(200);
      const st = await fs.stat(path.join(tmpRoot, 'nested/plug'));
      expect(st.isDirectory()).toBe(true);
    } finally {
      home.mockRestore();
    }
  });

  it('remote host: a ~/ cwd rides to the daemon untouched (its machine, its homedir)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '~/proj', host: 'testhost', message: 'go', createCwd: true });
    expect(res.status).toBe(200);
    const mkdirCall = daemonSendCalls.find(c => c.cmd === 'fs.mkdir');
    expect(mkdirCall!.params.path).toBe('~/proj');
  });

  it('remote host: sends fs.mkdir through the daemon connection', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/home/u/newproj', host: 'testhost', message: 'go', createCwd: true });

    expect(res.status).toBe(200);
    const mkdirCall = daemonSendCalls.find(c => c.cmd === 'fs.mkdir');
    expect(mkdirCall).toBeTruthy();
    expect(mkdirCall!.params.path).toBe('/home/u/newproj');
  });
});
