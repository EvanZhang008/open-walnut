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
import {
  _resetBundlePushForTesting,
  _forgetBundleSessionsInMemoryForTesting,
  _sweepBundleLeasesForTesting,
  reconcileResumeState,
  resumeMismatchReason,
  SESSION_TTL_MS,
} from '../../../src/web/routes/git-bundle-push.js';
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

async function apiGet(pathname: string, token = deviceToken): Promise<{ status: number; json: () => unknown; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/git/data${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, json: () => JSON.parse(text), text };
}

/** The lease's staging dir on the hub (where meta.json lives). */
function leaseDir(uploadId: string): string {
  return path.join(hubDir, 'bundle-uploads', uploadId);
}

/** Rewrite a lease's persisted touchedAt — the only way to age a lease without
 *  faking the clock for the whole server. */
async function ageLease(uploadId: string, ms: number): Promise<void> {
  const metaPath = path.join(leaseDir(uploadId), 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as { touchedAt: number };
  meta.touchedAt -= ms;
  await fs.writeFile(metaPath, JSON.stringify(meta), 'utf-8');
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

// ── Resume: the lease protocol (round 2) ─────────────────────────────────────

describe('bundle upload leases are resumable', () => {
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);

  async function startLease(q: string): Promise<{ uploadId: string; body: Record<string, unknown> }> {
    const res = await api(`/bundle/start${q}`, null);
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    return { uploadId: String(body.uploadId), body };
  }

  it('start advertises resumability; status lists the chunks already received', async () => {
    const { uploadId, body } = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    // The capability signal an older hub cannot fake by accident.
    expect(body.resumable).toBe(true);
    expect(body.resumed).toBe(false);
    expect(body.nextSeq).toBe(0);
    expect(body.ttlMs).toBe(SESSION_TTL_MS);

    await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.alloc(100, 1));
    await api(`/bundle/chunk?upload=${uploadId}&seq=1`, Buffer.alloc(100, 2));

    const status = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_A}&bytes=300&chunk=100`);
    expect(status.status).toBe(200);
    const s = status.json() as Record<string, unknown>;
    expect(s.ok).toBe(true);
    // Chunks are contiguous by construction, so [0, nextSeq) IS the received set.
    expect(s.nextSeq).toBe(2);
    expect(s.receivedChunks).toBe(2);
    expect(s.bytes).toBe(200);
    expect(s.complete).toBe(false);
    expect(s.chunkBytes).toBe(100);
    expect(s.sha256).toBe(SHA_A);

    // Sending the last chunk flips `complete` — the client then skips straight
    // to finish instead of re-uploading anything.
    await api(`/bundle/chunk?upload=${uploadId}&seq=2`, Buffer.alloc(100, 3));
    const done = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_A}&bytes=300&chunk=100`);
    expect((done.json() as { complete: boolean; nextSeq: number }).complete).toBe(true);
    expect((done.json() as { nextSeq: number }).nextSeq).toBe(3);
  });

  it('status refuses a lease holding a DIFFERENT bundle (hash mismatch → fresh lease)', async () => {
    const { uploadId } = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.alloc(100, 1));

    const wrongHash = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_B}&bytes=300&chunk=100`);
    expect(wrongHash.status).toBe(409);
    const body = wrongHash.json() as Record<string, unknown>;
    expect(body.code).toBe('mismatch');
    expect(body.mismatch).toBe('sha256');

    // A different chunk size is just as fatal: nextSeq would mean something else.
    const wrongChunk = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_A}&bytes=300&chunk=64`);
    expect(wrongChunk.status).toBe(409);
    expect((wrongChunk.json() as { mismatch: string }).mismatch).toBe('chunkBytes');

    // Same bundle, unchanged: still resumable.
    const right = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_A}&bytes=300&chunk=100`);
    expect(right.status).toBe(200);
    expect((right.json() as { nextSeq: number }).nextSeq).toBe(1);
  });

  it('status on an unknown lease is a MACHINE-readable 404 (distinguishable from an old hub\'s route 404)', async () => {
    const missing = await apiGet(`/bundle/status?upload=${'f'.repeat(32)}`);
    expect(missing.status).toBe(404);
    // The client keys resume-vs-fallback off this `code`: express's own 404 for
    // a route that doesn't exist has no JSON body at all.
    expect((missing.json() as { code: string }).code).toBe('expired');
    const bad = await apiGet('/bundle/status?upload=not-an-id');
    expect(bad.status).toBe(400);
  });

  it('a lease survives a hub RESTART — progress is on disk, not just in memory', async () => {
    const { uploadId } = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.alloc(100, 7));
    await api(`/bundle/chunk?upload=${uploadId}&seq=1`, Buffer.alloc(100, 8));

    // Exactly what a restart leaves behind: no in-memory map, every lease dir
    // still on disk. The old in-memory-only store lost the upload here.
    _forgetBundleSessionsInMemoryForTesting();

    const status = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_A}&bytes=300&chunk=100`);
    expect(status.status).toBe(200);
    expect((status.json() as { nextSeq: number }).nextSeq).toBe(2);

    // And the upload can actually be continued, not just inspected.
    const next = await api(`/bundle/chunk?upload=${uploadId}&seq=2`, Buffer.alloc(100, 9));
    expect(next.status).toBe(200);
    expect((next.json() as { nextSeq: number }).nextSeq).toBe(3);
  });

  it('never steals a lease from a LIVE pusher, even for the same bundle', async () => {
    const { uploadId } = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.alloc(100, 1));
    // Two writers appending to one file would interleave bytes, so a lease
    // touched seconds ago is off limits: the newcomer gets its own.
    const second = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    expect(second.uploadId).not.toBe(uploadId);
    expect(second.body.resumed).toBe(false);
    expect(second.body.nextSeq).toBe(0);
  });

  it('start re-adopts an IDLE lease for the identical bundle (client lost its state file)', async () => {
    const { uploadId } = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.alloc(100, 1));

    // Aged past ACTIVE_SESSION_MS, the same bundle re-adopts it with its
    // progress — the client needs no state file of its own to converge.
    _forgetBundleSessionsInMemoryForTesting();
    await ageLease(uploadId, 10 * 60_000);
    const readopted = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    expect(readopted.uploadId).toBe(uploadId);
    expect(readopted.body.resumed).toBe(true);
    expect(readopted.body.nextSeq).toBe(1);

    // A DIFFERENT bundle must not be appended onto it, idle or not.
    _forgetBundleSessionsInMemoryForTesting();
    await ageLease(uploadId, 10 * 60_000);
    const other = await startLease(`?sha256=${SHA_B}&bytes=300&chunk=100`);
    expect(other.uploadId).not.toBe(uploadId);
    expect(other.body.nextSeq).toBe(0);
  });

  it('refuses a declared bundle bigger than the hub budget at START, not at chunk 250', async () => {
    const res = await api(`/bundle/start?sha256=${SHA_A}&bytes=${8 * 1024 ** 3}&chunk=100`, null);
    expect(res.status).toBe(413);
  });

  it('sweeps lease dirs past the TTL (and only those)', async () => {
    const fresh = await startLease(`?sha256=${SHA_A}&bytes=300&chunk=100`);
    const stale = await startLease(`?sha256=${SHA_B}&bytes=300&chunk=100`);
    await api(`/bundle/chunk?upload=${stale.uploadId}&seq=0`, Buffer.alloc(100, 1));

    _forgetBundleSessionsInMemoryForTesting();
    await ageLease(stale.uploadId, SESSION_TTL_MS + 60_000);
    await _sweepBundleLeasesForTesting();

    await expect(fs.stat(leaseDir(stale.uploadId))).rejects.toThrow();
    await expect(fs.stat(leaseDir(fresh.uploadId))).resolves.toBeTruthy();
    expect((await apiGet(`/bundle/status?upload=${stale.uploadId}`)).status).toBe(404);
    expect((await apiGet(`/bundle/status?upload=${fresh.uploadId}`)).status).toBe(200);
  });

  it('legacy client (no declared identity) still uploads — it just cannot resume', async () => {
    // Byte-for-byte the pre-resume request: no query params, no body.
    const { uploadId, body } = await startLease('');
    expect(body.resumable).toBe(true); // the hub supports it; this client doesn't use it
    expect((await api(`/bundle/chunk?upload=${uploadId}&seq=0`, Buffer.from('hello'))).status).toBe(200);
    // With no recorded identity the lease cannot PROVE it holds a given bundle,
    // so a resume attempt is refused rather than silently appended to.
    const status = await apiGet(`/bundle/status?upload=${uploadId}&sha256=${SHA_A}&bytes=5&chunk=5`);
    expect(status.status).toBe(409);
    expect((status.json() as { mismatch: string }).mismatch).toBe('unknown-bundle');
    // Its own no-identity status query still works (progress reporting).
    expect((await apiGet(`/bundle/status?upload=${uploadId}`)).status).toBe(200);
  });

  it('a real bundle uploaded across a simulated restart still verifies + CAS-updates', async () => {
    // The whole path with REAL git objects: build a bundle, ship it in three
    // chunks with a hub restart in the middle, and let the hub verify + fetch.
    const repo = path.join(tmpRoot, 'resume-real');
    await fs.mkdir(repo, { recursive: true });
    await git(['init', '-b', 'resume-branch'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'a.bin'), crypto.randomBytes(4096));
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'real bundle'], { cwd: repo });
    const tip = await git(['rev-parse', 'resume-branch'], { cwd: repo });
    const bundleFile = path.join(repo, 'out.bundle');
    await git(['bundle', 'create', bundleFile, 'resume-branch'], { cwd: repo });
    const bytes = await fs.readFile(bundleFile);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const chunk = Math.ceil(bytes.length / 3);

    const { uploadId } = await startLease(`?sha256=${sha256}&bytes=${bytes.length}&chunk=${chunk}`);
    expect((await api(`/bundle/chunk?upload=${uploadId}&seq=0`, bytes.subarray(0, chunk))).status).toBe(200);

    _forgetBundleSessionsInMemoryForTesting(); // hub restarts mid-upload

    const resumeAt = (await apiGet(`/bundle/status?upload=${uploadId}&sha256=${sha256}&bytes=${bytes.length}&chunk=${chunk}`)).json() as { nextSeq: number };
    expect(resumeAt.nextSeq).toBe(1);
    for (let seq = resumeAt.nextSeq; seq * chunk < bytes.length; seq++) {
      const piece = bytes.subarray(seq * chunk, Math.min((seq + 1) * chunk, bytes.length));
      expect((await api(`/bundle/chunk?upload=${uploadId}&seq=${seq}`, piece)).status).toBe(200);
    }

    const finish = await api('/bundle/finish', JSON.stringify({
      uploadId, sha256, ref: 'refs/heads/resume-branch', oldValue: '', newValue: tip,
    }));
    expect(finish.text).toMatch(/"ok":true/);
    expect(finish.status).toBe(200);
    // The reassembled-across-a-restart bundle produced real, connected objects.
    expect(await git(['-C', hubRepo, 'rev-parse', 'refs/heads/resume-branch'])).toBe(tip);
    await expect(git(['-C', hubRepo, 'fsck', '--no-progress'])).resolves.not.toMatch(/error/i);
  }, 60_000);
});

