/**
 * GET /api/sessions/list-dirs — remote host `pending` contract.
 *
 * A first connect to a fresh host installs the session daemon and can run over
 * a minute. The legacy contract waited 15s then answered 400 ("not
 * responding"); the web picker now opts into `pending=1` and gets, after a short
 * wait, HTTP 200 with either `{ pending }` (which connect step is running) or
 * `{ hostError }` (cause + next step). Callers that do not opt in (the frozen
 * mobile contract) still get the old behaviour.
 *
 * The daemon connection is faked at the module boundary: no ssh is spawned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));

// One controllable connect per test: `connectGate` resolves/rejects it.
let connectGate: { resolve: (c: unknown) => void; reject: (e: Error) => void } | null = null;
let connectState = { phase: 'idle' as string, phaseElapsedMs: 0, error: undefined as string | undefined, retryInMs: undefined as number | undefined };
const clearFailureCache = vi.fn();

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: (host?: string) => clearFailureCache(host),
  getDaemonConnection: () => new Promise((resolve, reject) => { connectGate = { resolve, reject }; }),
  getDaemonConnectState: (host: string) => ({ host, connected: false, ...connectState }),
}));
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({
    hosts: {
      devbox: { hostname: 'devbox.example.test', user: 'me', label: 'Big dev box' },
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

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

const fakeConn = (dirs: string[]) => ({
  send: async (_cmd: string, params: Record<string, unknown>) => ({
    ok: true, path: params.path, entries: dirs.map(name => ({ name, type: 'dir' })),
  }),
});

beforeEach(() => {
  connectGate = null;
  connectState = { phase: 'idle', phaseElapsedMs: 0, error: undefined, retryInMs: undefined };
  clearFailureCache.mockClear();
});

describe('GET /api/sessions/list-dirs?pending=1 — remote host still connecting', () => {
  it('answers 200 { pending } with the connect phase after `wait` ms, dirs empty', async () => {
    connectState = { phase: 'install-runtime', phaseElapsedMs: 4200, error: undefined, retryInMs: undefined };
    const res = await request(createApp()).get('/api/sessions/list-dirs')
      .query({ prefix: '~/', host: 'devbox', pending: '1', wait: '50' });
    expect(res.status).toBe(200);
    expect(res.body.dirs).toEqual([]);
    expect(res.body.exists).toBe(true);
    expect(res.body.pending).toMatchObject({ phase: 'install-runtime', elapsedMs: 4200 });
    expect(res.body.pending.label).toMatch(/Installing the session daemon runtime on Big dev box/);
    expect(res.body.hostError).toBeUndefined();
    // The connect keeps running after the answer (the next poll picks it up).
    expect(connectGate).not.toBeNull();
  });

  it('answers 200 { hostError } with kind + hint when the connect fails', async () => {
    connectState = { phase: 'failed', phaseElapsedMs: 0, error: 'Permission denied (publickey).', retryInMs: 58_000 };
    const app = createApp();
    const pending = request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '~/', host: 'devbox', pending: '1', wait: '5000' })
      .then(r => r); // supertest sends only once awaited; start it now
    // Let the route reach getDaemonConnection, then fail the connect.
    await vi.waitFor(() => { if (!connectGate) throw new Error('not yet'); });
    connectGate!.reject(new Error('Command failed: ssh -o BatchMode=yes me@devbox.example.test\nme@devbox.example.test: Permission denied (publickey).'));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.dirs).toEqual([]);
    expect(res.body.pending).toBeUndefined();
    expect(res.body.hostError).toMatchObject({ kind: 'auth', message: 'Permission denied (publickey).', retryInMs: 58_000 });
    expect(res.body.hostError.hint).toMatch(/ssh me@devbox\.example\.test/);
  });

  it('answers the real listing when the connect completes within the wait', async () => {
    const app = createApp();
    const pending = request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '/home/me/', host: 'devbox', pending: '1', wait: '5000' })
      .then(r => r);
    await vi.waitFor(() => { if (!connectGate) throw new Error('not yet'); });
    connectGate!.resolve(fakeConn(['alpha', 'beta']));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeUndefined();
    expect(res.body.hostError).toBeUndefined();
    expect(res.body.dirs).toEqual(expect.arrayContaining(['/home/me/alpha', '/home/me/beta']));
  });

  it('EACCES on a CONNECTED host is kind "listing" (it used to read as an SSH key problem)', async () => {
    const app = createApp();
    const pending = request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '/root/secret/', host: 'devbox', pending: '1', wait: '5000' })
      .then(r => r);
    await vi.waitFor(() => { if (!connectGate) throw new Error('not yet'); });
    connectGate!.resolve({
      send: async () => ({ ok: false, error: "fs.ls failed: EACCES: permission denied, scandir '/root/secret'" }),
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.dirs).toEqual([]);
    expect(res.body.hostError).toMatchObject({ kind: 'listing' });
    expect(res.body.hostError.message).toMatch(/EACCES/);
    expect(res.body.hostError.hint).toMatch(/Big dev box is connected/);
    expect(res.body.hostError.hint).not.toMatch(/ssh/i);
  });

  it('a cached remote listing keeps the daemon-RESOLVED parent (the raw "~/" made every dir fall out client-side)', async () => {
    const app = createApp();
    // Own prefix so this test's 60s cache entry never leaks into the other
    // tests' "~/" requests (the dirCache is module-level).
    const first = request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '~/proj/', host: 'devbox', pending: '1', wait: '5000' })
      .then(r => r);
    await vi.waitFor(() => { if (!connectGate) throw new Error('not yet'); });
    const conn = {
      send: async (_cmd: string, params: Record<string, unknown>) => ({
        ok: true, resolvedPath: '/local/home/me/proj', path: params.path,
        entries: [{ name: 'work', type: 'dir' }],
      }),
    };
    connectGate!.resolve(conn);
    const r1 = await first;
    expect(r1.body.parent).toBe('/local/home/me/proj/');
    expect(r1.body.dirs).toContain('/local/home/me/proj/work');

    // Second call within the 60s server cache: answered from the cache BEFORE
    // any connect (the gate stays unarmed), with the SAME resolved parent.
    connectGate = null;
    const r2 = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '~/proj/', host: 'devbox', pending: '1', wait: '200' });
    expect(connectGate).toBeNull();
    expect(r2.body.cached).toBe(true);
    expect(r2.body.parent).toBe('/local/home/me/proj/');
    expect(r2.body.dirs).toContain('/local/home/me/proj/work');
  });

  it('WITHOUT pending=1 a failed connect is still a 400 (frozen mobile contract)', async () => {
    const app = createApp();
    const pending = request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '~/', host: 'devbox' })
      .then(r => r);
    await vi.waitFor(() => { if (!connectGate) throw new Error('not yet'); });
    connectGate!.reject(new Error('ssh: Could not resolve hostname devbox.example.test'));
    const res = await pending;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Could not resolve hostname/);
    expect(res.body.hostError).toBeUndefined();
  });

  it('wait=0 answers pending at once (0 is a real value, not "use the 3s default")', async () => {
    const t0 = Date.now();
    const res = await request(createApp()).get('/api/sessions/list-dirs')
      .query({ prefix: '~/', host: 'devbox', pending: '1', wait: '0' });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a garbage wait falls back to the default rather than hanging or throwing', async () => {
    const t0 = Date.now();
    const res = await request(createApp()).get('/api/sessions/list-dirs')
      .query({ prefix: '~/', host: 'devbox', pending: '1', wait: 'soon' });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeDefined();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    expect(elapsed).toBeLessThan(6000);
  });
});

describe('POST /api/sessions/host-retry', () => {
  it('clears the connect failure cache for a configured host', async () => {
    const res = await request(createApp()).post('/api/sessions/host-retry').send({ host: 'devbox' });
    expect(res.status).toBe(200);
    expect(clearFailureCache).toHaveBeenCalledWith('devbox');
  });

  it('rejects an unknown host (404) and a missing/local host (400)', async () => {
    const app = createApp();
    expect((await request(app).post('/api/sessions/host-retry').send({ host: 'nope' })).status).toBe(404);
    expect((await request(app).post('/api/sessions/host-retry').send({})).status).toBe(400);
    expect((await request(app).post('/api/sessions/host-retry').send({ host: '__local__' })).status).toBe(400);
    expect(clearFailureCache).not.toHaveBeenCalled();
  });
});
