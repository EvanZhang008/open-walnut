/**
 * Fixtures for the restore drill tests: a data home shaped like a real one (its stores,
 * notes, secrets and the folders backups skip), and a way to write a backup that went
 * wrong (a file left out, a database torn) with the repository's own writers.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from '../../../src/lib/sqlite.js';
import { PackCache, PackWriter, Repository, treeChunks } from '../../../src/core/backup/repo/repository.js';
import { loadLiveIndex } from '../../../src/core/backup/repo/backup-run.js';
import type { Snapshot, TreeEntry } from '../../../src/core/backup/repo/format.js';
import type { BackupStore } from '../../../src/core/backup/stores/types.js';

export async function write(home: string, rel: string, body: string | Buffer): Promise<void> {
  const p = path.join(home, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body);
}

function makeDb(file: string, sql: string[]): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    for (const s of sql) db.exec(s);
  } finally {
    db.close();
  }
}

/** A home with what a real one holds: stores, notes, settings, secrets, and the places backups skip. */
export async function makeFullHome(home: string): Promise<void> {
  await fsp.mkdir(path.join(home, 'tasks'), { recursive: true });
  await fsp.mkdir(path.join(home, 'org'), { recursive: true });
  await fsp.mkdir(path.join(home, 'cache'), { recursive: true });
  makeDb(path.join(home, 'tasks', 'tasks.sqlite'), [
    'CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT)',
    "INSERT INTO tasks VALUES ('t-1', 'Older task', '2026-11-01T00:00:00Z')",
    "INSERT INTO tasks VALUES ('t-2', 'Plan the garden 花园', '2026-11-20T00:00:00Z')",
  ]);
  makeDb(path.join(home, 'sessions.sqlite'), ['CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT)', "INSERT INTO sessions VALUES ('s-1', 'hello')"]);
  makeDb(path.join(home, 'org', 'threads.sqlite'), ['CREATE TABLE threads (id TEXT PRIMARY KEY)', "INSERT INTO threads VALUES ('th-1')"]);
  makeDb(path.join(home, 'cache', 'applied-ops.sqlite'), ['CREATE TABLE ops (id TEXT PRIMARY KEY)']);
  // Rebuildable: never in a backup, never asked for.
  makeDb(path.join(home, 'search.sqlite'), ['CREATE TABLE idx (t TEXT)']);
  await write(home, 'memory/MEMORY.md', '# Memory\n\nThe user likes tea.\n');
  await write(home, 'artifacts/notes/journal/2026-11-20.md', '# 20 Nov\n\nRan 5 km. 今天很好。\n'.repeat(50));
  await write(home, 'config.yaml', 'backup:\n  enabled: true\n');
  await write(home, 'auth.json', JSON.stringify({ instance: 'x' }));
  await write(home, 'secrets/plugins/mail.json', JSON.stringify({ password: 'fixture-only' }));
  await write(home, 'cron-jobs.json', '[]');
  // A folder of the user's own notes beside Walnut's (an unknown top-level name: leader-data).
  await write(home, 'Recipes/bread.md', 'flour, water, salt\n');
  // What backups leave out by design.
  await write(home, 'browser/t-1/replay.json', '{}');
  await write(home, 'health/steps.json', '[]');
  await write(home, 'places/visits.json', '[]');
  await write(home, 'tmp/stt-recordings/a.txt', 'voice');
  await write(home, 'cache/history/x.json', '{}');
  await write(home, 'local/backup/machine-id', 'f'.repeat(32));
}

/**
 * Write a new newest snapshot made from the newest one, changed by `edit`: entries may
 * be dropped, and `replace` gives a path new content (uploaded as a new blob).
 */
export async function writeAlteredSnapshot(
  store: BackupStore,
  rawKey: Buffer | null,
  edit: { drop?: (p: string) => boolean; replace?: Record<string, Buffer> },
): Promise<Snapshot> {
  const repo = await Repository.open(store, rawKey);
  const { snapshots } = await repo.listSnapshots();
  const prev = snapshots[0];
  const { index } = await loadLiveIndex(repo);
  let tree: TreeEntry[] = await repo.readTree(prev, index, new PackCache(store));
  if (edit.drop) tree = tree.filter((e) => !edit.drop!(e.p));
  const data = new PackWriter(repo, 'data');
  for (const [p, body] of Object.entries(edit.replace ?? {})) {
    const id = repo.blobId(body);
    await data.add(id, await repo.sealBlob(id, body, true), body.length);
    tree = tree.map((e) => (e.p === p ? { ...e, s: body.length, b: [id] } : e));
  }
  const dataPacks = await data.finish();
  const treeWriter = new PackWriter(repo, 'tree');
  const treeIds: string[] = [];
  for (const chunk of treeChunks(tree)) {
    const id = repo.blobId(chunk);
    treeIds.push(id);
    await treeWriter.add(id, await repo.sealBlob(id, chunk, true), chunk.length);
  }
  const treePacks = await treeWriter.finish();
  await repo.writeIndex([...dataPacks, ...treePacks]);
  const createdAt = new Date(Date.parse(prev.createdAt) + 1000);
  const snap: Snapshot = {
    ...prev, id: repo.newSnapshotId(createdAt), createdAt: createdAt.toISOString(),
    fileCount: tree.length, totalBytes: tree.reduce((n, e) => n + e.s, 0), tree: treeIds,
  };
  await repo.writeSnapshot(snap);
  return snap;
}

/** Every file under `dir` with its size and mtime: two listings equal means nothing was written. */
export async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); await walk(r); }
      else {
        const st = await fsp.stat(path.join(dir, r));
        out.push(`${r} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  await walk('');
  return out.sort();
}

export async function chmodTree(dir: string, writable: boolean): Promise<void> {
  const walk = async (p: string): Promise<void> => {
    const st = await fsp.lstat(p);
    if (st.isDirectory()) {
      if (writable) await fsp.chmod(p, 0o700);
      for (const name of await fsp.readdir(p)) await walk(path.join(p, name));
      if (!writable) await fsp.chmod(p, 0o500);
    } else if (st.isFile()) {
      await fsp.chmod(p, writable ? 0o600 : 0o400);
    }
  };
  await walk(dir);
}
