/**
 * Unencrypted backups (encryption off, the default since 2026-11-19; repo-mode.ts) on
 * real stores, and both kinds side by side at one destination: a switch either way
 * starts (or goes back to) the other repository, and every backup made before stays
 * restorable. The user's words: "We know, encryption. It is optional. We default,
 * just don't add encryption."
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import { S3Store } from '../../../src/core/backup/stores/s3-store.js';
import type { BackupStore } from '../../../src/core/backup/stores/types.js';
import {
  listEncryptedBackups, restoreEncryptedBackup, runEncryptedBackup, testDestination,
} from '../../../src/core/backup/encrypted-backup.js';
import { PLAIN_ROOT, backupEncrypted, repoStore } from '../../../src/core/backup/repo-mode.js';
import { Repository } from '../../../src/core/backup/repo/repository.js';
import { REPO_CONFIG_KEY } from '../../../src/core/backup/repo/format.js';
import { PLAIN_KEYS, generateRecoveryKey, open, parseRecoveryKey, seal } from '../../../src/core/backup/repo/crypto.js';
import { readRecoveryKey, recoveryKeyPath } from '../../../src/core/backup/recovery-key.js';
import { isBackupConfigured } from '../../../src/core/backup/backup-scheduler.js';
import type { BackupConfig } from '../../../src/core/backup/types.js';
import { startFakeS3 } from '../../helpers/fake-s3-server.js';
import { startFakeGoogleDrive, type FakeGoogleDrive } from '../../helpers/fake-google-drive.js';
import { DriveStore, findOrCreateFolder } from '../../../src/core/backup/stores/drive-store.js';
import { pruneRepo } from '../../../src/core/backup/repo/prune.js';
import { localWriter } from '../../../src/core/backup/local-state.js';

let root: string;
let home: string;
/** Stored as is (not deflated), so its bytes are findable in an unencrypted pack. */
let video: Buffer;

