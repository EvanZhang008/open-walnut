/**
 * Chunked bundle push — RESUME + convergence (round 2, 2026-08-22).
 *
 * The failure this pins: at 2.5GB of pack the bundle is ~210 chunks, a TLS
 * filter kills a few at random, and the first chunk to burn its retries used to
 * abort the whole run (observed: chunk 104/210). The next attempt restarted at
 * chunk 1, so the push never converged.
 *
 * These tests drive the REAL client (pushViaBundle) against a STUB hub, because
 * what needs proving is the client's behavior when chunks fail — which a healthy
 * server can't produce. The stub speaks the same protocol as
 * src/web/routes/git-bundle-push.ts (start/status/chunk/finish, contiguous
 * append, idempotent duplicates) and can be told to fail a specific chunk N
 * times, or to have no /bundle/status route at all (an older hub).
 *
 * The full client↔real-server wire path lives in
 * tests/web/routes/git-bundle-push.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  pushViaBundle,
  chunkRetryDelayMs,
  sweepBackoffMs,
  _setBundleRetryTuningForTesting,
  CHUNK_RETRIES,
  CHUNK_BACKOFF_BASE_MS,
  CHUNK_BACKOFF_CAP_MS,
  MAX_SWEEPS,
} from '../../src/integrations/git-bundle-client.js';

const execFileAsync = promisify(execFile);

let tmpRoot: string;

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd,
    env: {
      ...process.env,
      HOME: tmpRoot,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'walnut-test',
      GIT_AUTHOR_EMAIL: 'walnut-test@localhost',
      GIT_COMMITTER_NAME: 'walnut-test',
      GIT_COMMITTER_EMAIL: 'walnut-test@localhost',
      // Fixed dates keep the bundle byte-identical across runs, which is
      // exactly the precondition cross-run resume depends on.
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
  return stdout.trim();
}

// ── Stub hub ────────────────────────────────────────────────────────────────

interface StubHub {
  url: (repoPathSuffix?: string) => string;
  close: () => Promise<void>;
  /** seq → how many more times to fail it (500). */
  failChunk: Map<number, number>;
  /** Serve /bundle/status (false = an older hub without resume support). */
  statusSupported: boolean;
  /** Every chunk seq the client asked us to store, in request order. */
  chunkSeqs: number[];
  statusCalls: number;
  startCalls: { sha256: string; bytes: number; chunk: number }[];
  finishes: { uploadId: string; sha256: string; ok: boolean }[];
  /** uploadId → assembled bytes. */
  data: Map<string, Buffer>;
  nextSeqOf: Map<string, number>;
  /** Lease identities, as declared at start. */
  identity: Map<string, { sha256: string; bytes: number; chunk: number }>;
  /** Drop the lease (an expiry / sweep on the hub side). */
  expire: (uploadId: string) => void;
}

