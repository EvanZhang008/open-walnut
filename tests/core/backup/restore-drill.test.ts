/**
 * The restore drill (src/core/backup/restore-drill.ts) on real repositories in a local
 * folder: a good backup passes and lists what backups leave out by design; a damaged
 * chunk, a torn database, a file the repository lacks and a file left out of the backup
 * each fail it and name the cause; it writes nothing in the data home or the
 * destination; its temporary folder is gone after a pass, a failure and a kill.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import type { BackupStore } from '../../../src/core/backup/stores/types.js';
import { runEncryptedBackup } from '../../../src/core/backup/encrypted-backup.js';
import { repoStore } from '../../../src/core/backup/repo-mode.js';
import { parseRecoveryKey } from '../../../src/core/backup/repo/crypto.js';
import { readRecoveryKey } from '../../../src/core/backup/recovery-key.js';
import {
  DRILL_DIR_PREFIX, DRILL_FREE_RESERVE_BYTES, readDrillRecord, readOnlyStore, removeLeftoverDrills, runRestoreDrill, writeDrillRecord,
  type DrillResult,
} from '../../../src/core/backup/restore-drill.js';
import type { BackupConfig } from '../../../src/core/backup/types.js';
import { chmodTree, listing, makeDb, makeFullHome, write, writeAlteredSnapshot } from './restore-drill-helpers.js';
import { runRestoreDrillLocked } from '../../../src/core/backup/restore-drill.js';
import { checkRestoredFiles } from '../../../src/core/backup/restore-drill-checks.js';
import { restoreRepoSnapshot } from '../../../src/core/backup/repo/restore.js';
import { Repository, PackCache } from '../../../src/core/backup/repo/repository.js';
import { loadLiveIndex } from '../../../src/core/backup/repo/backup-run.js';
import { runLockPath } from '../../../src/core/backup/local-state.js';

let root: string;
let home: string;
let destDir: string;
let tmpRoot: string;
let stateDir: string;
let store: BackupStore;

const DEST = { type: 'r2' as const, bucket: 'b', account_id: '0'.repeat(32), access_key_id: 'AK', secret_access_key: 'S' };
const plainCfg: BackupConfig = { enabled: true, destination: DEST, encrypt: false };
const encCfg: BackupConfig = { enabled: true, destination: DEST, encrypt: true, recovery_key_saved_at: '2026-11-19T00:00:00Z' };

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drill-'));
  home = path.join(root, 'home');
  destDir = path.join(root, 'dest');
  tmpRoot = path.join(root, 'drill-tmp');
  stateDir = path.join(root, 'state');
  await fsp.mkdir(tmpRoot);
  await makeFullHome(home);
  // The password vault outside the data home, as on a real install.
  await write(stateDir, 'open-walnut/vault/vault.json', '{}');
  store = new LocalStore(destDir);
});

afterEach(async () => {
  await chmodTree(root, true).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

/** Plenty of room: these tests must not depend on how full the machine running them is. */
const roomy = async (): Promise<number> => 1024 ** 4;
const drill = (cfg: BackupConfig, over: Partial<Parameters<typeof runRestoreDrill>[0]> = {}) =>
  runRestoreDrill({ cfg, dataDir: home, store, tmpRoot, mustHaveSlackMs: 0, outsideRoots: { 'xdg-state': stateDir }, freeBytes: roomy, ...over });

const check = (r: DrillResult, id: string) => r.checks.find((c) => c.id === id)!;

async function rawKeyOf(cfg: BackupConfig): Promise<Buffer | null> {
  return cfg.encrypt ? parseRecoveryKey((await readRecoveryKey(home))!) : null;
}

async function drillFolders(): Promise<string[]> {
  return (await fsp.readdir(tmpRoot)).filter((n) => n.startsWith(DRILL_DIR_PREFIX));
}

