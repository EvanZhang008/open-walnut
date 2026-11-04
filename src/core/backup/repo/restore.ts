/**
 * Restore one encrypted snapshot into a FRESH directory.
 *
 * Never over a live data home: a non-empty target is refused unless `force`.
 * Every chunk is checked twice on the way back (the AES-GCM tag, then its
 * keyed id), every file's size against the snapshot, and each file gets its
 * mtime back, so a backup made from the restored home reads almost nothing
 * again. Files are restored in pack order, so each pack downloads about once.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupStore } from '../stores/types.js';
import { SQLITE_SNAPSHOT_PREFIX } from '../scan.js';
import { snapshotKey, type Snapshot, type TreeEntry } from './format.js';
import { PackCache, RepoError, Repository } from './repository.js';
import { loadLiveIndex } from './backup-run.js';

export interface RepoRestoreOptions {
  /** Snapshot id, or 'latest'. */
  snapshotId: string;
  force?: boolean;
  onProgress?: (doneBytes: number, totalBytes: number, doneFiles: number, totalFiles: number) => void;
}

export interface RepoRestoreResult {
  snapshot: Snapshot;
  restoredFiles: number;
  restoredBytes: number;
  targetDir: string;
  downloadedBytes: number;
}

/** Where a tree path lands: sqlite snapshots go back to their real paths. */
export function restorePathOf(rel: string): string {
  return rel.startsWith(`${SQLITE_SNAPSHOT_PREFIX}/`) ? rel.slice(SQLITE_SNAPSHOT_PREFIX.length + 1) : rel;
}

export async function restoreRepoSnapshot(
  store: BackupStore,
  rawKey: Buffer,
  targetDir: string,
  opts: RepoRestoreOptions,
): Promise<RepoRestoreResult> {
  const target = path.resolve(targetDir);
  const existing = await fs.readdir(target).catch(() => null);
  if (existing && existing.length > 0 && !opts.force) {
    throw new Error(`${target} is not empty. Restore goes into a new, empty folder.`);
  }
  const repo = await Repository.open(store, rawKey);
  let snap: Snapshot;
  if (opts.snapshotId === 'latest') {
    const { snapshots } = await repo.listSnapshots();
    if (snapshots.length === 0) throw new RepoError('no_repo', `No backups at ${store.describe()}.`);
    snap = snapshots[0];
  } else {
    snap = await repo.readSnapshot(snapshotKey(opts.snapshotId));
  }
  const { index } = await loadLiveIndex(repo);
  const cache = new PackCache(store, 4);
  const tree = await repo.readTree(snap, index, cache);

  // The snapshot is store-provided data: no entry may write outside the target.
  for (const e of tree) {
    const dest = path.resolve(target, restorePathOf(e.p));
    if (!dest.startsWith(target + path.sep)) {
      throw new Error(`Backup entry escapes the restore folder, refusing: ${e.p}`);
    }
    for (const id of e.b) {
      if (!index.blobs.has(id)) throw new RepoError('missing_blob', `Backup is incomplete: a part of ${e.p} is missing from ${store.describe()}.`);
    }
  }
  const firstLocation = (e: TreeEntry): string => {
    const ref = e.b.length ? index.blobs.get(e.b[0]) : undefined;
    return ref ? `${ref.pack}:${String(ref.offset).padStart(12, '0')}` : '';
  };
  const ordered = [...tree].sort((a, b) => firstLocation(a).localeCompare(firstLocation(b)));

  await fs.mkdir(target, { recursive: true });
  const totalBytes = tree.reduce((n, e) => n + e.s, 0);
  let doneBytes = 0;
  let doneFiles = 0;
  for (const e of ordered) {
    const dest = path.resolve(target, restorePathOf(e.p));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const fh = await fs.open(dest, 'w', e.x ? 0o700 : 0o600);
    let written = 0;
    try {
      for (const id of e.b) {
        const chunk = await repo.readBlob(id, index, cache);
        // write() may take less than asked: loop until the chunk is all down.
        for (let off = 0; off < chunk.length;) {
          const { bytesWritten } = await fh.write(chunk, off, chunk.length - off, written + off);
          if (bytesWritten <= 0) throw new Error(`Could not write ${dest}.`);
          off += bytesWritten;
        }
        written += chunk.length;
        opts.onProgress?.(doneBytes + Math.min(written, e.s), totalBytes, doneFiles, tree.length);
      }
    } finally {
      await fh.close();
    }
    if (written !== e.s) {
      throw new Error(`Restore check failed for ${e.p}: expected ${e.s} bytes, got ${written}.`);
    }
    const mtime = new Date(e.m);
    await fs.utimes(dest, mtime, mtime).catch(() => {});
    doneBytes += e.s;
    doneFiles++;
    opts.onProgress?.(doneBytes, totalBytes, doneFiles, tree.length);
  }
  return { snapshot: snap, restoredFiles: doneFiles, restoredBytes: doneBytes, targetDir: target, downloadedBytes: cache.downloadedBytes };
}
