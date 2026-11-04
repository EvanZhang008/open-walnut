/**
 * One encrypted backup run into the repository (format.ts).
 *
 * Same scan as the S3 mirror (scan.ts: caches, indexes, health and places
 * stay home; sqlite DBs ride as consistent snapshots). A file whose size and
 * mtime match the previous snapshot reuses that snapshot's blobs without being
 * read; anything else is read, chunked and only its NEW chunks are uploaded.
 * Order: packs, then the index naming them, then the snapshot. The snapshot
 * is the commit point: a run that dies before it leaves packs no snapshot
 * names, which prune removes later.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { log } from '../../../logging/index.js';
import { getVersion } from '../../version.js';
import { scanDataDir, SQLITE_SNAPSHOT_PREFIX } from '../scan.js';
import { snapshotSqliteDbs } from '../sqlite-snapshot.js';
import type { ManifestEntry } from '../types.js';
import type { BackupStore } from '../stores/types.js';
import type { WriterIdentity } from '../local-state.js';
import { chunkStream, SMALL_FILE_BYTES } from './chunker.js';
import { packIdFromKey, type Snapshot, type TreeEntry } from './format.js';
import { PackCache, PackWriter, RepoError, Repository, shouldCompress, treeChunks, type LoadedIndex } from './repository.js';

export interface RepoBackupOptions {
  dataDir: string;
  writer: WriterIdentity;
  /** Bytes read so far of the bytes this run has to read (unchanged files count as read). */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

export interface RepoBackupResult {
  snapshotId: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  /** Files read this run (new or changed). */
  changedFiles: number;
  /** Bytes of packs uploaded this run (encrypted, compressed). */
  uploadedBytes: number;
  newBlobs: number;
  /** Files that could not be read; the previous copy stays in the snapshot where there is one. */
  skipped: string[];
  durationMs: number;
}

/** The index with packs that are really in the store (a deleted pack must not be deduped against). */
export async function loadLiveIndex(repo: Repository): Promise<{ index: LoadedIndex; storedPacks: Map<string, number | undefined> }> {
  const storedPacks = new Map<string, number | undefined>();
  for (const obj of await repo.store.list('packs/')) storedPacks.set(packIdFromKey(obj.key), obj.modifiedAt);
  return { index: await repo.loadIndex(storedPacks), storedPacks };
}

