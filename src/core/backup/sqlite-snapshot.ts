/**
 * Safe sqlite snapshots for backup.
 *
 * Canonical DBs are live-written by the running server; a raw file copy can
 * photograph a torn page mid-transaction. better-sqlite3's `db.backup()` uses
 * SQLite's online backup API, which yields a consistent copy while writers
 * keep going. Snapshots land in a staging dir and ride the upload set under
 * SQLITE_SNAPSHOT_PREFIX; restore puts them back at their original paths.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../../logging/index.js';
import { findCanonicalSqlite, SQLITE_SNAPSHOT_PREFIX } from './scan.js';
import type { ManifestEntry } from './types.js';

export interface SqliteSnapshotResult {
  entries: ManifestEntry[];
  /** Data-dir-relative paths of DBs whose snapshot FAILED this run. The
   *  caller must exempt these from the manifest's remove-diff — otherwise a
   *  transient snapshot failure reads as "deleted locally" and the previous
   *  backup's copy gets deleted from the bucket. */
  failed: string[];
}

/**
 * Snapshot every canonical DB under `root` into `stagingDir`, preserving the
 * relative layout (tasks/tasks.sqlite → <staging>/tasks/tasks.sqlite).
 * Returns manifest entries keyed under SQLITE_SNAPSHOT_PREFIX.
 *
 * A DB that fails to snapshot is skipped with a warning rather than failing
 * the whole backup — 90% of a backup beats 0% — but is reported in `failed`
 * so the previous backup of that DB is preserved, not deleted.
 */
export async function snapshotSqliteDbs(
  root: string,
  stagingDir: string,
): Promise<SqliteSnapshotResult> {
  const dbs = await findCanonicalSqlite(root);
  const entries: ManifestEntry[] = [];
  const failed: string[] = [];
  for (const rel of dbs) {
    const src = path.join(root, rel);
    const dest = path.join(stagingDir, rel);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // Open read-only; backup() is async and paced (non-blocking).
      const db = new Database(src, { readonly: true, fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
      const st = await fs.stat(dest);
      entries.push({
        path: `${SQLITE_SNAPSHOT_PREFIX}/${rel}`,
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
      });
    } catch (err) {
      failed.push(rel);
      log.session.warn('backup: sqlite snapshot failed — skipping this DB', {
        db: rel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { entries, failed };
}