describe.each([
  ['unencrypted', plainCfg],
  ['encrypted', encCfg],
])('a good backup (%s) passes', (_kind, cfg) => {
  it('every check passes, a task and a note read back, and what backups leave out is listed', async () => {
    await runEncryptedBackup(cfg, { dataDir: home, store });
    const r = await drill(cfg);
    expect(r.error).toBeUndefined();
    expect(r.ok, JSON.stringify(r.checks, null, 2)).toBe(true);
    expect(r.snapshot).toMatchObject({ encrypted: cfg.encrypt === true });
    for (const id of ['restore', 'files', 'databases', 'must-have', 'read-back']) expect(check(r, id).ok, id).toBe(true);
    // No isolated boot mode exists: said, not faked.
    expect(check(r, 'boot')).toMatchObject({ ok: null });
    expect(check(r, 'boot').detail).toMatch(/plugins.*session daemon/);
    expect(check(r, 'read-back').detail).toContain('Plan the garden');
    expect(check(r, 'read-back').detail).toContain('artifacts/notes/journal/2026-11-20.md');
    expect(check(r, 'files').detail).toMatch(/hashed back/);
    expect(Number(/(\d+) hashed back/.exec(check(r, 'files').detail)![1])).toBe(r.snapshot!.fileCount);
    expect(check(r, 'databases').detail).toMatch(/no row counts/);
    expect(r.databases.map((d) => d.path)).toEqual(['org/threads.sqlite', 'sessions.sqlite', 'tasks/tasks.sqlite']);
    expect(r.databases.find((d) => d.path === 'tasks/tasks.sqlite')).toMatchObject({ ok: true, tables: 1, rows: 2 });
    // The must-have list really looked: the user's own notes folder and the stores were required.
    expect(check(r, 'must-have').detail).toMatch(/^(\d+) leader-data files/);
    expect(Number(/^(\d+)/.exec(check(r, 'must-have').detail)![1])).toBeGreaterThanOrEqual(10);

    const ids = r.notInBackups.map((e) => e.id);
    for (const id of ['cache.applied-ops', 'browser-replays', 'health', 'places', 'tmp.stt-recordings', 'state.vault', 'state.secrets-master']) {
      expect(ids, id).toContain(id);
    }
    expect(r.notInBackups.find((e) => e.id === 'state.vault')).toMatchObject({ present: true, why: expect.stringMatching(/outside the data home/) });
    expect(r.notInBackups.find((e) => e.id === 'health')).toMatchObject({ present: true, class: 'machine' });
    // What a backup does hold is never listed as left out.
    for (const id of ['tasks.db', 'secrets', 'config-yaml', 'memory', 'local.backup']) expect(ids, id).not.toContain(id);
    expect(await drillFolders()).toEqual([]);
  }, 60_000);
});

