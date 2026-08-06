/**
 * Git smart HTTP endpoint tests — real startServer({ port: 0 }) with
 * CLOUD_MODE enabled (constants mock) + temp OPEN_WALNUT_HOME + a temp hub
 * dir (WALNUT_GIT_HUB_DIR) holding a real bare repo. Exercises the actual
 * `git` CLI end-to-end: clone, commit, push, and re-clone through
 * /git/data — the same wire path the Mac uses through Caddy.
 *
 * NOTE: git commands run via ASYNC execFile, never execSync — the Express
 * server lives in THIS process, and a synchronous git call would block the
 * event loop while git waits for the server's HTTP response (deadlock).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Server as HttpServer } from 'node:http';
import { vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

const execFileAsync = promisify(execFile);

// CLOUD_MODE: true rides the constants mock — the git-http router is only
// mounted in cloud mode.
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-git-http-test', { CLOUD_MODE: true }));

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js';
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js';

let server: HttpServer;
let port: number;
let tmpRoot: string;
let hubDir: string;
let hubRepo: string;
let deviceToken: string;

/** Run a git command isolated from the developer's real git setup
 *  (no credential helpers, no terminal prompts, no global identity). */
async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: tmpRoot,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true', // the /usr/bin/true binary — returns empty creds instead of prompting
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      // Apple's Xcode git IGNORES GIT_CONFIG_SYSTEM for its bundled gitconfig
      // (credential.helper=osxkeychain) — with HOME pointed at a tmp dir that
      // helper pops a macOS "Keychain Not Found" dialog on every auth failure.
      // Only NOSYSTEM truly suppresses the bundled config.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'walnut-test',
      GIT_AUTHOR_EMAIL: 'walnut-test@localhost',
      GIT_COMMITTER_NAME: 'walnut-test',
      GIT_COMMITTER_EMAIL: 'walnut-test@localhost',
    },
  });
  return stdout;
}

function cloneUrl(token?: string): string {
  return token
    ? `http://walnut:${token}@127.0.0.1:${port}/git/data`
    : `http://127.0.0.1:${port}/git/data`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-git-http-'));
  hubDir = path.join(tmpRoot, 'hub');
  hubRepo = path.join(hubDir, 'walnut-data.git');
  await fs.mkdir(hubDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', hubRepo]);
  await git(['-C', hubRepo, 'config', 'http.receivepack', 'true']);

  // The router reads WALNUT_GIT_HUB_DIR per request — set before any request.
  process.env.WALNUT_GIT_HUB_DIR = hubDir;

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;

  const device = await createDevice('mac-sync-test');
  deviceToken = device.token;
}, 30_000);

afterAll(async () => {
  await stopServer();
  delete process.env.WALNUT_GIT_HUB_DIR;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetAuthRateLimitForTesting();
});

