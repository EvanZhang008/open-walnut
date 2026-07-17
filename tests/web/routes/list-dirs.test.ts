/**
 * GET /api/sessions/list-dirs — hidden-dirs-at-depth-1 + exists-flag contract.
 *
 * Real tmpdir fixture tree (local branch); the remote branch is covered by
 * dir-listing unit assertions against a fake daemon connection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
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
import { listRemoteDirs, isEnoentLike } from '../../../src/core/sessions/dir-listing.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-listdirs-'));
  // Fixture tree:
  //   root/projects/alpha
  //   root/projects/beta/gamma
  //   root/projects/.hidden          ← hidden at depth 1 (visible)
  //   root/projects/.git/objects     ← hidden at depth 1, must NOT be recursed into
  //   root/projects/alpha/.deep      ← hidden at depth 2 (invisible)
  //   root/projects/file.txt         ← file, never listed
  await fs.mkdir(path.join(root, 'projects/alpha/.deep'), { recursive: true });
  await fs.mkdir(path.join(root, 'projects/beta/gamma'), { recursive: true });
  await fs.mkdir(path.join(root, 'projects/.hidden'), { recursive: true });
  await fs.mkdir(path.join(root, 'projects/.git/objects'), { recursive: true });
  await fs.writeFile(path.join(root, 'projects/file.txt'), 'x');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('GET /api/sessions/list-dirs — local', () => {
  it('lists dirs incl. hidden at depth 1; no hidden at depth 2; no recursion into hidden', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: path.join(root, 'projects') + '/' });

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    const dirs: string[] = res.body.dirs;
    expect(dirs).toContain(path.join(root, 'projects/alpha'));
    expect(dirs).toContain(path.join(root, 'projects/beta'));
    expect(dirs).toContain(path.join(root, 'projects/beta/gamma'));  // depth-2 preload
    expect(dirs).toContain(path.join(root, 'projects/.hidden'));     // hidden depth-1: visible
    expect(dirs).toContain(path.join(root, 'projects/.git'));        // hidden depth-1: visible
    expect(dirs).not.toContain(path.join(root, 'projects/.git/objects')); // never recurse into hidden
    expect(dirs).not.toContain(path.join(root, 'projects/alpha/.deep'));  // hidden depth-2: invisible
    expect(dirs).not.toContain(path.join(root, 'projects/file.txt'));     // files never listed
  });

  it('missing directory → 200 with exists:false (not an error)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: path.join(root, 'nope') + '/' });
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.dirs).toEqual([]);
  });

  it('a FILE path → exists:false (not a directory)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: path.join(root, 'projects/file.txt') + '/' });
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });

  it('partial prefix lists the PARENT dir', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: path.join(root, 'projects/al') });
    expect(res.status).toBe(200);
    expect(res.body.parent).toBe(path.join(root, 'projects'));
    expect(res.body.dirs).toContain(path.join(root, 'projects/alpha'));
  });

  it('rejects shell metacharacters with 400', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '/tmp/$(rm -rf)' });
    expect(res.status).toBe(400);
  });

  it('expands ~ to the local home directory', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/list-dirs')
      .query({ prefix: '~/' });
    expect(res.status).toBe(200);
    expect(res.body.parent).toBe(os.homedir() + '/');
  });
});

describe('listRemoteDirs — daemon branch (fake connection)', () => {
  const fakeConn = (responses: Record<string, unknown>) => ({
    send: async (_cmd: string, params: Record<string, unknown>) => {
      const key = params.path as string;
      const r = responses[key];
      if (!r) return { ok: false, error: `fs.ls failed: ENOENT no such file: ${key}` };
      return r as Record<string, unknown>;
    },
  });

  it('ENOENT-like root error → exists:false, no throw', async () => {
    const listing = await listRemoteDirs(fakeConn({}), '/home/nobody/', 2);
    expect(listing.exists).toBe(false);
    expect(listing.dirs).toEqual([]);
  });

  it('non-ENOENT error throws (maps to HTTP 400 in the route)', async () => {
    const conn = { send: async () => ({ ok: false, error: 'connection reset by peer' }) };
    await expect(listRemoteDirs(conn, '/home/x/', 2)).rejects.toThrow('Cannot list directory');
  });

  it('hidden dirs at depth 1 are emitted but never recursed into', async () => {
    const listing = await listRemoteDirs(fakeConn({
      '/h/': { ok: true, resolvedPath: '/h', entries: [
        { name: 'proj', type: 'dir' },
        { name: '.claude', type: 'dir' },
        { name: 'notes.md', type: 'file' },
      ]},
      '/h/proj': { ok: true, entries: [{ name: 'sub', type: 'dir' }, { name: '.git', type: 'dir' }] },
      // '/h/.claude' deliberately absent — walking into it would return ok:false
    }), '/h/', 2);
    expect(listing.exists).toBe(true);
    expect(listing.dirs).toContain('/h/proj');
    expect(listing.dirs).toContain('/h/.claude');   // hidden depth-1 visible
    expect(listing.dirs).toContain('/h/proj/sub');  // depth-2 preload
    expect(listing.dirs).not.toContain('/h/proj/.git'); // hidden depth-2 invisible
  });

  it('isEnoentLike matches cwd-check semantics', () => {
    expect(isEnoentLike('fs.ls failed: ENOENT: no such file or directory')).toBe(true);
    expect(isEnoentLike('No such file or directory')).toBe(true);
    expect(isEnoentLike('not a directory')).toBe(true);
    expect(isEnoentLike('connection reset')).toBe(false);
  });
});