async function startStubHub(): Promise<StubHub> {
  const hub: Partial<StubHub> = {
    failChunk: new Map(),
    statusSupported: true,
    chunkSeqs: [],
    statusCalls: 0,
    startCalls: [],
    finishes: [],
    data: new Map(),
    nextSeqOf: new Map(),
    identity: new Map(),
  };
  const readBody = (req: http.IncomingMessage): Promise<Buffer> => new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const q = url.searchParams;

    if (url.pathname.endsWith('/bundle/start')) {
      await readBody(req);
      const id = crypto.randomBytes(16).toString('hex');
      const identity = { sha256: q.get('sha256') ?? '', bytes: Number(q.get('bytes') ?? 0), chunk: Number(q.get('chunk') ?? 0) };
      hub.startCalls!.push(identity);
      // Re-adopt an idle lease holding the identical bundle (same rule the real
      // hub applies), so a client that lost its state file still resumes.
      for (const [existing, ident] of hub.identity!) {
        if (ident.sha256 && ident.sha256 === identity.sha256 && ident.chunk === identity.chunk) {
          json(200, { uploadId: existing, resumable: hub.statusSupported, resumed: true, nextSeq: hub.nextSeqOf!.get(existing) ?? 0 });
          return;
        }
      }
      hub.data!.set(id, Buffer.alloc(0));
      hub.nextSeqOf!.set(id, 0);
      hub.identity!.set(id, identity);
      // An older hub omits `resumable` entirely — the client's capability gate.
      json(200, hub.statusSupported
        ? { uploadId: id, resumable: true, resumed: false, nextSeq: 0 }
        : { uploadId: id, maxChunkBytes: 32 * 1024 * 1024 });
      return;
    }

    if (url.pathname.endsWith('/bundle/status')) {
      hub.statusCalls!++;
      if (!hub.statusSupported) {
        // What express itself answers for an unknown route: HTML, no `code`.
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>Cannot GET /bundle/status</body></html>');
        return;
      }
      const id = q.get('upload') ?? '';
      if (!hub.data!.has(id)) { json(404, { ok: false, code: 'expired', error: 'unknown or expired upload' }); return; }
      const ident = hub.identity!.get(id)!;
      if (q.get('sha256') && ident.sha256 && q.get('sha256') !== ident.sha256) {
        json(409, { ok: false, code: 'mismatch', mismatch: 'sha256' });
        return;
      }
      const nextSeq = hub.nextSeqOf!.get(id) ?? 0;
      json(200, {
        ok: true, uploadId: id, nextSeq, receivedChunks: nextSeq,
        bytes: hub.data!.get(id)!.length, chunkBytes: ident.chunk, sha256: ident.sha256,
        totalBytes: ident.bytes, complete: ident.bytes > 0 && hub.data!.get(id)!.length >= ident.bytes,
      });
      return;
    }

    if (url.pathname.endsWith('/bundle/chunk')) {
      const id = q.get('upload') ?? '';
      const seq = Number(q.get('seq'));
      const body = await readBody(req);
      if (!hub.data!.has(id)) { json(404, { ok: false, code: 'expired' }); return; }
      const remainingFailures = hub.failChunk!.get(seq) ?? 0;
      if (remainingFailures > 0) {
        hub.failChunk!.set(seq, remainingFailures - 1);
        json(500, { ok: false, error: 'simulated wire failure' });
        return;
      }
      const nextSeq = hub.nextSeqOf!.get(id) ?? 0;
      if (seq < nextSeq) { json(200, { ok: true, nextSeq, duplicate: true }); return; }
      if (seq > nextSeq) { json(409, { ok: false, nextSeq }); return; }
      hub.chunkSeqs!.push(seq);
      hub.data!.set(id, Buffer.concat([hub.data!.get(id)!, body]));
      hub.nextSeqOf!.set(id, seq + 1);
      json(200, { ok: true, nextSeq: seq + 1 });
      return;
    }

    if (url.pathname.endsWith('/bundle/finish')) {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString('utf-8')) as { uploadId: string; sha256: string };
      const stored = hub.data!.get(parsed.uploadId);
      if (!stored) { json(404, { ok: false, code: 'expired' }); return; }
      const actual = crypto.createHash('sha256').update(stored).digest('hex');
      const ok = actual === parsed.sha256;
      hub.finishes!.push({ uploadId: parsed.uploadId, sha256: parsed.sha256, ok });
      hub.data!.delete(parsed.uploadId);
      hub.identity!.delete(parsed.uploadId);
      if (!ok) { json(422, { ok: false, error: 'hash mismatch — retransmit' }); return; }
      json(200, { ok: true });
      return;
    }

    json(404, { ok: false });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  hub.url = () => `http://walnut:testtoken@127.0.0.1:${addr.port}/git/data`;
  hub.close = () => new Promise<void>((resolve) => { server.close(() => resolve()); });
  hub.expire = (uploadId: string) => {
    hub.data!.delete(uploadId);
    hub.identity!.delete(uploadId);
    hub.nextSeqOf!.delete(uploadId);
  };
  return hub as StubHub;
}

/** A repo whose bundle spans several chunks at CHUNK (1KB) granularity. */
const CHUNK = 1024;
async function makeRepo(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await git(['init', '-b', 'main'], dir);
  // Incompressible content so the pack (and therefore the bundle) is big
  // enough to split: ~24KB → ~24 chunks of 1KB.
  await fs.writeFile(path.join(dir, 'blob.bin'), crypto.randomBytes(24 * 1024));
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'seed'], dir);
  return dir;
}

async function leaseStateOf(repoDir: string): Promise<{ uploadId: string; nextSeq: number; sha256: string } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(repoDir, '.git', 'bundle-upload-state.json'), 'utf-8'));
  } catch {
    return null;
  }
}

let hub: StubHub;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-bundle-resume-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  hub = await startStubHub();
  // Production clocks would make these tests take minutes; the LOGIC under
  // test is which chunks get re-sent, not how long we wait between them.
  _setBundleRetryTuningForTesting({
    chunkBackoffBaseMs: 1, chunkBackoffCapMs: 4, sweepBackoffBaseMs: 1, sweepBackoffCapMs: 4,
  });
});

afterEach(async () => {
  _setBundleRetryTuningForTesting(null);
  await hub.close();
});

