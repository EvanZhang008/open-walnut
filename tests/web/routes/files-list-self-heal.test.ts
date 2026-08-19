/**
 * GET /api/files/list SELF-HEALING and GET /api/files/resolve-path, through the
 * real HTTP edge.
 *
 * The behavior under test: a click on a path the model wrote is not required to
 * be a path that exists. When the requested path can't be listed, the route
 * resolves it against the session's context (transcript / ancestors / git index /
 * find) and lists what it found. A dead-end `ENOENT: scandir` in the file tree
 * was the entire reported complaint, so "never answer with an errno when the
 * session's own data can locate the file" is the contract here.
 *
 * Deliberately does NOT mock child_process (unlike files.test.ts, whose `open`
 * mock returns empty stdout for every subprocess): the git and find layers ARE
 * subprocesses, so mocking them away would test nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';

const { filesRouter } = await import('../../../src/web/routes/files.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', filesRouter);
  app.use(errorHandler);
  return app;
}

let tmp: string;

async function writeFile(rel: string, content = 'x\n'): Promise<string> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

function initRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore', env });
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-selfheal-')));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/files/list — self-healing', () => {
  it('lists a deep directory when the ref only names its tail', async () => {
    // The reported shape: cwd is A/, the ref is 1/2/3, the truth is A/B/C/1/2/3.
    await writeFile('repo/A/B/C/1/2/3/target.ts');
    initRepo(path.join(tmp, 'repo'));

    const res = await request(createApp()).get('/api/files/list').query({
      path: path.join(tmp, 'repo/A/1/2/3'),   // does not exist
      cwd: path.join(tmp, 'repo/A'),
    });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join(tmp, 'repo/A/B/C/1/2/3'));
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual(['target.ts']);
    // A real hit, so no "couldn't find" flag — the user got what they asked for.
    expect(res.body.requestedPath).toBeUndefined();
    expect(res.body.resolvedVia).toBe('git');
  });

  it('lists a file ref parent and flags the file for preview', async () => {
    await writeFile('repo/pkg/deep/svc/handler.go');
    initRepo(path.join(tmp, 'repo'));

    const res = await request(createApp()).get('/api/files/list').query({
      path: path.join(tmp, 'repo/svc/handler.go'),   // missing the pkg/deep prefix
      cwd: path.join(tmp, 'repo'),
    });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join(tmp, 'repo/pkg/deep/svc'));
    expect(res.body.selectedFile).toBe('handler.go');
  });

  it('falls back to the nearest existing folder and says what it could not find', async () => {
    await fs.mkdir(path.join(tmp, 'repo/src'), { recursive: true });
    await writeFile('repo/src/present.ts');

    const missing = path.join(tmp, 'repo/src/absent/never/here');
    const res = await request(createApp()).get('/api/files/list').query({
      path: missing,
      cwd: path.join(tmp, 'repo'),
    });

    // 200 with a usable listing, NOT a 400 errno.
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join(tmp, 'repo/src'));
    expect(res.body.requestedPath).toBe(missing);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toContain('present.ts');
  });

  it('keeps the old 400 when no session context is supplied', async () => {
    // Healing is opt-in via cwd/sessionId. An old client must see old behavior.
    const res = await request(createApp()).get('/api/files/list').query({
      path: path.join(tmp, 'nope'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot list directory');
  });

  it('still rejects traversal and metacharacters BEFORE any healing', async () => {
    const traversal = await request(createApp()).get('/api/files/list').query({
      path: `${tmp}/../etc`, cwd: tmp,
    });
    expect(traversal.status).toBe(400);
    expect(traversal.body.error).toBe('Invalid path');

    const meta = await request(createApp()).get('/api/files/list').query({
      path: `${tmp};rm -rf /`, cwd: tmp,
    });
    expect(meta.status).toBe(400);
  });

  it('does not disturb a path that lists fine', async () => {
    await writeFile('repo/src/a.ts');
    await writeFile('repo/src/b.ts');
    const res = await request(createApp()).get('/api/files/list').query({
      path: path.join(tmp, 'repo/src'), cwd: path.join(tmp, 'repo'),
    });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join(tmp, 'repo/src'));
    expect(res.body.requestedPath).toBeUndefined();
    expect(res.body.resolvedVia).toBeUndefined();
  });
});

describe('GET /api/files/resolve-path', () => {
  it('resolves a deep relative ref from a shallow cwd', async () => {
    const target = await writeFile('repo/A/B/C/1/2/3.ts');
    initRepo(path.join(tmp, 'repo'));

    const res = await request(createApp()).get('/api/files/resolve-path').query({
      rel: '1/2/3.ts', cwd: path.join(tmp, 'repo/A'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: target, resolved: true, via: 'git' });
  });

  it('uses the session transcript when a sessionId is given', async () => {
    const target = await writeFile('A/B/C/1/2/3.ts');
    const cwd = path.join(tmp, 'A');
    // The resolver reads $HOME/.claude/projects — point HOME at the temp tree.
    const home = path.join(tmp, 'home');
    const projectDir = path.join(home, '.claude/projects', cwd.replace(/[/.]/g, '-'));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'sid-x.jsonl'), JSON.stringify({
      type: 'assistant', cwd,
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: target } }] },
    }) + '\n');

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const res = await request(createApp()).get('/api/files/resolve-path').query({
        rel: '1/2/3.ts', cwd, sessionId: 'sid-x',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ path: target, resolved: true, via: 'transcript' });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it('passes an EXISTING absolute path through untouched', async () => {
    // Load-bearing: an absolute path that exists must never be "improved" into
    // some other file that happens to share a suffix.
    const abs = await writeFile('repo/x.ts');
    await writeFile('repo/deep/nested/x.ts');
    initRepo(path.join(tmp, 'repo'));

    const res = await request(createApp()).get('/api/files/resolve-path').query({
      rel: abs, cwd: path.join(tmp, 'repo'),
    });
    expect(res.body).toMatchObject({ path: abs, resolved: true, via: 'exact' });
  });

  it('repairs a WRONG absolute prefix instead of claiming it resolved', async () => {
    // The old code returned every absolute ref as resolved:true unchecked, so a
    // stale checkout prefix looked fine and then failed in the listing.
    const target = await writeFile('repo/src/web/routes/files.ts');
    initRepo(path.join(tmp, 'repo'));

    const res = await request(createApp()).get('/api/files/resolve-path').query({
      rel: '/some/other/checkout/src/web/routes/files.ts',
      cwd: path.join(tmp, 'repo'),
    });
    expect(res.body).toMatchObject({ path: target, resolved: true });
  });

  it('reports resolved:false with a usable fallback when nothing matches', async () => {
    await fs.mkdir(path.join(tmp, 'repo'), { recursive: true });
    const res = await request(createApp()).get('/api/files/resolve-path').query({
      rel: 'no/such/file.ts', cwd: path.join(tmp, 'repo'),
    });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(false);
    expect(typeof res.body.path).toBe('string');
    expect(res.body.path.length).toBeGreaterThan(0);
  });

  it('rejects traversal and metacharacters', async () => {
    const trav = await request(createApp()).get('/api/files/resolve-path').query({ rel: '../x.ts', cwd: tmp });
    expect(trav.status).toBe(400);
    const meta = await request(createApp()).get('/api/files/resolve-path').query({ rel: 'a/$(id)/x.ts', cwd: tmp });
    expect(meta.status).toBe(400);
  });
});