async function write(rel: string, body: string | Buffer): Promise<void> {
  const p = path.join(home, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-plain-'));
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  video = randomBytes(200_000);
  await write('auth.json', JSON.stringify({ secret: 'token-123' }));
  await write('notes/日记/run.md', '# Run\n\nRan 5 km.\n'.repeat(100));
  await write('notes/_attachment/clip.mp4', video);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const DEST = { type: 'r2' as const, bucket: 'b', account_id: '0'.repeat(32), access_key_id: 'AK', secret_access_key: 'S' };
const plainCfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({ enabled: true, destination: DEST, ...over });
const encCfg = (over: Partial<BackupConfig> = {}): BackupConfig =>
  ({ enabled: true, destination: DEST, encrypt: true, recovery_key_saved_at: '2026-11-19T00:00:00Z', ...over });

async function allBytes(store: BackupStore, prefix: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const o of await store.list(prefix)) parts.push(await store.get(o.key));
  return Buffer.concat(parts);
}

let drive: FakeGoogleDrive | null = null;
const stores: Array<[string, () => Promise<{ store: BackupStore; close: () => Promise<void> }>]> = [
  ['local folder', async () => ({ store: new LocalStore(path.join(root, 'dest')), close: async () => {} })],
  ['S3 protocol (R2 / MinIO shape)', async () => {
    const fake = await startFakeS3({ buckets: ['b'], pageSize: 5 });
    const store = new S3Store({ kind: 'r2', bucket: 'b', prefix: 'walnut-backup', endpoint: fake.url, accessKeyId: 'AK', secretAccessKey: 'S' });
    return { store, close: () => fake.close() };
  }],
  // Drive keeps one flat folder: plain/ is part of each file's name.
  ['Google Drive (flat names)', async () => {
    drive = await startFakeGoogleDrive();
    const endpoints = { api: drive.env.WALNUT_GDRIVE_API_URL, upload: drive.env.WALNUT_GDRIVE_UPLOAD_URL };
    const token = drive.mintAccessToken();
    const getAccessToken = async () => token;
    const retry = { sleep: async () => {} };
    const folder = await findOrCreateFolder('Walnut Backup', getAccessToken, endpoints, undefined, retry);
    const store = new DriveStore({ folderId: folder.id, folderName: 'Walnut Backup', getAccessToken, endpoints, retry });
    const d = drive;
    return { store, close: async () => { await d.close(); drive = null; } };
  }],
];

describe('which kind a backup is', () => {
  it('the switch as set wins; unset, only a setup that saved its recovery key is encrypted', () => {
    expect(backupEncrypted(undefined)).toBe(false);
    expect(backupEncrypted({})).toBe(false);
    expect(backupEncrypted({ recovery_key_saved_at: '2026-11-01T00:00:00Z' })).toBe(true);
    expect(backupEncrypted({ encrypt: false, recovery_key_saved_at: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(backupEncrypted({ encrypt: true })).toBe(true);
  });

  it('unset, encrypted backups already at the destination keep it encrypted (a terminal-only setup never saved its key)', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    // As `open-walnut backup run` made them: the switch unset, no key step.
    await runEncryptedBackup({ enabled: true, destination: DEST, encrypt: true }, { dataDir: home, store });
    const r = await runEncryptedBackup(plainCfg(), { dataDir: home, store });
    expect(r.encrypted).toBe(true);
    expect(await store.list(PLAIN_ROOT)).toEqual([]);
    expect(await testDestination(DEST, { dataDir: home, store })).toMatchObject({ encrypted: true, hasBackups: true, keyMatches: true });
    // Set off on purpose, it is unencrypted from then on.
    expect((await runEncryptedBackup(plainCfg({ encrypt: false }), { dataDir: home, store })).encrypted).toBe(false);
  }, 60_000);

  it('an unencrypted setup is ready to run with no recovery key; an encrypted one waits for it', async () => {
    expect(await isBackupConfigured(plainCfg(), home)).toBe(true);
    expect(await isBackupConfigured(plainCfg({ encrypt: true }), home)).toBe(false);
    expect(await isBackupConfigured(encCfg(), home)).toBe(true);
  });
});

describe.each(stores)('unencrypted backups on %s', (_name, make) => {
  it('back up with no key, again cheaply, and restore byte for byte', async () => {
    const { store, close } = await make();
    try {
      const first = await runEncryptedBackup(plainCfg(), { dataDir: home, store });
      expect(first.fileCount).toBeGreaterThanOrEqual(3);
      // No key was made or needed, and the repository says it is unencrypted.
      expect(await readRecoveryKey(home)).toBeNull();
      const config = JSON.parse((await store.get(PLAIN_ROOT + REPO_CONFIG_KEY)).toString('utf8'));
      expect(config.encryption).toBe('none');
      // Nothing at the root: that is where encrypted backups live.
      await expect(store.get(REPO_CONFIG_KEY)).rejects.toThrow();
      // Stored as is: the clip's bytes are in a pack.
      expect((await allBytes(store, `${PLAIN_ROOT}packs/`)).includes(video.subarray(1000, 1064))).toBe(true);

      const second = await runEncryptedBackup(plainCfg(), { dataDir: home, store });
      expect(second.uploadedBytes).toBeLessThan(first.uploadedBytes / 10);
      expect(second.snapshotCount).toBe(2);

      const target = path.join(root, 'restored');
      const r = await restoreEncryptedBackup(plainCfg(), { dataDir: home, store, snapshotId: 'latest', targetDir: target });
      expect(r.restoredFiles).toBe(second.fileCount);
      for (const f of ['auth.json', 'notes/日记/run.md', 'notes/_attachment/clip.mp4']) {
        expect((await fsp.readFile(path.join(target, f))).equals(await fsp.readFile(path.join(home, f))), f).toBe(true);
      }
      const listing = await listEncryptedBackups(plainCfg(), { dataDir: home, store });
      expect(listing.encrypted).toBe(false);
      expect(listing.snapshots).toHaveLength(2);
      expect(listing.snapshots.every((s) => s.encrypted === false)).toBe(true);
      expect(listing.thisWriter).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);
});

describe('both kinds at one destination', () => {
  it('switching either way keeps every backup, lists both, and restores each', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    // Encrypted first (an older setup), then the switch turned off, then on again.
    const enc1 = await runEncryptedBackup(encCfg(), { dataDir: home, store });
    const key = await readRecoveryKey(home);
    expect(key).toMatch(/^WB1-/);
    const encObjects = (await store.list('')).filter((o) => !o.key.startsWith(PLAIN_ROOT));

    await write('notes/日记/run.md', '# Run\n\nRan 7 km.\n');
    const plain1 = await runEncryptedBackup(plainCfg({ recovery_key_saved_at: '2026-11-19T00:00:00Z', encrypt: false }), { dataDir: home, store });
    // The unencrypted run and its prune left the encrypted repository exactly as it was.
    const encAfter = (await store.list('')).filter((o) => !o.key.startsWith(PLAIN_ROOT));
    expect(encAfter.map((o) => [o.key, o.size])).toEqual(encObjects.map((o) => [o.key, o.size]));
    // A prune that really deletes (a month on, one backup kept) touches only its own kind.
    for (let i = 0; i < 2; i++) {
      await write(`notes/extra-${i}.md`, randomBytes(50_000).toString('hex'));
      await runEncryptedBackup(plainCfg({ encrypt: false }), { dataDir: home, store });
    }
    const plainRepo = await Repository.open(repoStore(store, false), null);
    const pruned = await pruneRepo(plainRepo, { daily: 1, weekly: 0, recent: 1, withinHours: 1 }, { now: Date.now() + 30 * 86_400_000, writer: await localWriter(home) });
    expect(pruned.forgotten.length).toBeGreaterThan(0);
    expect((await store.list('')).filter((o) => !o.key.startsWith(PLAIN_ROOT)).map((o) => [o.key, o.size])).toEqual(encObjects.map((o) => [o.key, o.size]));
    // The forgotten ones are gone from the listing; the kept unencrypted one is the newest.
    const left = (await listEncryptedBackups(plainCfg({ encrypt: false }), { dataDir: home, store })).snapshots.filter((x) => !x.encrypted);
    expect(left).toHaveLength(1);
    expect(left[0].id).not.toBe(plain1.snapshotId);
    // plain1 restores no more (forgotten); the test below needs one: make it again.
    await write('notes/日记/run.md', '# Run\n\nRan 7 km.\n');
    const plain2 = await runEncryptedBackup(plainCfg({ encrypt: false }), { dataDir: home, store });

    const asPlain = await listEncryptedBackups(plainCfg(), { dataDir: home, store });
    expect(asPlain.snapshots[0]).toMatchObject({ id: plain2.snapshotId, encrypted: false });
    expect(asPlain.snapshots.at(-1)).toMatchObject({ id: enc1.snapshotId, encrypted: true });

    // Back on: the encrypted repository takes up where it was; the unencrypted one is untouched.
    const plainObjects = await store.list(PLAIN_ROOT);
    // Snapshot ids sort by the second they were made: the next one is a second later.
    await new Promise((r) => setTimeout(r, 1100));
    const enc2 = await runEncryptedBackup(encCfg(), { dataDir: home, store });
    expect(enc2.snapshotCount).toBe(2);
    expect((await store.list(PLAIN_ROOT)).map((o) => o.key)).toEqual(plainObjects.map((o) => o.key));

    // Each restores by id whichever kind is set now.
    const oldEnc = path.join(root, 'old-enc');
    await restoreEncryptedBackup(plainCfg(), { dataDir: home, store, snapshotId: enc1.snapshotId, targetDir: oldEnc });
    expect(await fsp.readFile(path.join(oldEnc, 'notes/日记/run.md'), 'utf8')).toContain('Ran 5 km');
    const oldPlain = path.join(root, 'old-plain');
    await restoreEncryptedBackup(encCfg(), { dataDir: home, store, snapshotId: plain2.snapshotId, targetDir: oldPlain });
    expect(await fsp.readFile(path.join(oldPlain, 'notes/日记/run.md'), 'utf8')).toContain('Ran 7 km');

    // 'latest' is the newest of both kinds, whichever is set: here the encrypted enc2.
    const latest = path.join(root, 'latest');
    expect((await restoreEncryptedBackup(plainCfg({ encrypt: false }), { dataDir: home, store, snapshotId: 'latest', targetDir: latest })).snapshot.id).toBe(enc2.snapshotId);

    // Without this machine's key the encrypted ones are still said, never read or replaced.
    await fsp.rm(recoveryKeyPath(home));
    const noKey = await listEncryptedBackups(plainCfg({ encrypt: false }), { dataDir: home, store });
    expect(noKey.lockedEncrypted).toBe(true);
    expect(noKey.snapshots.every((s) => !s.encrypted)).toBe(true);
    expect(await store.get(REPO_CONFIG_KEY)).toBeTruthy();
  }, 60_000);

  it('the connection test says which kind is there', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    expect(await testDestination(DEST, { dataDir: home, store, encrypted: false })).toMatchObject({ ok: true, hasBackups: false });
    await runEncryptedBackup(encCfg(), { dataDir: home, store });
    expect(await testDestination(DEST, { dataDir: home, store, encrypted: false }))
      .toMatchObject({ ok: true, hasBackups: false, hasEncryptedBackups: true });
    await runEncryptedBackup(plainCfg({ encrypt: false }), { dataDir: home, store });
    expect(await testDestination(DEST, { dataDir: home, store, encrypted: false }))
      .toMatchObject({ ok: true, hasBackups: true, keyMatches: true, thisWriter: true });
  }, 60_000);

  it('an encrypted repository with no backups left in it is not said as "encrypted backups here"', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    await runEncryptedBackup(encCfg(), { dataDir: home, store });
    for (const o of await store.list('snapshots/')) await store.delete(o.key);
    expect(await store.get(REPO_CONFIG_KEY)).toBeTruthy();
    expect((await testDestination(DEST, { dataDir: home, store, encrypted: false })).hasEncryptedBackups).toBeUndefined();
    // Nor is it "locked" when this computer has no key that opens it.
    await fsp.rm(recoveryKeyPath(home));
    expect((await listEncryptedBackups(plainCfg({ encrypt: false }), { dataDir: home, store })).lockedEncrypted).toBeUndefined();
  }, 60_000);
});

describe('refusals', () => {
  it('a key never opens an unencrypted repository, and none opens an encrypted one', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    await runEncryptedBackup(plainCfg(), { dataDir: home, store });
    const raw = parseRecoveryKey(generateRecoveryKey());
    await expect(Repository.open(repoStore(store, false), raw)).rejects.toThrow(/not encrypted/);
    await runEncryptedBackup(encCfg(), { dataDir: home, store });
    await expect(Repository.open(repoStore(store, true), null)).rejects.toThrow(/encrypted: they open only with their recovery key/);
  }, 60_000);

  it('a damaged unencrypted pack is refused, never restored as bad data', async () => {
    const dir = path.join(root, 'dest');
    const store = new LocalStore(dir);
    await runEncryptedBackup(plainCfg(), { dataDir: home, store });
    const [pack] = (await store.list(`${PLAIN_ROOT}packs/`)).sort((a, b) => b.size - a.size);
    const body = await store.get(pack.key);
    body[Math.floor(body.length / 2)] ^= 0xff;
    await store.put(pack.key, body);
    await expect(restoreEncryptedBackup(plainCfg(), { dataDir: home, store, snapshotId: 'latest', targetDir: path.join(root, 'r') }))
      .rejects.toThrow(/damaged/);
  }, 60_000);

  it('every unencrypted object carries a checksum bound to its name: a changed byte or a moved object is refused', () => {
    const body = Buffer.from('{"files":["notes/a.md"]}');
    const sealed = seal(PLAIN_KEYS, body, 'snapshot:abc');
    // Readable as stored (after the 32-byte checksum).
    expect(sealed.subarray(32).equals(body)).toBe(true);
    expect(open(PLAIN_KEYS, sealed, 'snapshot:abc').equals(body)).toBe(true);
    const changed = Buffer.from(sealed);
    changed[40] ^= 1;
    expect(() => open(PLAIN_KEYS, changed, 'snapshot:abc')).toThrow(/checksum does not match/);
    expect(() => open(PLAIN_KEYS, sealed, 'snapshot:other')).toThrow(/checksum does not match/);
    expect(() => open(PLAIN_KEYS, sealed.subarray(0, 10), 'snapshot:abc')).toThrow(/truncated/);
  }, 60_000);
});