// ── backoff parameters (pure) ───────────────────────────────────────────────

describe('retry backoff parameters', () => {
  beforeEach(() => _setBundleRetryTuningForTesting(null)); // assert the REAL values

  it('is exponential, jittered, and capped', () => {
    // Midpoint jitter (rand 0.5) → exactly the exponential value.
    expect(chunkRetryDelayMs(0, 0.5)).toBe(CHUNK_BACKOFF_BASE_MS);
    expect(chunkRetryDelayMs(1, 0.5)).toBe(CHUNK_BACKOFF_BASE_MS * 2);
    expect(chunkRetryDelayMs(5, 0.5)).toBe(CHUNK_BACKOFF_BASE_MS * 32);
    // Never past the cap, however many attempts — INCLUDING the jitter, which
    // must not be able to push a capped delay back over the line.
    expect(chunkRetryDelayMs(20, 1)).toBe(CHUNK_BACKOFF_CAP_MS);
    expect(chunkRetryDelayMs(99, 1)).toBeLessThanOrEqual(CHUNK_BACKOFF_CAP_MS);
    // Jitter spreads ±25% so N sequential chunks don't retry in lockstep.
    expect(chunkRetryDelayMs(2, 0)).toBe(Math.round(2000 * 0.75));
    expect(chunkRetryDelayMs(2, 1)).toBe(Math.round(2000 * 1.25));
    // Monotonic in attempt at fixed jitter.
    const fixed = [0, 1, 2, 3, 4, 5].map((a) => chunkRetryDelayMs(a, 0.5));
    expect([...fixed].sort((a, b) => a - b)).toEqual(fixed);
  });

  it('sweep backoff is much slower than chunk backoff, and capped', () => {
    expect(sweepBackoffMs(0, 0.5)).toBe(5_000);
    expect(sweepBackoffMs(1, 0.5)).toBe(10_000);
    expect(sweepBackoffMs(9, 1)).toBe(60_000); // capped, jitter included
    expect(sweepBackoffMs(0, 0.5)).toBeGreaterThan(chunkRetryDelayMs(0, 0.5));
  });

  it('retries deeply enough that one bad chunk cannot end a 200-chunk run', () => {
    expect(CHUNK_RETRIES).toBeGreaterThanOrEqual(6);
    expect(MAX_SWEEPS).toBeGreaterThanOrEqual(2);
  });
});

// ── within-run second sweep ─────────────────────────────────────────────────

