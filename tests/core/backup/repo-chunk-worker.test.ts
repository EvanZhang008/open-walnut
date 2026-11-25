/**
 * A backup run cuts and ids big files on a worker thread (src/core/backup/repo/chunk-worker.ts):
 * on the Mac the SQLite snapshots (about 2.5 GB) change on every run, and cutting and keying
 * them on the event loop was 11 s of 395 s of the live server's loop CPU in its stall profiles
 * (2026-11-25). The worker holds its own copy of the cut rule, so these tests hold it equal to
 * chunker.ts, keep the loop out of a big file's bytes, and keep a run working when the worker
 * cannot answer or the file moves under it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';

const seen = vi.hoisted(() => ({ loopChunked: 0, workerOff: false, beforeRead: null as null | ((file: string) => Promise<void>) }));
vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/core/backup/repo/chunker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/backup/repo/chunker.js')>();
  return { ...real, chunkStream: (s: Parameters<typeof real.chunkStream>[0]) => { seen.loopChunked++; return real.chunkStream(s); } };
});
vi.mock('../../../src/core/backup/repo/chunk-worker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/backup/repo/chunk-worker.js')>();
  return {
    ...real,
    chunkMapOffLoop: async (...args: Parameters<typeof real.chunkMapOffLoop>) => {
      if (seen.workerOff) return null;
      const map = await real.chunkMapOffLoop(...args);
      await seen.beforeRead?.(args[0]);
      return map;
    },
  };
});

import { chunkBuffer } from '../../../src/core/backup/repo/chunker.js';
import { blobId, generateRecoveryKey, parseRecoveryKey, deriveKeys } from '../../../src/core/backup/repo/crypto.js';
import { chunkMapOffLoop, _stopChunkWorkerForTesting } from '../../../src/core/backup/repo/chunk-worker.js';
import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import { runRepoBackup } from '../../../src/core/backup/repo/backup-run.js';
import { restoreRepoSnapshot } from '../../../src/core/backup/repo/restore.js';

let root: string;
let home: string;
const ME = { id: 'a'.repeat(32), name: 'mac-a' };

/** Content with repeats, so content-defined cuts land at many places. */
function bigBuffer(bytes: number): Buffer {
  const seed = randomBytes(300 * 1024);
  const out = Buffer.alloc(bytes);
  for (let at = 0; at < bytes; at += seed.length) seed.copy(out, at, 0, Math.min(seed.length, bytes - at));
  randomBytes(64 * 1024).copy(out, Math.floor(bytes / 3));
  return out;
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-chunk-worker-'));
  home = path.join(root, 'home');
  await fsp.mkdir(home, { recursive: true });
  seen.loopChunked = 0;
  seen.workerOff = false;
  seen.beforeRead = null;
});
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });
afterAll(async () => { await _stopChunkWorkerForTesting(); });

describe('the chunk worker', () => {
  it('cuts and ids a file exactly as chunker.ts does', async () => {
    const keys = deriveKeys(parseRecoveryKey(generateRecoveryKey()));
    for (const bytes of [128 * 1024 + 1, 2 * 1024 * 1024 + 5, 9 * 1024 * 1024 + 333]) {
      const buf = bigBuffer(bytes);
      const file = path.join(root, `f-${bytes}`);
      await fsp.writeFile(file, buf);
      const map = await chunkMapOffLoop(file, keys.mac, bytes);
      const expected = chunkBuffer(buf).map((c) => [c.length, blobId(keys, c)]);
      expect(map).toEqual({ size: bytes, chunks: expected });
    }
  });

  it('a missing file answers null', async () => {
    expect(await chunkMapOffLoop(path.join(root, 'gone'), Buffer.alloc(32), 10)).toBeNull();
  });
});

describe('a backup run with big files', () => {
  const big = () => path.join(home, 'notes', 'big.bin');

  async function backupAndRestore(store: LocalStore, rawKey: Buffer): Promise<Buffer> {
    const r = await runRepoBackup(store, rawKey, { dataDir: home, writer: ME });
    const into = path.join(root, `restore-${r.snapshotId}`);
    await restoreRepoSnapshot(store, rawKey, into, { snapshotId: r.snapshotId });
    return fsp.readFile(path.join(into, 'notes', 'big.bin'));
  }

  it('never cuts a big file on the event loop, and restores it whole', async () => {
    const rawKey = parseRecoveryKey(generateRecoveryKey());
    const store = new LocalStore(path.join(root, 'repo'));
    const buf = bigBuffer(6 * 1024 * 1024 + 7);
    await fsp.mkdir(path.dirname(big()), { recursive: true });
    await fsp.writeFile(big(), buf);
    expect((await backupAndRestore(store, rawKey)).equals(buf)).toBe(true);
    // The same bytes under a new mtime (what a SQLite snapshot is on every run): read again, all known.
    await fsp.utimes(big(), new Date(), new Date(Date.now() + 5_000));
    const again = await runRepoBackup(store, rawKey, { dataDir: home, writer: ME });
    expect(again.changedFiles).toBeGreaterThan(0);
    expect(again.newBlobs).toBeLessThanOrEqual(1); // the tree's own chunk
    expect(seen.loopChunked).toBe(0);
  });

  it('without the worker the run cuts the file itself, to the same blobs', async () => {
    const rawKey = parseRecoveryKey(generateRecoveryKey());
    const store = new LocalStore(path.join(root, 'repo'));
    const buf = bigBuffer(5 * 1024 * 1024 + 3);
    await fsp.mkdir(path.dirname(big()), { recursive: true });
    await fsp.writeFile(big(), buf);
    await runRepoBackup(store, rawKey, { dataDir: home, writer: ME });
    seen.workerOff = true;
    await fsp.utimes(big(), new Date(), new Date(Date.now() + 5_000));
    const again = await runRepoBackup(store, rawKey, { dataDir: home, writer: ME });
    expect(seen.loopChunked).toBeGreaterThan(0);
    expect(again.newBlobs).toBeLessThanOrEqual(1);
  });

  it('a file that changes after the worker read it is cut again, never stored torn', async () => {
    const rawKey = parseRecoveryKey(generateRecoveryKey());
    const store = new LocalStore(path.join(root, 'repo'));
    await fsp.mkdir(path.dirname(big()), { recursive: true });
    await fsp.writeFile(big(), bigBuffer(4 * 1024 * 1024 + 1));
    const now = bigBuffer(4 * 1024 * 1024 + 1);
    seen.beforeRead = async (file) => { if (file === big()) await fsp.writeFile(file, now); };
    expect((await backupAndRestore(store, rawKey)).equals(now)).toBe(true);
    expect(seen.loopChunked).toBe(1);
  });
});
