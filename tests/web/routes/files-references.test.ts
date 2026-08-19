/**
 * GET /api/files/references through the real HTTP edge (express + supertest).
 *
 * The contract: cmd+clicking an identifier in the Files viewer resolves the
 * containing repo and returns classified matches (definitions first) in ONE
 * request. Bad input never reaches a subprocess (400s), and a symbol with no
 * hits is an empty result, not an error.
 *
 * Like files-list-self-heal.test.ts this deliberately does NOT mock
 * child_process — git grep IS the implementation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
let mainGo: string;

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-refs-')));
  mainGo = path.join(tmp, 'controller.go');
  await fs.writeFile(mainGo, [
    'package marina',
    '',
    'func (f *Factory) HasSyncedForItems(gate []string) bool {',
    '\treturn true',
    '}',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(tmp, 'caller.go'), [
    'package marina',
    '',
    'func run() {',
    '\tsyncedFn = func() bool { return c.factory.HasSyncedForItems(gates) }',
    '}',
    '',
  ].join('\n'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore', env });
  execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore', env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: tmp, stdio: 'ignore', env });
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/files/references', () => {
  it('finds and classifies matches across the repo, definitions first', async () => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: mainGo, symbol: 'HasSyncedForItems' });
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('HasSyncedForItems');
    expect(res.body.tool).toBe('git-grep');
    expect(res.body.matches).toHaveLength(2);
    // Definition sorts first even though 'caller.go' < 'controller.go' by path.
    expect(res.body.matches[0].kind).toBe('def');
    expect(res.body.matches[0].file).toBe(mainGo);
    expect(res.body.matches[0].line).toBe(3);
    expect(res.body.matches[1].kind).toBe('ref');
    expect(res.body.matches[1].file).toBe(path.join(tmp, 'caller.go'));
    expect(res.body.matches[1].line).toBe(4);
  });

  it('zero matches is a 200 with an empty list, not an error', async () => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: mainGo, symbol: 'NoSuchIdentifier' });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  it('rejects a non-identifier symbol before any subprocess runs', async () => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: mainGo, symbol: 'a; rm -rf /' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid symbol/);
  });

  it('rejects a relative path', async () => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: 'controller.go', symbol: 'HasSyncedForItems' });
    expect(res.status).toBe(400);
  });

  it('rejects traversal — the read path\'s sandbox applies here too', async () => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: `${tmp}/../../etc/hosts`, symbol: 'localhost' });
    expect(res.status).toBe(400);
  });

  // A reference search RETURNS matched LINES, so grepping a secrets dir would
  // hand back the secrets themselves. The gate must hold regardless of mode.
  it.each([
    ['~/.aws/credentials', path.join(os.homedir(), '.aws', 'credentials')],
    ['~/.ssh/id_rsa', path.join(os.homedir(), '.ssh', 'id_rsa')],
    ['a config.yaml', path.join(os.homedir(), 'anywhere', 'config.yaml')],
  ])('refuses a secret path (%s) with 403', async (_label, secret) => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: secret, symbol: 'aws_access_key_id' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/AKIA|PRIVATE KEY/);
  });

  it('unknown remote host → 404', async () => {
    const res = await request(createApp())
      .get('/api/files/references')
      .query({ path: mainGo, symbol: 'HasSyncedForItems', host: 'no-such-host-xyz' });
    expect(res.status).toBe(404);
  });
});