describe('git smart HTTP data hub (cloud mode)', () => {
  it('clone WITHOUT a token fails (401 challenge, no creds available)', async () => {
    const dest = path.join(tmpRoot, 'clone-anon');
    let failed = false;
    let stderr = '';
    try {
      await git(['clone', cloneUrl(), dest]);
    } catch (err) {
      failed = true;
      stderr = String((err as { stderr?: string }).stderr ?? err);
    }
    expect(failed).toBe(true);
    // GIT_TERMINAL_PROMPT=0 + empty-cred askpass → git cannot answer the 401.
    expect(stderr).toMatch(/401|Authentication failed|could not read/i);
    await expect(fs.access(path.join(dest, '.git'))).rejects.toThrow();
  });

  it('clone with an INVALID token fails', async () => {
    const dest = path.join(tmpRoot, 'clone-bad-token');
    await expect(git(['clone', cloneUrl('0'.repeat(32)), dest])).rejects.toThrow();
  });

  it('clone with the device token succeeds (empty repo)', async () => {
    const dest = path.join(tmpRoot, 'clone-1');
    await git(['clone', cloneUrl(deviceToken), dest]);
    expect((await git(['-C', dest, 'rev-parse', '--is-inside-work-tree'])).trim()).toBe('true');
  });

  it('commit + push lands in the bare hub repo', async () => {
    const dest = path.join(tmpRoot, 'clone-1');
    await git(['-C', dest, 'checkout', '-b', 'main']);
    await fs.writeFile(path.join(dest, 'notes.md'), 'hello from the mac\n');
    await git(['-C', dest, 'add', 'notes.md']);
    await git(['-C', dest, 'commit', '-m', 'sync: first push over smart HTTP']);
    await git(['-C', dest, 'push', '-u', 'origin', 'main']);

    // Object arrived in the hub — verify via the bare repo's own log.
    const log = await git(['-C', hubRepo, 'log', '--oneline', 'main']);
    expect(log).toContain('sync: first push over smart HTTP');
  });

  it('a second clone with the token sees the pushed commit', async () => {
    const dest = path.join(tmpRoot, 'clone-2');
    await git(['clone', cloneUrl(deviceToken), dest]);
    const content = await fs.readFile(path.join(dest, 'notes.md'), 'utf-8');
    expect(content).toContain('hello from the mac');
    expect(await git(['-C', dest, 'log', '--oneline'])).toContain('sync: first push over smart HTTP');
  });

  it('pull WITHOUT credentials fails even after data exists', async () => {
    const dest = path.join(tmpRoot, 'clone-2');
    // Strip the embedded token — now the remote has no credentials.
    await git(['-C', dest, 'remote', 'set-url', 'origin', cloneUrl()]);
    await expect(git(['-C', dest, 'pull', 'origin', 'main'])).rejects.toThrow();
  });

  it('accepts the device token as Bearer on info/refs', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/git/data/info/refs?service=git-upload-pack`,
      { headers: { Authorization: `Bearer ${deviceToken}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    expect(await res.text()).toContain('service=git-upload-pack');
  });

  it('401 without credentials carries a WWW-Authenticate: Basic challenge', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/git/data/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
  });

  it('handles gzip-encoded request bodies (git clients gzip POST bodies)', async () => {
    // Protocol v2 ls-refs request, gzipped — the exact shape a real git client
    // sends with Content-Encoding: gzip. http-backend does NOT gunzip itself;
    // this proves the router's gunzip bridge works.
    const body = zlib.gzipSync(Buffer.from('0014command=ls-refs\n0000', 'utf-8'));
    const res = await fetch(`http://127.0.0.1:${port}/git/data/git-upload-pack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/x-git-upload-pack-request',
        'Content-Encoding': 'gzip',
        'Git-Protocol': 'version=2',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('refs/heads/main');
  });

  it('hub self-maintains: pack count stays bounded across many pushes (post-receive gc --auto)', async () => {
    // 2026-08 incident regression: every push leaves a new pack in a bare repo
    // and nothing ever consolidated them — 32 packs/9.9GB made fetch slower
    // than the Mac's 15s timeout and the retry loop buried the box. The route
    // now spawns `gc --auto` (autoPackLimit=8) after each successful push.
    const dest = path.join(tmpRoot, 'clone-gc');
    await git(['clone', cloneUrl(deviceToken), dest]);
    await git(['-C', dest, 'checkout', '-B', 'main']);
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(path.join(dest, 'churn.txt'), `push ${i}\n`);
      await git(['-C', dest, 'add', 'churn.txt']);
      await git(['-C', dest, 'commit', '-m', `churn ${i}`]);
      await git(['-C', dest, 'push', 'origin', 'main']);
    }
    // gc is spawn-and-forget; give the last one a moment to finish.
    const packDir = path.join(hubRepo, 'objects', 'pack');
    let packs = 0;
    for (let waited = 0; waited < 10_000; waited += 500) {
      packs = (await fs.readdir(packDir)).filter((f) => f.endsWith('.pack')).length;
      if (packs <= 8) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // Without the gc hook this is 12+ (one pack per push); with it, ≤8.
    expect(packs).toBeLessThanOrEqual(8);
  }, 60_000);
});