describe('a damaged backup fails the drill and names the cause', () => {
  it('a corrupted chunk: the pack it sits in is named damaged', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const packs = (await repoStore(store, false).list('packs/')).sort((a, b) => b.size - a.size);
    const file = path.join(destDir, 'plain', packs[0].key);
    const body = await fsp.readFile(file);
    body[10] ^= 0xff;
    await fsp.writeFile(file, body);
    const r = await drill(plainCfg);
    expect(r.ok).toBe(false);
    expect(check(r, 'restore')).toMatchObject({ ok: false });
    expect(check(r, 'restore').problems![0]).toMatch(/damaged/);
    expect(await drillFolders()).toEqual([]);
  }, 60_000);

  it('a torn database: restored as listed, but integrity_check names it', async () => {
    await runEncryptedBackup(encCfg, { dataDir: home, store });
    const db = await fsp.readFile(path.join(home, 'tasks', 'tasks.sqlite'));
    const torn = Buffer.concat([db.subarray(0, 4096), Buffer.alloc(4096, 0x5a)]);
    await writeAlteredSnapshot(store, await rawKeyOf(encCfg), { replace: { '.sqlite-snapshots/tasks/tasks.sqlite': torn } });
    const r = await drill(encCfg);
    expect(r.ok).toBe(false);
    expect(check(r, 'restore').ok).toBe(true);
    expect(check(r, 'files').ok).toBe(true);
    expect(check(r, 'databases')).toMatchObject({ ok: false });
    expect(check(r, 'databases').problems!.join('\n')).toContain('tasks/tasks.sqlite');
    expect(r.databases.find((d) => d.path === 'tasks/tasks.sqlite')!.ok).toBe(false);
    expect(await drillFolders()).toEqual([]);
  }, 60_000);

  it('a file the backup lists but its repository lacks: restore names that file', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const repo = repoStore(store, false);
    const index = await repo.list('index/');
    // The data pack goes; the tree packs stay so the list still reads.
    const dataPacks = (await repo.list('packs/')).sort((a, b) => b.size - a.size);
    await fsp.rm(path.join(destDir, 'plain', dataPacks[0].key));
    expect(index.length).toBeGreaterThan(0);
    const r = await drill(plainCfg);
    expect(r.ok).toBe(false);
    expect(check(r, 'restore').problems![0]).toMatch(/Backup is incomplete: a part of .+ is missing/);
  }, 60_000);

  it('a backup missing a must-have entry: the entry and its files are named', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    await writeAlteredSnapshot(repoStore(store, false), null, { drop: (p) => p.startsWith('memory/') || p.startsWith('Recipes/') });
    const r = await drill(plainCfg);
    expect(r.ok).toBe(false);
    // The backup restores as it says: only the independent list sees the gap.
    expect(check(r, 'restore').ok).toBe(true);
    expect(check(r, 'files').ok).toBe(true);
    const mustHave = check(r, 'must-have');
    expect(mustHave.ok).toBe(false);
    expect(mustHave.problems!.join('\n')).toContain('memory: 1 file(s)');
    expect(mustHave.problems!.join('\n')).toContain('memory/MEMORY.md');
    expect(mustHave.problems!.join('\n')).toContain('unlisted:Recipes');
  }, 60_000);

  it('a file born after the backup is not required in it (the default slack)', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    await write(home, 'memory/new-today.md', 'written after the backup');
    const r = await drill(plainCfg, { mustHaveSlackMs: undefined });
    expect(check(r, 'must-have').ok).toBe(true);
  }, 60_000);

  it('no backups yet, no key: the drill says why it could not run', async () => {
    const none = await drill(plainCfg);
    expect(none).toMatchObject({ ok: false, error: expect.stringMatching(/No Walnut backups|No backups/) });
    await runEncryptedBackup(encCfg, { dataDir: home, store });
    await fsp.rm(path.join(home, 'local', 'backup', 'recovery-key'));
    const noKey = await drill(encCfg);
    expect(noKey).toMatchObject({ ok: false, error: expect.stringMatching(/no recovery key/) });
    expect(noKey.notInBackups.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('no false failure where the backup is fine', () => {
  it('an old note moved to another folder after the backup is not called missing', async () => {
    await write(home, 'artifacts/notes/old/moveme.md', 'an old note\n');
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    await new Promise((r) => setTimeout(r, 30));
    await fsp.mkdir(path.join(home, 'artifacts/notes/new'), { recursive: true });
    await fsp.rename(path.join(home, 'artifacts/notes/old/moveme.md'), path.join(home, 'artifacts/notes/new/moved.md'));
    const r = await drill(plainCfg);
    expect(check(r, 'must-have').ok, JSON.stringify(check(r, 'must-have'))).toBe(true);
    expect(check(r, 'must-have').detail).toMatch(/1 were moved or changed since it/);
  }, 60_000);

  it('backups another computer writes: must-have is not compared with this home', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    await write(home, 'local/backup/machine-id', 'e'.repeat(32));
    await write(home, 'memory/only-here.md', 'never in those backups');
    const r = await drill(plainCfg);
    expect(r.ok).toBe(true);
    expect(check(r, 'must-have')).toMatchObject({ ok: null, detail: expect.stringMatching(/another computer/) });
  }, 60_000);

  it('a task read that fails is a read-back problem, not a broken database', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const other = path.join(root, 'odd-tasks.sqlite');
    makeDb(other, ['CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)', "INSERT INTO tasks VALUES ('t-9', 'no updated_at here')"]);
    await writeAlteredSnapshot(repoStore(store, false), null, { replace: { '.sqlite-snapshots/tasks/tasks.sqlite': await fsp.readFile(other) } });
    const r = await drill(plainCfg);
    expect(check(r, 'databases').ok).toBe(true);
    expect(check(r, 'read-back')).toMatchObject({ ok: false });
    expect(check(r, 'read-back').problems![0]).toMatch(/reading a task failed/);
  }, 60_000);
});

describe('the files check sees what landed on disk', () => {
  it('one byte changed in a restored large file fails it, naming the file', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const plain = repoStore(store, false);
    const repo = await Repository.open(plain, null);
    const snap = (await repo.listSnapshots()).snapshots[0];
    const tree = await repo.readTree(snap, (await loadLiveIndex(repo)).index, new PackCache(plain));
    const target = path.join(root, 'restored');
    await restoreRepoSnapshot(plain, null, target, { snapshotId: snap.id });
    expect((await checkRestoredFiles(target, tree, repo, snap)).ok).toBe(true);
    const wav = path.join(target, 'voice-archive', 'talk.wav');
    const body = await fsp.readFile(wav);
    body[2 * 1024 * 1024] ^= 0x01;
    await fsp.writeFile(wav, body);
    await fsp.writeFile(path.join(target, 'stray.txt'), 'x');
    const bad = await checkRestoredFiles(target, tree, repo, snap);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual(expect.arrayContaining([
      'voice-archive/talk.wav: its content does not hash to what the backup recorded',
      'stray.txt: restored but not in the backup\'s list',
    ]));
  }, 60_000);
});