export async function runRepoBackup(
  store: BackupStore,
  rawKey: Buffer,
  opts: RepoBackupOptions,
): Promise<RepoBackupResult> {
  const start = Date.now();
  const repo = await Repository.open(store, rawKey, { create: true, writer: opts.writer });
  if (!repo.isWriter(opts.writer)) {
    throw new RepoError(
      'other_writer',
      `Backups at ${store.describe()} are written by "${repo.writerName()}". ` +
        'Choose "Back up from this machine instead" to move them here, or use another folder.',
    );
  }

  const { index } = await loadLiveIndex(repo);
  const cache = new PackCache(store);

  // Previous snapshot: the change detector. Any machine's (after a restore and
  // an adopt, the restored files keep their mtimes, so little is read again).
  const { snapshots } = await repo.listSnapshots();
  const previous = snapshots[0];
  const prevByPath = new Map<string, TreeEntry>();
  if (previous) {
    try {
      for (const e of await repo.readTree(previous, index, cache)) prevByPath.set(e.p, e);
    } catch (err) {
      log.session.warn('backup: previous snapshot tree unreadable, reading every file', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stagingDir = path.join(opts.dataDir, 'tmp', 'backup-staging-repo');
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    const scanned = await scanDataDir(opts.dataDir);
    const sqlite = await snapshotSqliteDbs(opts.dataDir, stagingDir);
    const all: ManifestEntry[] = [...scanned, ...sqlite.entries].sort((a, b) => a.path.localeCompare(b.path));
    const failedSqlite = new Set(sqlite.failed.map((rel) => `${SQLITE_SNAPSHOT_PREFIX}/${rel}`));

    const known = new Set(index.blobs.keys());
    const isReusable = (e: TreeEntry | undefined): e is TreeEntry => !!e && e.b.every((id) => known.has(id));

    const totalBytes = all.reduce((n, f) => n + f.size, 0);
    let doneBytes = 0;
    let newBlobs = 0;
    let changedFiles = 0;
    const skipped: string[] = [];
    const entries: TreeEntry[] = [];
    const data = new PackWriter(repo, 'data');

    let sinceYield = 0;
    for (const file of all) {
      const prev = prevByPath.get(file.path);
      if (isReusable(prev) && prev.s === file.size && prev.m === file.mtimeMs) {
        entries.push(prev);
        doneBytes += file.size;
        opts.onProgress?.(doneBytes, totalBytes);
        // Tens of thousands of unchanged files with no await between them would hold the event loop.
        if (++sinceYield >= 500) {
          sinceYield = 0;
          await new Promise((r) => setImmediate(r));
        }
        continue;
      }
      const isSnapshot = file.path.startsWith(`${SQLITE_SNAPSHOT_PREFIX}/`);
      const local = isSnapshot
        ? path.join(stagingDir, file.path.slice(SQLITE_SNAPSHOT_PREFIX.length + 1))
        : path.join(opts.dataDir, file.path);
      const compress = shouldCompress(file.path);
      try {
        const st = await fs.stat(local);
        const blobs: string[] = [];
        let size = 0;
        const take = async (chunk: Buffer): Promise<void> => {
          size += chunk.length;
          // A large file moves the count as it goes, not only when it ends.
          opts.onProgress?.(doneBytes + Math.min(size, file.size), totalBytes);
          const id = repo.blobId(chunk);
          blobs.push(id);
          if (!known.has(id)) {
            known.add(id);
            newBlobs++;
            await data.add(id, await repo.sealBlob(id, chunk, compress), chunk.length);
          }
        };
        if (st.size <= SMALL_FILE_BYTES) {
          const buf = await fs.readFile(local);
          if (buf.length > 0) await take(buf);
        } else {
          for await (const chunk of chunkStream(createReadStream(local, { highWaterMark: 1024 * 1024 }))) await take(chunk);
        }
        entries.push({ p: file.path, s: size, m: Math.floor(st.mtimeMs), b: blobs, ...(st.mode & 0o111 ? { x: 1 as const } : {}) });
        changedFiles++;
      } catch (err) {
        // A file that vanished or could not be read keeps its previous copy.
        skipped.push(file.path);
        if (isReusable(prev)) entries.push(prev);
        log.session.warn('backup: file skipped', {
          file: file.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      doneBytes += file.size;
      opts.onProgress?.(doneBytes, totalBytes);
    }
    // A DB whose snapshot failed this run keeps the previous run's copy.
    for (const rel of failedSqlite) {
      const prev = prevByPath.get(rel);
      if (isReusable(prev) && !entries.some((e) => e.p === rel)) entries.push(prev);
    }
    entries.sort((a, b) => a.p.localeCompare(b.p));

    const dataPacks = await data.finish();
    const tree = new PackWriter(repo, 'tree');
    const treeIds: string[] = [];
    for (const chunk of treeChunks(entries)) {
      const id = repo.blobId(chunk);
      treeIds.push(id);
      if (!known.has(id)) {
        known.add(id);
        await tree.add(id, await repo.sealBlob(id, chunk, true), chunk.length);
      }
    }
    const treePacks = await tree.finish();
    const newPacks = [...dataPacks, ...treePacks];
    if (newPacks.length > 0) await repo.writeIndex(newPacks);

    // The writer may have moved to another machine while this ran: then this
    // run's snapshot must not land (its packs are left for prune).
    await repo.refreshConfig();
    if (!repo.isWriter(opts.writer)) {
      throw new RepoError('other_writer', `Backups at ${store.describe()} moved to "${repo.writerName()}" during this run.`);
    }

    const createdAt = new Date();
    const snap: Snapshot = {
      version: 1,
      id: repo.newSnapshotId(createdAt),
      createdAt: createdAt.toISOString(),
      hostname: opts.writer.name,
      walnutVersion: getVersion(),
      fileCount: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.s, 0),
      tree: treeIds,
    };
    await repo.writeSnapshot(snap);
    const uploadedBytes = newPacks.reduce((n, p) => n + p.size, 0);
    log.session.info('backup: encrypted snapshot written', {
      snapshot: snap.id, files: snap.fileCount, changedFiles, newBlobs, uploadedBytes, skipped: skipped.length,
    });
    return {
      snapshotId: snap.id,
      createdAt: snap.createdAt,
      fileCount: snap.fileCount,
      totalBytes: snap.totalBytes,
      changedFiles,
      uploadedBytes,
      newBlobs,
      skipped,
      durationMs: Date.now() - start,
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
