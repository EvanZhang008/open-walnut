import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';

// `open` is mocked for the whole file: POST /api/files/reveal spawns it, and a
// test suite must never actually pop Finder / launch an app on the machine
// running it. The mock records argv so the tests can assert the exact command,
// and calls back with success unless a test overrides it.
const execFileMock = vi.fn(
  (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
    cb?.(null);
    return { on: () => {} };
  },
);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...(args as [string, string[], unknown, ((e: Error | null) => void)?])) };
});

const { WALNUT_HOME } = await import('../../../src/constants.js');
const { filesRouter, isRevealSecretPath } = await import('../../../src/web/routes/files.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', filesRouter);
  app.use(errorHandler);
  return app;
}

let tmpDir: string;

beforeEach(async () => {
  execFileMock.mockClear();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-files-test-'));
  await fs.mkdir(path.join(tmpDir, 'src'));
  await fs.mkdir(path.join(tmpDir, 'docs'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Hello\n');
  await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(tmpDir, '.hidden'), 'secret\n');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/files/list (local)', () => {
  it('lists one level with dirs before files, alphabetically', async () => {
    const res = await request(createApp()).get('/api/files/list').query({ path: tmpDir });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(tmpDir);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    // dirs first (docs, src), then files case-insensitively (index.ts before README.md);
    // .hidden excluded
    expect(names).toEqual(['docs', 'src', 'index.ts', 'README.md']);
  });

  it('tags entry types correctly and includes file sizes', async () => {
    const res = await request(createApp()).get('/api/files/list').query({ path: tmpDir });
    const byName = Object.fromEntries(
      res.body.entries.map((e: { name: string; type: string; size?: number }) => [e.name, e]),
    );
    expect(byName['src'].type).toBe('dir');
    expect(byName['README.md'].type).toBe('file');
    expect(byName['README.md'].size).toBeGreaterThan(0);
  });

  it('hides dotfiles by default but reveals them with showHidden=1', async () => {
    const hidden = await request(createApp()).get('/api/files/list').query({ path: tmpDir });
    expect(hidden.body.entries.some((e: { name: string }) => e.name === '.hidden')).toBe(false);

    const shown = await request(createApp())
      .get('/api/files/list')
      .query({ path: tmpDir, showHidden: '1' });
    expect(shown.body.entries.some((e: { name: string }) => e.name === '.hidden')).toBe(true);
  });

  it('rejects directory traversal', async () => {
    const res = await request(createApp())
      .get('/api/files/list')
      .query({ path: `${tmpDir}/../etc` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid path');
  });

  it('rejects shell metacharacters', async () => {
    const res = await request(createApp())
      .get('/api/files/list')
      .query({ path: `${tmpDir};rm -rf /` });
    expect(res.status).toBe(400);
  });

  it('rejects relative (non-absolute) local paths', async () => {
    const res = await request(createApp()).get('/api/files/list').query({ path: 'relative/dir' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Path must be absolute');
  });

  it('returns 400 for a missing path parameter', async () => {
    const res = await request(createApp()).get('/api/files/list');
    expect(res.status).toBe(400);
  });

  it('returns 400 when the directory does not exist', async () => {
    const res = await request(createApp())
      .get('/api/files/list')
      .query({ path: path.join(tmpDir, 'nope') });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot list directory');
  });

  it('classifies a symlink-to-directory as a dir (follows the link)', async () => {
    // readdir withFileTypes uses lstat → a symlinked dir looks like a file unless
    // we stat() it. Verify the route resolves it to type 'dir'.
    await fs.symlink(path.join(tmpDir, 'src'), path.join(tmpDir, 'src-link'), 'dir');
    const res = await request(createApp()).get('/api/files/list').query({ path: tmpDir });
    const link = res.body.entries.find((e: { name: string }) => e.name === 'src-link');
    expect(link).toBeDefined();
    expect(link.type).toBe('dir');
  });
});

// ─── POST /api/files/reveal ──────────────────────────────────────────────────
// Backs the file-explorer right-click menu's "Reveal in Finder / Open in default
// app". Every test here asserts a GUARD, or asserts the exact `open` argv — the
// real spawn is mocked, because a passing test must never actually pop Finder on
// the developer's machine.
//
// The route is macOS-only by design (it hands a path to Finder), so these tests
// PIN the platform instead of inheriting the host's. Without the pin they passed
// on a Mac and 400'd on Linux CI — eight failures that said nothing about the
// code under test. A test for platform-gated behaviour must state which platform
// it is testing; the gate is what's under test, not an ambient fact.
describe('POST /api/files/reveal', () => {
  let platformSpy: ReturnType<typeof vi.spyOn> | undefined;
  beforeEach(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin') as never;
  });
  afterEach(() => {
    platformSpy?.mockRestore();
  });

  it('rejects a non-macOS platform', async () => {
    // The route reads process.platform at request time, so a per-test override
    // covers both directions on one machine.
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const res = await request(createApp())
        .post('/api/files/reveal')
        .send({ path: path.join(tmpDir, 'README.md'), mode: 'finder' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('macOS');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects an unknown mode', async () => {
    const res = await request(createApp())
      .post('/api/files/reveal')
      .send({ path: path.join(tmpDir, 'README.md'), mode: 'vscode' });
    expect(res.status).toBe(400);
  });

  it('rejects a remote (host) path — the file lives on another machine', async () => {
    const res = await request(createApp())
      .post('/api/files/reveal')
      .send({ path: path.join(tmpDir, 'README.md'), mode: 'finder', host: 'clouddev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Remote');
  });

  it('rejects a relative path', async () => {
    const res = await request(createApp())
      .post('/api/files/reveal')
      .send({ path: 'README.md', mode: 'finder' });
    expect(res.status).toBe(400);
  });

  it('rejects a traversal SEGMENT', async () => {
    const res = await request(createApp())
      .post('/api/files/reveal')
      .send({ path: `${tmpDir}/../README.md`, mode: 'finder' });
    expect(res.status).toBe(400);
  });

  it('404s a path that does not exist', async () => {
    const res = await request(createApp())
      .post('/api/files/reveal')
      .send({ path: path.join(tmpDir, 'nope.md'), mode: 'finder' });
    expect(res.status).toBe(404);
  });

  it('refuses to LAUNCH an executable type, but still reveals it', async () => {
    const script = path.join(tmpDir, 'danger.command');
    await fs.writeFile(script, '#!/bin/sh\necho pwned\n');
    const app = createApp();

    const launch = await request(app).post('/api/files/reveal').send({ path: script, mode: 'app' });
    expect(launch.status).toBe(400);
    expect(launch.body.error).toContain('.command');
    expect(execFileMock).not.toHaveBeenCalled();

    const revealed = await request(app).post('/api/files/reveal').send({ path: script, mode: 'finder' });
    expect(revealed.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith('open', ['-R', script], expect.anything(), expect.anything());
  });

  it('refuses every file under the Plugin secret store', () => {
    expect(isRevealSecretPath(path.join(WALNUT_HOME, 'secrets', 'plugins', 'sample.json'))).toBe(true);
  });

  it("refuses a secret path (never hands ~/.aws or a config.yaml to the desktop)", async () => {
    const cfg = path.join(tmpDir, 'config.yaml');
    await fs.writeFile(cfg, 'provider: {}\n');
    const res = await request(createApp()).post('/api/files/reveal').send({ path: cfg, mode: 'app' });
    expect(res.status).toBe(403);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('reveals a plain file with `open -R`', async () => {
    const file = path.join(tmpDir, 'README.md');
    const res = await request(createApp()).post('/api/files/reveal').send({ path: file, mode: 'finder' });
    expect(res.status).toBe(200);
    expect(res.body.fullPath).toBe(file);
    expect(execFileMock).toHaveBeenCalledWith('open', ['-R', file], expect.anything(), expect.anything());
  });

  it('opens a file in its default app with bare `open`', async () => {
    const file = path.join(tmpDir, 'README.md');
    const res = await request(createApp()).post('/api/files/reveal').send({ path: file, mode: 'app' });
    expect(res.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith('open', [file], expect.anything(), expect.anything());
  });

  it('allows LAUNCHING a directory (Finder opens it) despite the exec denylist', async () => {
    const dir = path.join(tmpDir, 'src');
    const res = await request(createApp()).post('/api/files/reveal').send({ path: dir, mode: 'app' });
    expect(res.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith('open', [dir], expect.anything(), expect.anything());
  });

  it('surfaces an `open` failure as a 500 (never a silently dead menu item)', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as (e: Error | null) => void)(new Error('open: no application'));
      return { on: () => {} };
    });
    const res = await request(createApp())
      .post('/api/files/reveal')
      .send({ path: path.join(tmpDir, 'README.md'), mode: 'app' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('open failed');
  });
});