describe('the drill the CLI and the schedule run holds the backup lock', () => {
  it('waits for no one: refused while another live process holds the lock, and the lock is gone after', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    await fsp.writeFile(runLockPath(home), `${process.ppid} someone\n`);
    await expect(runRestoreDrillLocked({ cfg: plainCfg, dataDir: home, store, tmpRoot, freeBytes: roomy })).rejects.toThrow(/backing up or restoring/);
    await fsp.rm(runLockPath(home));
    const r = await runRestoreDrillLocked({ cfg: plainCfg, dataDir: home, store, tmpRoot, mustHaveSlackMs: 0, outsideRoots: {}, freeBytes: roomy });
    expect(r.ok).toBe(true);
    await expect(fsp.stat(runLockPath(home))).rejects.toThrow();
  }, 60_000);
});

describe('read-only on the data home and the destination', () => {
  it('passes with both read-only, and neither changed', async () => {
    await runEncryptedBackup(encCfg, { dataDir: home, store });
    const before = { home: await listing(home), dest: await listing(destDir) };
    await chmodTree(home, false);
    await chmodTree(destDir, false);
    const r = await drill(encCfg);
    expect(r.ok, JSON.stringify(r.checks, null, 2)).toBe(true);
    await chmodTree(home, true);
    await chmodTree(destDir, true);
    expect(await listing(home)).toEqual(before.home);
    expect(await listing(destDir)).toEqual(before.dest);
  }, 60_000);

  it('the store it reads through refuses every write', async () => {
    const ro = readOnlyStore(store);
    await expect(ro.put('x', Buffer.from('y'))).rejects.toThrow(/never writes/);
    await expect(ro.delete('x')).rejects.toThrow(/never writes/);
    await expect(fsp.stat(destDir)).rejects.toThrow();
  });

  it('refuses a temporary folder inside the data home', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const r = await drill(plainCfg, { tmpRoot: path.join(home, 'tmp') });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/inside the data home/) });
    expect(await fsp.readdir(path.join(home, 'tmp'))).toEqual(['stt-recordings']);
  }, 60_000);
});