describe('within-run sweep', () => {
  it('re-sends ONLY the stalled chunk (and what follows), never chunk 0 again', async () => {
    const repo = await makeRepo('sweep-repo');
    // Chunk 3 fails every attempt of pass 1 (6 retries), then recovers —
    // exactly the observed "chunk 104 fails 3x, works minutes later".
    hub.failChunk.set(3, CHUNK_RETRIES);

    const result = await pushViaBundle({
      repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.chunks).toBeGreaterThan(4); // multi-chunk actually exercised
    expect(result.sweeps).toBe(2);            // the second pass is what saved it
    // Chunks 0-2 were stored once, in pass 1, and NOT re-sent by the sweep.
    const storedZeroToTwo = hub.chunkSeqs.filter((s) => s <= 2);
    expect(storedZeroToTwo).toEqual([0, 1, 2]);
    // The sweep resumed at the failed chunk, not at 0.
    expect(hub.chunkSeqs[3]).toBe(3);
    // Contiguous, complete, hash-verified by the stub's finish.
    expect(hub.finishes.at(-1)?.ok).toBe(true);
    // Lease state is cleaned up after a successful delivery.
    expect(await leaseStateOf(repo)).toBeNull();
  }, 60_000);

  it('gives up after MAX_SWEEPS and KEEPS the lease for the next run', async () => {
    const repo = await makeRepo('give-up-repo');
    hub.failChunk.set(2, 10_000); // never recovers

    const result = await pushViaBundle({
      repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK,
    });

    expect(result.ok).toBe(false);
    expect(result.sweeps).toBe(MAX_SWEEPS);
    expect(result.leaseKept).toBe(true);
    expect(result.error).toMatch(/chunk 2\/\d+ failed after \d+ sweep\(s\)/);
    expect(result.error).toMatch(/lease kept for resume/);
    const state = await leaseStateOf(repo);
    expect(state?.nextSeq).toBe(2);
    expect(hub.finishes).toHaveLength(0); // nothing was finalized
  }, 60_000);
});

// ── cross-run resume ────────────────────────────────────────────────────────

describe('cross-run resume', () => {
  it('second run skips the chunks the hub already has', async () => {
    const repo = await makeRepo('resume-repo');
    hub.failChunk.set(4, 10_000);
    const first = await pushViaBundle({ repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK });
    expect(first.ok).toBe(false);
    expect(first.leaseKept).toBe(true);
    const lease = await leaseStateOf(repo);
    expect(lease?.uploadId).toBeTruthy();

    // Next run, same bundle (no new commits), wire now healthy.
    hub.failChunk.clear();
    hub.chunkSeqs.length = 0;
    const second = await pushViaBundle({ repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK });

    expect(second.error).toBeUndefined();
    expect(second.ok).toBe(true);
    expect(second.resumedFromSeq).toBe(4);          // resumed, not restarted
    expect(Math.min(...hub.chunkSeqs)).toBe(4);     // chunks 0-3 never re-sent
    expect(second.chunksSent).toBeLessThan(second.chunks);
    expect(hub.finishes.at(-1)?.ok).toBe(true);     // assembled hash still valid
    // The same lease was reused rather than a second one opened.
    expect(hub.startCalls).toHaveLength(1);
  }, 60_000);

  it('expired lease (404) falls back to a full upload and drops the state file', async () => {
    const repo = await makeRepo('expired-repo');
    hub.failChunk.set(3, 10_000);
    await pushViaBundle({ repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK });
    const lease = await leaseStateOf(repo);
    expect(lease).not.toBeNull();

    hub.failChunk.clear();
    hub.expire(lease!.uploadId); // hub swept it (TTL, restart, disk cleanup)
    hub.chunkSeqs.length = 0;
    const second = await pushViaBundle({ repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK });

    expect(second.ok).toBe(true);
    expect(second.resumedFromSeq).toBe(0);      // full upload, from scratch
    expect(hub.chunkSeqs[0]).toBe(0);
    expect(hub.finishes.at(-1)?.ok).toBe(true);
    expect(await leaseStateOf(repo)).toBeNull();
  }, 60_000);

  it('a DIFFERENT bundle never appends to the old lease (mismatch → fresh lease)', async () => {
    const repo = await makeRepo('mismatch-repo');
    hub.failChunk.set(3, 10_000);
    const first = await pushViaBundle({ repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK });
    expect(first.ok).toBe(false);
    const staleLease = (await leaseStateOf(repo))!.uploadId;

    // A new commit lands → different bundle → the old lease's bytes are useless.
    await fs.writeFile(path.join(repo, 'more.bin'), crypto.randomBytes(4 * 1024));
    await git(['add', '-A'], repo);
    await git(['commit', '-q', '-m', 'more'], repo);
    hub.failChunk.clear();
    hub.chunkSeqs.length = 0;

    const second = await pushViaBundle({ repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK });
    expect(second.ok).toBe(true);
    expect(second.resumedFromSeq).toBe(0);
    expect(hub.chunkSeqs[0]).toBe(0);
    // A second lease was opened; the stale one was not appended to.
    expect(hub.startCalls.length).toBeGreaterThan(1);
    expect(hub.finishes.at(-1)?.uploadId).not.toBe(staleLease);
    expect(hub.finishes.at(-1)?.ok).toBe(true);
  }, 60_000);
});

// ── capability gate ─────────────────────────────────────────────────────────

describe('older hub without /bundle/status', () => {
  it('uploads normally, never persists a lease, and still sweeps', async () => {
    hub.statusSupported = false;
    const repo = await makeRepo('old-hub-repo');
    hub.failChunk.set(2, CHUNK_RETRIES); // stall pass 1, recover for the sweep

    const result = await pushViaBundle({
      repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.sweeps).toBe(2);              // sweeps work without status
    expect(hub.statusCalls).toBe(0);            // never probed: no lease to resume
    expect(await leaseStateOf(repo)).toBeNull(); // no resume state on an old hub
    expect(hub.finishes.at(-1)?.ok).toBe(true);
  }, 60_000);

  it('a failed run against an older hub keeps no lease (nothing could resume it)', async () => {
    hub.statusSupported = false;
    const repo = await makeRepo('old-hub-fail-repo');
    hub.failChunk.set(1, 10_000);

    const result = await pushViaBundle({
      repoDir: repo, branch: 'main', remoteUrl: hub.url(), chunkBytes: CHUNK,
    });
    expect(result.ok).toBe(false);
    expect(result.leaseKept).toBe(false);
    expect(await leaseStateOf(repo)).toBeNull();
  }, 60_000);
});
