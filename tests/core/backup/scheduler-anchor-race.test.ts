/**
 * A restart does not run a backup the schedule does not call for.
 *
 * 2026-11-25 on the Mac: the schedule says every 24 h, yet a backup ran about three
 * minutes after most of the morning's 23 restarts (16 in all), each a burst of server memory. The
 * first check after a start read the schedule's anchor (the newest backup at the
 * destination) while the read syncDestination had begun was still going, returned at
 * once with the anchor at 0, and ran a backup.
 *
 * Real: the scheduler and its timers. Mocked: the config, the destination's readiness and
 * the encrypted engine (its listing, held until the test lets it answer, and its run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  release: [] as Array<() => void>,
  newestAt: '',
  runs: 0,
}));

vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => h.config }));
vi.mock('../../../src/core/backup/destination.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/backup/destination.js')>()),
  isDestinationReady: async () => true,
}));
vi.mock('../../../src/core/backup/encrypted-backup.js', () => ({
  listEncryptedBackups: () => new Promise((resolve) => {
    h.release.push(() => resolve({
      destination: 's3://bucket/walnut', encrypted: false, unreadable: 0, writer: 'mac', thisWriter: true,
      snapshots: [{ id: 's1', createdAt: h.newestAt, encrypted: false, fileCount: 1, totalBytes: 1, hostname: 'mac', version: 1, walnutVersion: 't' }],
    }));
  }),
  runEncryptedBackup: async () => {
    h.runs++;
    return { snapshotId: 's2', fileCount: 1, changedFiles: 0, totalBytes: 1, uploadedBytes: 0, durationMs: 1, skipped: [] };
  },
}));

import { startBackupScheduler, type BackupSchedulerHandle } from '../../../src/core/backup/backup-scheduler.js';

let dataDir: string;
let scheduler: BackupSchedulerHandle | null = null;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-backup-anchor-'));
  h.config = { backup: { enabled: true, interval_hours: 24, encrypt: false, destination: { type: 's3', bucket: 'bucket' } } };
  h.release = [];
  h.runs = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  scheduler?.stop();
  scheduler = null;
  vi.useRealTimers();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

async function firstCheck(newestAgoMs: number): Promise<number> {
  h.newestAt = new Date(Date.now() - newestAgoMs).toISOString();
  scheduler = startBackupScheduler({ emit: () => {}, notify: async () => false, dataDir });
  await vi.advanceTimersByTimeAsync(60_000);
  // Both reads of the anchor have started by now; the listing answers only after.
  expect(h.release.length).toBeGreaterThan(0);
  for (const r of h.release.splice(0)) r();
  await vi.advanceTimersByTimeAsync(10);
  for (const r of h.release.splice(0)) r();
  await vi.advanceTimersByTimeAsync(10);
  return h.runs;
}

describe('the first check after a start', () => {
  it('waits for the anchor being read: a backup an hour old runs nothing', async () => {
    expect(await firstCheck(3_600_000)).toBe(0);
    expect(scheduler!.health.lastBackupAt).toBe(h.newestAt);
  });

  it('a backup older than the schedule still runs once', async () => {
    expect(await firstCheck(25 * 3_600_000)).toBe(1);
  });
});