describe('the drill is never what fills the disk', () => {
  it('refuses before it fetches a byte or makes a folder when the backup would not fit with room to spare', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const reads: string[] = [];
    const counting: BackupStore = {
      kind: store.kind, describe: () => store.describe(), list: (p) => store.list(p),
      put: (k, b) => store.put(k, b), delete: (k) => store.delete(k),
      get: (k) => { reads.push(k); return store.get(k); },
    };
    const ok = await drill(plainCfg, { store: counting });
    expect(ok.ok).toBe(true);
    const total = ok.snapshot!.totalBytes;
    const fullReads = reads.length;
    const fullKeys = new Set(reads);
    reads.length = 0;

    // One byte short of the backup's size plus the reserve.
    const short = await drill(plainCfg, { store: counting, freeBytes: async () => total + DRILL_FREE_RESERVE_BYTES - 1 });
    expect(short).toMatchObject({ ok: false, error: expect.stringMatching(/Not enough free disk space/) });
    expect(short.checks).toEqual([]);
    expect(await drillFolders()).toEqual([]);
    // Only the snapshot list and the snapshot were read: far fewer reads than a restore, and no pack.
    expect(reads.length).toBeLessThan(fullReads);
    // What a restore reads and the refused drill did not: the packs that hold the files.
    expect(reads.every((k) => fullKeys.has(k))).toBe(true);
    expect([...fullKeys].filter((k) => !reads.includes(k)).length).toBeGreaterThan(0);

    // Exactly enough: it runs.
    expect((await drill(plainCfg, { freeBytes: async () => total + DRILL_FREE_RESERVE_BYTES })).ok).toBe(true);
    // A file system that does not say how much is free is refused too.
    expect(await drill(plainCfg, { freeBytes: async () => null })).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) });
    expect(await drillFolders()).toEqual([]);
  }, 120_000);

  it('reads the real free space when nothing is injected', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const r = await drill(plainCfg, { freeBytes: undefined });
    // Either it ran, or it refused for room: never an error of another kind, never a leftover folder.
    if (!r.ok) expect(r.error).toMatch(/Not enough free disk space/);
    expect(await drillFolders()).toEqual([]);
  }, 120_000);
});

describe('the temporary folder never stays', () => {
  it('a drill that was killed leaves its folder; the next drill removes it', async () => {
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const ready = path.join(root, 'ready');
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'restore-drill-child.ts'), home, destDir, tmpRoot, ready], {
      env: { ...process.env, OPEN_WALNUT_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    for (let i = 0; i < 300 && !(await fsp.stat(ready).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await fsp.stat(ready).then(() => true, () => false), stderr).toBe(true);
    child.kill('SIGKILL');
    await exited;
    const left = await drillFolders();
    expect(left).toHaveLength(1);

    const r = await drill(plainCfg);
    expect(r.ok).toBe(true);
    expect(r.removedLeftovers).toBe(1);
    expect(await drillFolders()).toEqual([]);
  }, 60_000);

  it('leaves alone a folder whose drill still runs, and anything not named like a drill folder', async () => {
    const live = path.join(tmpRoot, `${DRILL_DIR_PREFIX}abc123`);
    await fsp.mkdir(live);
    await fsp.writeFile(path.join(live, 'drill-owner.json'), JSON.stringify({ pid: process.ppid }));
    await fsp.mkdir(path.join(tmpRoot, `${DRILL_DIR_PREFIX}not-ours-at-all`));
    await fsp.mkdir(path.join(tmpRoot, 'something-else'));
    expect(await removeLeftoverDrills(tmpRoot)).toBe(0);
    expect((await fsp.readdir(tmpRoot)).sort()).toEqual([`${DRILL_DIR_PREFIX}abc123`, `${DRILL_DIR_PREFIX}not-ours-at-all`, 'something-else'].sort());
    // A day old, it goes whatever its owner file says (a pid the system reused).
    expect(await removeLeftoverDrills(tmpRoot, Date.now() + 25 * 3_600_000)).toBe(1);
  });
});

describe('the record Settings will read', () => {
  it('round trips at local/restore-drill.json', async () => {
    expect(await readDrillRecord(home)).toBeNull();
    await runEncryptedBackup(plainCfg, { dataDir: home, store });
    const r = await drill(plainCfg);
    await writeDrillRecord(home, r);
    expect(await readDrillRecord(home)).toEqual(r);
    expect(await fsp.stat(path.join(home, 'local', 'restore-drill.json')).then((s) => s.isFile())).toBe(true);
  }, 60_000);
});
