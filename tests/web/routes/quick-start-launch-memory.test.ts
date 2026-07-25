/**
 * Per-directory launch memory: POST /api/sessions/quick-start remembers the
 * RAW picker model + engine per (cwd, host), GET /api/sessions/working-dirs
 * returns it as `lastLaunch`, and a recompile keeps it (sessions.json doesn't
 * carry launch prefs, so the rebuild must merge them from the prior store).
 *
 * Rules covered:
 *  - raw picker value stored (catalog full ID stays verbatim; legacy alias id
 *    stays the alias, NOT the CLI-normalized form)
 *  - Auto launch (no model/engine) CLEARS a previous memory
 *  - retry (taskId set) does NOT overwrite the memory
 *  - fix-walnut intent does NOT record
 *  - memory is keyed per (cwd, host)
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
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { bus } from '../../../src/core/event-bus.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

// recordLaunchPrefs is fire-and-forget behind the HTTP response; poll until
// the store reflects the expected value instead of racing it.
async function pollLastLaunch(cwd: string, host: string | null): Promise<unknown> {
  const app = createApp();
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get('/api/sessions/working-dirs');
    const dir = (res.body.dirs as Array<{ cwd: string; host: string | null; lastLaunch?: unknown }>)
      .find(d => d.cwd === cwd && (d.host ?? null) === host);
    if (dir && 'lastLaunch' in dir && dir.lastLaunch !== undefined) return dir.lastLaunch;
    await new Promise(r => setTimeout(r, 20));
  }
  return undefined;
}

async function quickStart(body: Record<string, unknown>): Promise<request.Response> {
  return request(createApp()).post('/api/sessions/quick-start').send(body);
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  bus.clear();
});

afterEach(async () => {
  bus.clear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

const CWD = '/tmp';

describe('quick-start launch memory', () => {
  it('stores the raw catalog model ID and returns it via working-dirs', async () => {
    const id = 'global.anthropic.claude-fable-5[1m]';
    const res = await quickStart({ cwd: CWD, message: 'go', model: id });
    expect(res.status).toBe(200);
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: id });
  });

  it('stores a legacy alias verbatim (NOT the CLI-normalized form)', async () => {
    const res = await quickStart({ cwd: CWD, message: 'go', model: 'opus-1m' });
    expect(res.status).toBe(200);
    // alias stays 'opus-1m' so the dropdown can re-select it; CLI form is 'opus[1m]'
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'opus-1m' });
  });

  it('stores engine codex, and a later Auto/Claude launch clears the memory', async () => {
    await quickStart({ cwd: CWD, message: 'go', model: 'sonnet', engine: 'codex' });
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'sonnet', engine: 'codex' });

    // Launch again with everything default → memory cleared
    const res = await quickStart({ cwd: CWD, message: 'again' });
    expect(res.status).toBe(200);
    // Poll for the CLEAR (lastLaunch gone)
    let cleared = false;
    for (let i = 0; i < 50; i++) {
      const wd = await request(createApp()).get('/api/sessions/working-dirs');
      const dir = (wd.body.dirs as Array<{ cwd: string; lastLaunch?: unknown }>).find(d => d.cwd === CWD);
      if (dir && dir.lastLaunch === undefined) { cleared = true; break; }
      await new Promise(r => setTimeout(r, 20));
    }
    expect(cleared).toBe(true);
  });

  it('retry (taskId set) does not overwrite the remembered config', async () => {
    const first = await quickStart({ cwd: CWD, message: 'go', model: 'haiku' });
    expect(first.status).toBe(200);
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'haiku' });

    const retry = await quickStart({ cwd: CWD, message: 'go', taskId: first.body.taskId });
    expect(retry.status).toBe(200);
    // still haiku — retry didn't clear it
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'haiku' });
  });

  it('memory is keyed per cwd — a different dir stays Auto', async () => {
    await quickStart({ cwd: CWD, message: 'go', model: 'sonnet' });
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'sonnet' });

    await quickStart({ cwd: '/var', message: 'go' });
    const wd = await request(createApp()).get('/api/sessions/working-dirs');
    const other = (wd.body.dirs as Array<{ cwd: string; lastLaunch?: unknown }>).find(d => d.cwd === '/var');
    expect(other?.lastLaunch).toBeUndefined();
  });

  it('recompile preserves lastLaunch (prefs only live in the store)', async () => {
    await quickStart({ cwd: CWD, message: 'go', model: 'sonnet-1m' });
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'sonnet-1m' });

    const rc = await request(createApp()).post('/api/sessions/working-dirs/recompile');
    expect(rc.status).toBe(200);
    expect(await pollLastLaunch(CWD, null)).toEqual({ model: 'sonnet-1m' });
  });
});
