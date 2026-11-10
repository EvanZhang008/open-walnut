/**
 * The repository's safety rules, each pinned by the way it was found broken
 * in review: a stale index, a snapshot that does not read, the writer moving,
 * packs of a run still going, two processes on one data home, two windows
 * making the key at once, and what a restored home must not carry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import { generateRecoveryKey, parseRecoveryKey } from '../../../src/core/backup/repo/crypto.js';
import { loadLiveIndex, runRepoBackup } from '../../../src/core/backup/repo/backup-run.js';
import { restoreRepoSnapshot } from '../../../src/core/backup/repo/restore.js';
import { pruneRepo } from '../../../src/core/backup/repo/prune.js';
import { Repository } from '../../../src/core/backup/repo/repository.js';
import { ensureRecoveryKey, readRecoveryKey, recoveryKeyPath, writeRecoveryKey } from '../../../src/core/backup/recovery-key.js';
import { BackupLockedError, backupLockHeld, localWriter, machineIdPath, runLockPath, withBackupLock } from '../../../src/core/backup/local-state.js';
import { scanDataDir } from '../../../src/core/backup/scan.js';

const H = { id: 'c'.repeat(32), name: 'h' };
const B = { id: 'b'.repeat(32), name: 'mac-b' };
const LATER = 7 * 3_600_000;

let root: string;
let home: string;
let store: LocalStore;
let raw: Buffer;

async function write(rel: string, body: string | Buffer): Promise<void> {
  const p = path.join(home, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-repo-safety-'));
  home = path.join(root, 'home');
  await write('notes/a.md', '# a\n'.repeat(1000));
  await write('notes/blob.bin', randomBytes(2 * 1024 * 1024));
  store = new LocalStore(path.join(root, 'dest'));
  raw = parseRecoveryKey(generateRecoveryKey());
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const packKeys = async (): Promise<string[]> => (await store.list('packs/')).map((o) => o.key).sort();

describe('the index', () => {
  it('a stale index naming a deleted pack does not hide the live pack holding the same blobs', async () => {
    await runRepoBackup(store, raw, { dataDir: home, writer: H });
    const repo = await Repository.open(store, raw);
    const { index } = await loadLiveIndex(repo);
    const real = [...index.packs.values()].find((p) => p.type === 'data')!;
    // An index read FIRST (keys sort) that places those blobs in a pack that is gone.
    const ghost = { ...real, id: 'f'.repeat(64) };
    await (repo as unknown as { writeSealedJson(k: string, v: unknown): Promise<void> }).writeSealedJson('index/0-stale', { version: 1, packs: [ghost] });

    const live = await loadLiveIndex(repo);
    for (const [id] of real.blobs) expect(live.index.blobs.get(id)?.pack).toBe(real.id);

    // Prune must keep that pack, and the backup still restores.
    await write('notes/new.md', 'new');
    await runRepoBackup(store, raw, { dataDir: home, writer: H });
    await pruneRepo(repo, { daily: 1, weekly: 0 }, { now: Date.now() + LATER, writer: H });
    expect(await packKeys()).toContain(`packs/${real.id.slice(0, 2)}/${real.id}`);
    const target = path.join(root, 'r');
    await restoreRepoSnapshot(store, raw, target, { snapshotId: 'latest' });
    expect((await fsp.readFile(path.join(target, 'notes/blob.bin'))).equals(await fsp.readFile(path.join(home, 'notes/blob.bin')))).toBe(true);
  }, 60_000);
});

describe('prune refuses when it could be wrong', () => {
  async function threeBackups(): Promise<Repository> {
    for (let i = 0; i < 3; i++) {
      await write('notes/rotating.bin', randomBytes(1024 * 1024));
      await runRepoBackup(store, raw, { dataDir: home, writer: H });
    }
    return Repository.open(store, raw);
  }

  it('a snapshot that does not read: nothing is deleted', async () => {
    const repo = await threeBackups();
    await store.put('snapshots/zzzz-unreadable', Buffer.from('not sealed'));
    const before = await packKeys();
    const r = await pruneRepo(repo, { daily: 1, weekly: 0 }, { now: Date.now() + LATER, writer: H });
    expect(r.skipped).toMatch(/could not be read/);
    expect(r.forgotten).toEqual([]);
    expect(await packKeys()).toEqual(before);
  }, 60_000);

  it('the run\'s own snapshot not listed: nothing is deleted', async () => {
    const repo = await threeBackups();
    const r = await pruneRepo(repo, { daily: 1, weekly: 0 }, { now: Date.now() + LATER, writer: H, mustKeep: 'not-there' });
    expect(r.skipped).toMatch(/not listed/);
    expect((await repo.listSnapshots()).snapshots).toHaveLength(3);
  }, 60_000);

  it('another machine took the writer role: nothing is deleted', async () => {
    const repo = await threeBackups();
    await repo.setWriter(B);
    const before = await packKeys();
    const r = await pruneRepo(repo, { daily: 1, weekly: 0 }, { now: Date.now() + LATER, writer: H });
    expect(r.skipped).toMatch(/another machine/);
    expect(await packKeys()).toEqual(before);
  }, 60_000);

  it('packs younger than the grace are kept, so a run still going never loses its packs', async () => {
    const repo = await threeBackups();
    const before = await packKeys();
    const r = await pruneRepo(repo, { daily: 1, weekly: 0 }, { writer: H });
    expect(r.forgotten).toHaveLength(2);
    expect(r.deletedPacks).toBe(0);
    expect(await packKeys()).toEqual(before);
    // Later, the same prune frees them.
    const later = await pruneRepo(repo, { daily: 1, weekly: 0 }, { now: Date.now() + LATER, writer: H });
    expect(later.deletedPacks).toBeGreaterThanOrEqual(1);
    await restoreRepoSnapshot(store, raw, path.join(root, 'r'), { snapshotId: 'latest' });
  }, 60_000);
});

describe('one data home, one job at a time across processes', () => {
  it('a second holder is refused while the first is alive, and a dead holder\'s lock is taken over', async () => {
    let release!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((r) => { entered = r; });
    const first = withBackupLock(home, () => { entered(); return new Promise<void>((r) => { release = r; }); });
    // The first holder is inside the lock: the second is asked only then.
    await holding;
    await expect(withBackupLock(home, async () => 1)).rejects.toBeInstanceOf(BackupLockedError);
    release();
    await first;
    await expect(fsp.stat(runLockPath(home))).rejects.toThrow();

    // A lock left by a process that is gone.
    await fsp.writeFile(runLockPath(home), '999999 deadbeef Mon Jan 1 00:00:00 2024\n');
    expect(await withBackupLock(home, async () => 'ran', { alive: () => false })).toBe('ran');
    // A lock whose pid was reused by a process started at another time.
    await fsp.writeFile(runLockPath(home), `${process.pid} deadbeef Mon Jan 1 00:00:00 2024\n`);
    expect(await withBackupLock(home, async () => 'ran', { alive: () => true, started: async () => 'Tue Nov 4 06:00:00 2026' })).toBe('ran');
  });

  it('an EEXIST thrown by the work itself is its own error, not a held lock', async () => {
    const err = Object.assign(new Error('exists'), { code: 'EEXIST' });
    await expect(withBackupLock(home, async () => { throw err; })).rejects.toBe(err);
    await expect(fsp.stat(runLockPath(home))).rejects.toThrow();
  });

  it('tells whether a live process holds the lock (the busy notice goes when it ends)', async () => {
    expect(await backupLockHeld(home)).toBe(false);
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const job = withBackupLock(home, () => new Promise<void>((r) => { release = r; entered(); }));
    await inside;
    expect(await backupLockHeld(home)).toBe(true);
    release();
    await job;
    expect(await backupLockHeld(home)).toBe(false);
    await fsp.writeFile(runLockPath(home), '999999 deadbeef Mon Jan 1 00:00:00 2024\n');
    expect(await backupLockHeld(home, { alive: () => false })).toBe(false);
  });
});

describe('the recovery key', () => {
  it('callers asking at once all get the one key that is on disk', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureRecoveryKey(home)));
    const keys = new Set(results.map((r) => r.key));
    expect(keys.size).toBe(1);
    expect(await readRecoveryKey(home)).toBe(results[0].key);
  });

  it('a key made by another process first is kept, never replaced', async () => {
    const theirs = generateRecoveryKey();
    await fsp.mkdir(path.dirname(recoveryKeyPath(home)), { recursive: true });
    await fsp.writeFile(recoveryKeyPath(home), `${theirs}\n`);
    const r = await ensureRecoveryKey(home);
    expect(r).toEqual({ key: theirs, created: false });
  });

  it('a typed key never replaces what was on disk without keeping a copy, an unreadable file included', async () => {
    const dir = path.dirname(recoveryKeyPath(home));
    const asides = async () => (await fsp.readdir(dir)).filter((f) => f.startsWith('recovery-key.replaced-'));
    const first = generateRecoveryKey();
    await writeRecoveryKey(home, first);
    expect(await asides()).toEqual([]);
    // The same key again (typed in another form): nothing to keep.
    await writeRecoveryKey(home, first.toLowerCase());
    expect(await asides()).toEqual([]);
    // Another key: the old one is kept beside it.
    const second = generateRecoveryKey();
    await writeRecoveryKey(home, second);
    const kept = await asides();
    expect(kept).toHaveLength(1);
    expect((await fsp.readFile(path.join(dir, kept[0]), 'utf8')).trim()).toBe(first);
    // A damaged file is kept too.
    await fsp.writeFile(recoveryKeyPath(home), 'WB1-damaged by hand\n');
    // Each kept copy is named by its time: let the clock move past the first copy's name.
    for (const t = Date.now(); Date.now() <= t + 2;) await new Promise((r) => setImmediate(r));
    await writeRecoveryKey(home, first);
    const all = await asides();
    expect(all).toHaveLength(2);
    const texts = await Promise.all(all.map((f) => fsp.readFile(path.join(dir, f), 'utf8')));
    expect(texts.map((t) => t.trim())).toContain('WB1-damaged by hand');
    expect(await readRecoveryKey(home)).toBe(first);
  });
});

describe('what a restored home carries', () => {
  it('the machine id and the run lock stay home; the key and executables come back', async () => {
    const me = await localWriter(home);
    expect(me.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await localWriter(home)).id).toBe(me.id);
    await ensureRecoveryKey(home);
    await write('plugins/x/bin/run.sh', '#!/bin/sh\necho hi\n');
    await fsp.chmod(path.join(home, 'plugins/x/bin/run.sh'), 0o755);
    await fsp.writeFile(runLockPath(home), 'stale');

    const scanned = (await scanDataDir(home)).map((e) => e.path);
    expect(scanned).not.toContain('local/backup/machine-id');
    expect(scanned).not.toContain('local/backup/run.lock');
    expect(scanned).toContain('local/backup/recovery-key');
    // The plaintext mirror never carries the key.
    expect((await scanDataDir(home, { withoutBackupSecrets: true })).map((e) => e.path)).not.toContain('local/backup/recovery-key');

    await runRepoBackup(store, raw, { dataDir: home, writer: me });
    const target = path.join(root, 'restored');
    await restoreRepoSnapshot(store, raw, target, { snapshotId: 'latest' });
    await expect(fsp.stat(machineIdPath(target))).rejects.toThrow();
    expect(await readRecoveryKey(target)).toBe(await readRecoveryKey(home));
    expect((await fsp.stat(path.join(target, 'plugins/x/bin/run.sh'))).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(path.join(target, 'notes/a.md'))).mode & 0o777).toBe(0o600);
    // The restored home is a new writer until the user moves the role to it.
    const other = await localWriter(target);
    expect(other.id).not.toBe(me.id);
    await expect(runRepoBackup(store, raw, { dataDir: target, writer: other })).rejects.toMatchObject({ code: 'other_writer' });
  }, 60_000);
});
