/**
 * Encrypted backups end to end on real stores: a local folder and an
 * S3-protocol server (the AWS SDK on the wire, as R2 and MinIO see it).
 * Backup, incremental backup, restore into a fresh folder, retention and
 * prune, and the refusals that protect someone's backups.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import Database from '../../../src/lib/sqlite.js';
import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import { S3Store } from '../../../src/core/backup/stores/s3-store.js';
import type { BackupStore } from '../../../src/core/backup/stores/types.js';
import { generateRecoveryKey, parseRecoveryKey } from '../../../src/core/backup/repo/crypto.js';
import { runRepoBackup } from '../../../src/core/backup/repo/backup-run.js';
import { restoreRepoSnapshot } from '../../../src/core/backup/repo/restore.js';
import { pruneRepo, selectKept, isoWeekKey } from '../../../src/core/backup/repo/prune.js';
import { Repository } from '../../../src/core/backup/repo/repository.js';
import { REPO_CONFIG_KEY } from '../../../src/core/backup/repo/format.js';
import { startFakeS3, type FakeS3 } from '../../helpers/fake-s3-server.js';

let root: string;
let home: string;

const A = { id: 'a'.repeat(32), name: 'mac-a' };
const B = { id: 'b'.repeat(32), name: 'mac-b' };
const H = { id: 'c'.repeat(32), name: 'h' };
/** Past the prune's grace for fresh packs (6 h). */
const LATER = 7 * 3_600_000;

async function write(rel: string, body: string | Buffer, mtime?: Date): Promise<void> {
  const p = path.join(home, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body);
  if (mtime) await fsp.utimes(p, mtime, mtime);
}

/** A small but realistic data home: notes, tasks DB, Unicode names, a big file, junk that must stay home. */
async function seedHome(): Promise<void> {
  await write('config.yaml', 'backup:\n  enabled: true\n');
  await write('auth.json', JSON.stringify({ secret: 'token-123' }));
  await write('notes/日记/2026-11-04 晨跑.md', '# 晨跑\n\nRan 5 km.\n'.repeat(200));
  await write('notes/empty.md', '');
  await write('notes/_attachment/video.mp4', randomBytes(3 * 1024 * 1024 + 17));
  await write('notes/big-log.txt', 'line of a log that compresses well\n'.repeat(150_000));
  await write('cache/should-not-ship.bin', randomBytes(1000));
  await write('tmp/scratch.txt', 'scratch');
  await write('health/steps.json', '{"private":true}');
  await fsp.mkdir(path.join(home, 'tasks'), { recursive: true });
  const db = new Database(path.join(home, 'tasks', 'tasks.sqlite'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT)');
  const ins = db.prepare('INSERT INTO t (title) VALUES (?)');
  db.exec('BEGIN');
  for (let i = 0; i < 2000; i++) ins.run(`task ${i} ${'x'.repeat(50)}`);
  db.exec('COMMIT');
  db.close();
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out.push(r);
    }
  };
  await walk('');
  return out.sort();
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-repo-'));
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  await seedHome();
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const stores: Array<[string, () => Promise<{ store: BackupStore; close: () => Promise<void>; fake?: FakeS3 }>]> = [
  ['local folder', async () => ({ store: new LocalStore(path.join(root, 'dest')), close: async () => {} })],
  ['S3 protocol (R2 / MinIO shape)', async () => {
    const fake = await startFakeS3({ buckets: ['b'], pageSize: 7 });
    const store = new S3Store({
      kind: 'r2', bucket: 'b', prefix: 'walnut-backup', endpoint: fake.url,
      accessKeyId: 'AKTEST', secretAccessKey: 'secret',
    });
    return { store, close: () => fake.close(), fake };
  }],
];