// ── Pure helpers (crash-window arithmetic) ───────────────────────────────────

describe('reconcileResumeState', () => {
  it('trims a torn tail back to a whole chunk boundary', () => {
    // The crash window: chunk 3 was appended but its meta never written, so the
    // FILE is ahead of the recorded byte count. Trusting the file would leave
    // client and hub disagreeing about seq forever.
    expect(reconcileResumeState({ bytes: 300, nextSeq: 3, chunkBytes: 100, totalBytes: 1000 }, 400))
      .toEqual({ bytes: 300, nextSeq: 3, truncateTo: 300 });
    // A half-written chunk is dropped entirely (the client resends it).
    expect(reconcileResumeState({ bytes: 350, nextSeq: 3, chunkBytes: 100, totalBytes: 1000 }, 350))
      .toEqual({ bytes: 300, nextSeq: 3, truncateTo: 300 });
    // A file SHORTER than the meta claims (lost write) also wins the argument.
    expect(reconcileResumeState({ bytes: 400, nextSeq: 4, chunkBytes: 100, totalBytes: 1000 }, 250))
      .toEqual({ bytes: 200, nextSeq: 2, truncateTo: 200 });
  });

  it('accepts a complete upload whose last chunk is legitimately partial', () => {
    expect(reconcileResumeState({ bytes: 250, nextSeq: 3, chunkBytes: 100, totalBytes: 250 }, 250))
      .toEqual({ bytes: 250, nextSeq: 3, truncateTo: 250 });
  });

  it('refuses to guess without a declared chunk size', () => {
    expect(reconcileResumeState({ bytes: 300, nextSeq: 3, chunkBytes: 0, totalBytes: 0 }, 300))
      .toEqual({ bytes: 0, nextSeq: 0, truncateTo: 0 });
  });

  it('handles an empty lease', () => {
    expect(reconcileResumeState({ bytes: 0, nextSeq: 0, chunkBytes: 100, totalBytes: 1000 }, 0))
      .toEqual({ bytes: 0, nextSeq: 0, truncateTo: 0 });
  });
});

