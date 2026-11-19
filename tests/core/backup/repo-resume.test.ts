/**
 * A first backup cut short (the server restarted, the connection dropped) keeps what it
 * uploaded: the run writes an index every few packs, so the next run uploads only what is
 * still missing. 2026-11-19: a 10 GB first backup to Google Drive was stopped by a deploy
 * after 26 minutes and, with no index written yet, would have started from zero.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import type { BackupStore } from '../../../src/core/backup/stores/types.js';
import { runRepoBackup } from '../../../src/core/backup/repo/backup-run.js';
import { restoreRepoSnapshot } from '../../../src/core/backup/repo/restore.js';
import { Repository } from '../../../src/core/backup/repo/repository.js';
import { PACK_TARGET_BYTES } from '../../../src/core/backup/repo/format.js';

const W = { id: 'a'.repeat(32), name: 'mac-a' };
let root: string;
let home: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-resume-'));
  home = path.join(root, 'home');
  // Incompressible clips, stored as they are: about five full packs in all.
  for (let i = 0; i < 4; i++) {
    const p = path.join(home, 'notes', '_attachment', `clip-${i}.mp4`);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, randomBytes(Math.floor(PACK_TARGET_BYTES * 1.25)));
  }
  await fsp.writeFile(path.join(home, 'notes.md'), '# Notes\n');
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** A store whose pack uploads fail after `allow` of them, as a restart mid-run looks. */
function cutAfter(store: BackupStore, allow: number): BackupStore {
  let packs = 0;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'put') {
        return async (key: string, body: Buffer) => {
          if (key.startsWith('packs/') && ++packs > allow) throw new Error('connection reset');
          return target.put(key, body);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('a backup cut short', () => {
  it.each([[null, 'unencrypted'], [Buffer.alloc(32, 7), 'encrypted']] as const)('keeps what it uploaded (%s key: %s)', async (rawKey) => {
    const store = new LocalStore(path.join(root, 'dest'));
    await expect(runRepoBackup(cutAfter(store, 3), rawKey, { dataDir: home, writer: W, checkpointBytes: PACK_TARGET_BYTES }))
      .rejects.toThrow(/connection reset/);
    // No backup landed, but the packs it uploaded are in an index.
    const repo = await Repository.open(store, rawKey);
    expect(await repo.listSnapshotKeys()).toEqual([]);
    const indexed = (await repo.loadIndex()).packs.size;
    expect(indexed).toBeGreaterThanOrEqual(2);

    const total = (await Promise.all((await fsp.readdir(path.join(home, 'notes', '_attachment'))).map(async (f) => (await fsp.stat(path.join(home, 'notes', '_attachment', f))).size)))
      .reduce((a, b) => a + b, 0);
    const second = await runRepoBackup(store, rawKey, { dataDir: home, writer: W });
    // Only what the first run did not get up goes up now.
    expect(second.uploadedBytes).toBeLessThan(total - indexed * PACK_TARGET_BYTES * 0.9);
    expect(second.uploadedBytes).toBeGreaterThan(0);

    const target = path.join(root, 'restored');
    await restoreRepoSnapshot(store, rawKey, target, { snapshotId: 'latest' });
    for (let i = 0; i < 4; i++) {
      const rel = path.join('notes', '_attachment', `clip-${i}.mp4`);
      expect((await fsp.readFile(path.join(target, rel))).equals(await fsp.readFile(path.join(home, rel))), rel).toBe(true);
    }
  }, 120_000);
});
