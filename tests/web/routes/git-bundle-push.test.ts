/**
 * Chunked bundle push channel — E2E through a REAL server (T65).
 *
 * Why this channel exists: endpoint-security TLS filters on some client
 * machines corrupt long sustained HTTPS uploads, so `git push` of a pack past
 * ~25MB dies mid-stream while small requests always survive. The channel
 * splits a git bundle into chunks, one HTTP request per chunk, and the hub
 * reassembles + verifies + CAS-updates the ref.
 *
 * These tests run the FULL wire path: real startServer (CLOUD_MODE), real
 * bare hub repo, real client repos, and pushViaBundle() — the exact client
 * used by compaction and the sync-tick fallback. Multi-chunk coverage rides a
 * deliberately tiny chunk read (the client constant is 8MB; tests exercise
 * chunk splitting by pushing content larger than one chunk of the REAL size
 * would be silly, so we verify sequencing through the raw HTTP API instead).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

const execFileAsync = promisify(execFile);

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bundle-push-test', { CLOUD_MODE: true }));

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js';
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js';
import { _resetBundlePushForTesting } from '../../../src/web/routes/git-bundle-push.js';
import { pushViaBundle, bundleEndpointFromRemote } from '../../../src/integrations/git-bundle-client.js';

let server: HttpServer;
let port: number;
let tmpRoot: string;
let hubDir: string;
let hubRepo: string;
let deviceToken: string;

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: opts.cwd,
    env: {
      ...process.env,
      HOME: tmpRoot,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'walnut-test',
      GIT_AUTHOR_EMAIL: 'walnut-test@localhost',
      GIT_COMMITTER_NAME: 'walnut-test',
      GIT_COMMITTER_EMAIL: 'walnut-test@localhost',
    },
  });
  return stdout.trim();
}

function remoteUrl(token = deviceToken): string {
  return `http://walnut:${token}@127.0.0.1:${port}/git/data`;
}

/** Make a client repo with `commits` commits of `sizeBytes` random content each. */
async function makeRepo(name: string, commits: number, sizeBytes: number): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: dir });
  for (let i = 0; i < commits; i++) {
    await fs.writeFile(path.join(dir, `blob-${i}.bin`), crypto.randomBytes(sizeBytes));
    await git(['add', '-A'], { cwd: dir });
    await git(['commit', '-q', '-m', `commit ${i}`], { cwd: dir });
  }
  return dir;
}