describe('resumeMismatchReason', () => {
  const lease = { sha256: 'a'.repeat(64), chunkBytes: 100, totalBytes: 1000 };

  it('names the field that disagrees', () => {
    expect(resumeMismatchReason(lease, { sha256: 'a'.repeat(64), chunkBytes: 100, totalBytes: 1000 })).toBeNull();
    expect(resumeMismatchReason(lease, { sha256: 'b'.repeat(64) })).toBe('sha256');
    expect(resumeMismatchReason(lease, { sha256: 'a'.repeat(64), chunkBytes: 64 })).toBe('chunkBytes');
    expect(resumeMismatchReason(lease, { sha256: 'a'.repeat(64), chunkBytes: 100, totalBytes: 999 })).toBe('totalBytes');
  });

  it('never resumes into a lease with no recorded identity', () => {
    expect(resumeMismatchReason({ sha256: '', chunkBytes: 0, totalBytes: 0 }, { sha256: 'a'.repeat(64) })).toBe('unknown-bundle');
    expect(resumeMismatchReason({ sha256: 'a'.repeat(64), chunkBytes: 0, totalBytes: 0 }, {})).toBe('unknown-bundle');
  });

  it('a partial declaration only checks what it declared', () => {
    expect(resumeMismatchReason(lease, {})).toBeNull();
    expect(resumeMismatchReason(lease, { sha256: 'a'.repeat(64) })).toBeNull();
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