describe.each(stores)('encrypted backup on %s', (_name, make) => {
  it('backs up, backs up again cheaply, and restores byte for byte', async () => {
    const { store, close, fake } = await make();
    try {
      const raw = parseRecoveryKey(generateRecoveryKey());
      const first = await runRepoBackup(store, raw, { dataDir: home, writer: A });
      expect(first.fileCount).toBeGreaterThan(5);
      expect(first.skipped).toEqual([]);

      // Nothing in the store is plaintext.
      const objs = await store.list('');
      for (const o of objs.filter((x) => x.key !== REPO_CONFIG_KEY)) {
        const body = await store.get(o.key);
        expect(body.includes(Buffer.from('token-123'))).toBe(false);
        expect(body.includes(Buffer.from('晨跑'))).toBe(false);
        expect(body.includes(Buffer.from('line of a log'))).toBe(false);
      }
      if (fake) expect(fake.requests.some((r) => r.startsWith('GET /b/walnut-backup/'))).toBe(true);

      // A second run with nothing changed reads only the sqlite snapshot again, and its pages dedupe.
      const second = await runRepoBackup(store, raw, { dataDir: home, writer: A });
      expect(second.changedFiles).toBeLessThanOrEqual(1);
      expect(second.uploadedBytes).toBeLessThan(first.uploadedBytes / 10);

      // Change one note: only that note's chunk is new.
      await write('notes/日记/2026-11-04 晨跑.md', '# 晨跑\n\nRan 7 km today.\n');
      const third = await runRepoBackup(store, raw, { dataDir: home, writer: A });
      expect(third.changedFiles).toBeLessThanOrEqual(2);

      const target = path.join(root, 'restored');
      const r = await restoreRepoSnapshot(store, raw, target, { snapshotId: 'latest' });
      expect(r.restoredFiles).toBe(third.fileCount);
      const restored = await listFiles(target);
      expect(restored).toContain('tasks/tasks.sqlite');
      expect(restored).toContain('notes/日记/2026-11-04 晨跑.md');
      expect(restored).toContain('notes/empty.md');
      expect(restored.some((f) => f.startsWith('cache/') || f.startsWith('tmp/') || f.startsWith('health/'))).toBe(false);
      for (const f of restored.filter((x) => !x.endsWith('.sqlite'))) {
        const a = await fsp.readFile(path.join(home, f));
        const b = await fsp.readFile(path.join(target, f));
        expect(b.equals(a), f).toBe(true);
        const [sa, sb] = await Promise.all([fsp.stat(path.join(home, f)), fsp.stat(path.join(target, f))]);
        expect(Math.floor(sb.mtimeMs)).toBe(Math.floor(sa.mtimeMs));
      }
      const db = new Database(path.join(target, 'tasks', 'tasks.sqlite'), { readonly: true });
      expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(2000);
      db.close();

      // An older backup still restores to what it held then.
      const { snapshots } = await (await Repository.open(store, raw, { })).listSnapshots();
      expect(snapshots).toHaveLength(3);
      const old = path.join(root, 'restored-old');
      await restoreRepoSnapshot(store, raw, old, { snapshotId: snapshots[2].id });
      expect((await fsp.readFile(path.join(old, 'notes/日记/2026-11-04 晨跑.md'), 'utf8'))).toContain('Ran 5 km');
    } finally {
      await close();
    }
  }, 60_000);

  it('refuses a wrong key, a non-empty target, and a second machine writing', async () => {
    const { store, close } = await make();
    try {
      const raw = parseRecoveryKey(generateRecoveryKey());
      await runRepoBackup(store, raw, { dataDir: home, writer: A });
      const wrong = parseRecoveryKey(generateRecoveryKey());
      await expect(runRepoBackup(store, wrong, { dataDir: home, writer: A })).rejects.toMatchObject({ code: 'key_mismatch' });
      await expect(restoreRepoSnapshot(store, wrong, path.join(root, 'x'), { snapshotId: 'latest' })).rejects.toMatchObject({ code: 'key_mismatch' });
      // The repository config is untouched by the refusals.
      const repo = await Repository.open(store, raw);
      expect(repo.config.writer.id).toBe(A.id);
      expect(repo.writerName()).toBe('mac-a');
      // The plaintext config names no machine: only the id, the name sealed.
      expect((await store.get(REPO_CONFIG_KEY)).toString('utf8')).not.toContain('mac-a');

      await expect(restoreRepoSnapshot(store, raw, home, { snapshotId: 'latest' })).rejects.toThrow(/not empty/);
      await expect(runRepoBackup(store, raw, { dataDir: home, writer: B })).rejects.toMatchObject({ code: 'other_writer' });
      await repo.setWriter(B);
      const r = await runRepoBackup(store, raw, { dataDir: home, writer: B });
      expect(r.fileCount).toBeGreaterThan(0);
      await expect(runRepoBackup(store, raw, { dataDir: home, writer: A })).rejects.toMatchObject({ code: 'other_writer' });
    } finally {
      await close();
    }
  }, 60_000);
});