async function hubTip(): Promise<string | null> {
  try {
    return await git(['-C', hubRepo, 'rev-parse', 'refs/heads/main']);
  } catch {
    return null;
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-bundle-push-'));
  hubDir = path.join(tmpRoot, 'hub');
  hubRepo = path.join(hubDir, 'walnut-data.git');
  await fs.mkdir(hubDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', hubRepo]);
  process.env.WALNUT_GIT_HUB_DIR = hubDir;

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;

  const device = await createDevice('bundle-push-test');
  deviceToken = device.token;
}, 30_000);

afterAll(async () => {
  await stopServer();
  delete process.env.WALNUT_GIT_HUB_DIR;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  _resetAuthRateLimitForTesting();
  await _resetBundlePushForTesting();
});

// ── Raw HTTP API surface ─────────────────────────────────────────────────────

async function api(pathname: string, body: Buffer | string | null, token = deviceToken): Promise<{ status: number; json: () => unknown; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/git/data${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: () => JSON.parse(text), text };
}

describe('bundle push API (raw HTTP)', () => {
  it('rejects unauthenticated start', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/git/data/bundle/start`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('start → out-of-order chunk is refused with the expected nextSeq', async () => {
    const start = await api('/bundle/start', null);
    expect(start.status).toBe(200);
    const { uploadId } = start.json() as { uploadId: string };

    // seq=1 before seq=0 → 409 carrying nextSeq 0.
    const early = await api(`/bundle/chunk?upload=${uploadId}&seq=1`, Buffer.from('x'));
    expect(early.status).toBe(409);
    expect((early.json() as { nextSeq: number }).nextSeq).toBe(0);

    // seq=0 lands; retrying seq=0 is an idempotent no-op (duplicate ack).
    expect((await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.from('abc'))).status).toBe(200);
    const dup = await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.from('abc'));
    expect(dup.status).toBe(200);
    expect((dup.json() as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it('finish with a corrupted body (hash mismatch) is rejected and updates nothing', async () => {
    const start = await api('/bundle/start', null);
    const { uploadId } = start.json() as { uploadId: string };
    await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.from('garbage-not-a-bundle'));
    const finish = await api('/bundle/finish', JSON.stringify({
      uploadId,
      sha256: 'a'.repeat(64), // wrong on purpose
      ref: 'refs/heads/main',
      oldValue: '',
      newValue: '1'.repeat(40),
    }));
    expect(finish.status).toBe(422);
    expect(finish.text).toMatch(/hash mismatch/);
    expect(await hubTip()).toBeNull();
  });

  it('finish refuses refs outside refs/heads/ (no tag/notes/arbitrary-ref writes)', async () => {
    const start = await api('/bundle/start', null);
    const { uploadId } = start.json() as { uploadId: string };
    const finish = await api('/bundle/finish', JSON.stringify({
      uploadId,
      sha256: 'a'.repeat(64),
      ref: 'refs/tags/evil',
      oldValue: '',
      newValue: '1'.repeat(40),
    }));
    expect(finish.status).toBe(400);
  });
});

// ── Full client → server round trips via pushViaBundle ──────────────────────

describe('pushViaBundle (the real client)', () => {
  it('parses endpoint + auth from a walnut origin URL, rejects non-hub URLs', () => {
    const ep = bundleEndpointFromRemote('https://walnut:tok123@example.com/git/data');
    expect(ep?.base).toBe('https://example.com/git/data');
    expect(ep?.auth).toBe('Bearer tok123');
    expect(bundleEndpointFromRemote('git@github.com:user/repo.git')).toBeNull();
    expect(bundleEndpointFromRemote('https://example.com/git/data')).toBeNull(); // no token
  });

  it('delivers a multi-chunk full-history bundle to an EMPTY hub (create path)', async () => {
    // ~20MB of incompressible content → bundle > 2 chunks at 8MB.
    const repo = await makeRepo('client-big', 3, 7 * 1024 * 1024);
    const localTip = await git(['rev-parse', 'main'], { cwd: repo });

    const result = await pushViaBundle({
      repoDir: repo,
      branch: 'main',
      remoteUrl: remoteUrl(),
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.chunks).toBeGreaterThan(1); // multi-chunk actually exercised
    expect(await hubTip()).toBe(localTip);
    // Hub integrity: full connectivity check of the received objects.
    await expect(git(['-C', hubRepo, 'fsck', '--no-progress'])).resolves.not.toMatch(/error/i);
  }, 60_000);

  it('incremental bundle (basis) pushes only the delta and CAS-updates', async () => {
    const repo = path.join(tmpRoot, 'client-big');
    const tipBefore = await hubTip();
    expect(tipBefore).not.toBeNull();

    await fs.writeFile(path.join(repo, 'delta.md'), 'small incremental change\n');
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'delta'], { cwd: repo });
    const newTip = await git(['rev-parse', 'main'], { cwd: repo });

    const result = await pushViaBundle({
      repoDir: repo,
      branch: 'main',
      remoteUrl: remoteUrl(),
      oldValue: tipBefore!,
      basis: tipBefore!,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.chunks).toBe(1); // delta is tiny — single chunk proves incrementality
    expect(await hubTip()).toBe(newTip);
  }, 60_000);

  it('CAS refuses a stale oldValue (force-with-lease semantics) and the hub keeps its tip', async () => {
    const repo = path.join(tmpRoot, 'client-big');
    const realTip = await hubTip();
    expect(realTip).not.toBeNull();

    await fs.writeFile(path.join(repo, 'racer.md'), 'this must NOT land\n');
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'racer'], { cwd: repo });

    const staleOld = '1'.repeat(40); // pretend the hub was somewhere it isn't
    const result = await pushViaBundle({
      repoDir: repo,
      branch: 'main',
      remoteUrl: remoteUrl(),
      oldValue: staleOld,
      basis: realTip!,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/409|ref moved|bundle/i);
    expect(await hubTip()).toBe(realTip); // untouched
    // Reset the client back so later tests aren't confused.
    await git(['reset', '--hard', 'HEAD~1'], { cwd: repo });
  }, 60_000);

  it('fails cleanly when auth is wrong (no partial state on the hub)', async () => {
    const repo = path.join(tmpRoot, 'client-big');
    const result = await pushViaBundle({
      repoDir: repo,
      branch: 'main',
      remoteUrl: remoteUrl('0'.repeat(32)),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  }, 60_000);
});