describe('restore integrity', () => {
  it('refuses a damaged pack instead of writing bad data', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    const raw = parseRecoveryKey(generateRecoveryKey());
    await runRepoBackup(store, raw, { dataDir: home, writer: H });
    const packs = await store.list('packs/');
    const victim = packs.sort((a, b) => b.size - a.size)[0];
    const body = await store.get(victim.key);
    body[100] ^= 0xff;
    await store.put(victim.key, body);
    await expect(restoreRepoSnapshot(store, raw, path.join(root, 'r'), { snapshotId: 'latest' })).rejects.toThrow(/damaged|missing/);
  }, 60_000);

  it('keeps the previous copy of a file it cannot read this time', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    const raw = parseRecoveryKey(generateRecoveryKey());
    await runRepoBackup(store, raw, { dataDir: home, writer: H });
    const file = path.join(home, 'notes/big-log.txt');
    await fsp.appendFile(file, 'more\n');
    await fsp.chmod(file, 0o000);
    try {
      const r = await runRepoBackup(store, raw, { dataDir: home, writer: H });
      if (process.getuid?.() !== 0) expect(r.skipped).toContain('notes/big-log.txt');
      const target = path.join(root, 'r');
      await restoreRepoSnapshot(store, raw, target, { snapshotId: 'latest' });
      expect((await fsp.stat(path.join(target, 'notes/big-log.txt'))).size).toBeGreaterThan(1_000_000);
    } finally {
      await fsp.chmod(file, 0o644);
    }
  }, 60_000);
});

describe('retention', () => {
  const at = (iso: string, id = iso) => ({ id, createdAt: new Date(iso).toISOString() });

  it('keeps the newest per day for 7 days and per week for 4 weeks', () => {
    const snaps = [];
    // Hourly-ish backups over 40 days.
    for (let d = 0; d < 40; d++) {
      for (const h of [9, 15, 21]) snaps.push(at(new Date(2026, 9, 1 + d, h).toISOString()));
    }
    const kept = selectKept(snaps, { daily: 7, weekly: 4 });
    const newest = snaps[snaps.length - 1].id;
    expect(kept.has(newest)).toBe(true);
    const keptDates = [...kept].map((id) => new Date(id));
    const days = new Set(keptDates.map((d) => d.toDateString()));
    // 7 days + up to 4 week-ends outside those days.
    expect(days.size).toBeGreaterThanOrEqual(7);
    expect(kept.size).toBeLessThanOrEqual(11);
    // Never two kept in one day.
    expect(days.size).toBe(kept.size);
    const weeks = new Set(keptDates.map(isoWeekKey));
    expect(weeks.size).toBeGreaterThanOrEqual(4);
  });

  it('names ISO weeks correctly across a year end', () => {
    expect(isoWeekKey(new Date(2026, 11, 31))).toBe('2026-W53');
    expect(isoWeekKey(new Date(2027, 0, 4))).toBe('2027-W1');
    expect(isoWeekKey(new Date(2025, 11, 29))).toBe('2026-W1');
  });

  it('prune forgets old snapshots, frees their packs, and every kept one still restores', async () => {
    const store = new LocalStore(path.join(root, 'dest'));
    const raw = parseRecoveryKey(generateRecoveryKey());
    // Three backups, each with a different big file, so each owns packs.
    for (let i = 0; i < 3; i++) {
      await write('notes/rotating.bin', randomBytes(2 * 1024 * 1024));
      await runRepoBackup(store, raw, { dataDir: home, writer: H });
    }
    const repo = await Repository.open(store, raw);
    const before = (await store.list('packs/')).reduce((n, o) => n + o.size, 0);
    // daily: 1 keeps only the newest (all three are today).
    const result = await pruneRepo(repo, { daily: 1, weekly: 0 }, { now: Date.now() + LATER, writer: H });
    expect(result.forgotten).toHaveLength(2);
    const after = (await store.list('packs/')).reduce((n, o) => n + o.size, 0);
    // The middle backup's file sat alone in its pack: that pack is gone. (The first
    // backup's copy shares a pack with a file still kept, which is under the repack bar.)
    expect(result.deletedPacks).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThan(before - 2 * 1024 * 1024 + 1);
    expect(await store.list('index/')).toHaveLength(1);
    const target = path.join(root, 'r');
    await restoreRepoSnapshot(store, raw, target, { snapshotId: 'latest' });
    expect((await fsp.readFile(path.join(target, 'notes/rotating.bin'))).equals(await fsp.readFile(path.join(home, 'notes/rotating.bin')))).toBe(true);
    // And a backup after the prune still dedupes against what survived.
    const next = await runRepoBackup(store, raw, { dataDir: home, writer: H });
    expect(next.changedFiles).toBeLessThanOrEqual(1);
  }, 60_000);
});
