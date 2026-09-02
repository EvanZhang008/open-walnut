/**
 * Data-dir scanner + manifest diff — the pure-logic half of S3 backup.
 * No S3 client here, so the quick test tier can cover it fully.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupDiff, BackupManifest, ManifestEntry } from './types.js';

/**
 * What a backup deliberately leaves behind. Everything here is rebuildable
 * (caches, search indexes) or wrong to ship (git-sync's own repo history,
 * locks, live-written WAL side files — the canonical DBs ride as snapshots
 * instead, see sqlite-snapshot.ts).
 *
 * NOT reusing git-sync's .gitignore: that list also excludes things a backup
 * MUST include (auth.json, canonical sqlite DBs).
 */
export const EXCLUDED_DIRS = new Set([
  'tmp',
  'cache',
  'stt-debug',
  '.smart-env',
  '.git',
  'browser',
]);

const EXCLUDED_FILE_RE = [
  /-search\.sqlite/, // rebuildable search indexes (incl. -shm/-wal side files)
  /-index\.sqlite/,
  /\.sqlite-shm$/, // WAL side files of canonical DBs — snapshots replace them
  /\.sqlite-wal$/,
  /\.sqlite$/, // canonical DBs upload as safe snapshots, never raw (see below)
  /\.lock$/,
  /\.DS_Store$/,
];

/** Key prefix the sqlite snapshots ride under inside the backup. */
export const SQLITE_SNAPSHOT_PREFIX = '.sqlite-snapshots';

/**
 * Rebuildable index DBs: never worth backing up, because a reindex from the
 * canonical stores reproduces them. `search.sqlite` (the hybrid index) has no
 * prefix, so it needs its own alternative — matching only `-search` used to
 * quietly ship a multi-hundred-MB derived index in every backup.
 */
const REBUILDABLE_SQLITE_RE = /(^|\/)(search|.*-search|.*-index)\.sqlite$/;

/**
 * Canonical sqlite DBs — live-written, so raw copies can be torn mid-write.
 * Excluded from the raw scan; they re-enter the upload set as `db.backup()`
 * snapshots under SQLITE_SNAPSHOT_PREFIX (sqlite-snapshot.ts). Discovered
 * dynamically (any *.sqlite that isn't a rebuildable search/index DB) so
 * legacy/renamed DBs are never silently dropped from backups.
 */
export async function findCanonicalSqlite(root: string): Promise<string[]> {
  const found: string[] = [];
  await walkSqlite(root, '', found);
  return found.sort();
}

async function walkSqlite(root: string, rel: string, out: string[]): Promise<void> {
  const abs = rel ? path.join(root, rel) : root;
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const first = childRel.split('/')[0];
    if (EXCLUDED_DIRS.has(first)) continue;
    if (entry.isDirectory()) {
      await walkSqlite(root, childRel, out);
    } else if (
      entry.isFile() &&
      childRel.endsWith('.sqlite') &&
      !REBUILDABLE_SQLITE_RE.test(childRel)
    ) {
      out.push(childRel);
    }
  }
}

export function isExcluded(relPath: string): boolean {
  const first = relPath.split('/')[0];
  if (EXCLUDED_DIRS.has(first)) return true;
  return EXCLUDED_FILE_RE.some((re) => re.test(relPath));
}

/**
 * Walk the data dir and produce manifest entries for every included file.
 * Fully async (fs/promises) — never blocks the event loop.
 */
export async function scanDataDir(root: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  await walk(root, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walk(root: string, rel: string, out: ManifestEntry[]): Promise<void> {
  const abs = rel ? path.join(root, rel) : root;
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return; // dir vanished mid-scan — fine, next run picks it up
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (isExcluded(childRel)) continue;
    if (entry.isDirectory()) {
      await walk(root, childRel, out);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(path.join(root, childRel));
        out.push({ path: childRel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      } catch {
        /* vanished between readdir and stat — skip */
      }
    }
    // symlinks skipped deliberately: nothing canonical in the data dir is a
    // symlink, and following one could escape the data dir entirely.
  }
}

/**
 * Diff a fresh scan against the previous manifest. `size + mtimeMs` is the
 * change detector — same contract `aws s3 sync` uses, cheap and good enough
 * for hourly cadence (a content-hash pass over 5GB every hour is not).
 */
export function diffAgainstManifest(
  scan: ManifestEntry[],
  previous: BackupManifest | null,
): BackupDiff {
  if (!previous) {
    return { upload: [...scan], remove: [], unchanged: [] };
  }
  const prevByPath = new Map(previous.files.map((f) => [f.path, f]));
  const upload: ManifestEntry[] = [];
  const unchanged: ManifestEntry[] = [];
  for (const entry of scan) {
    const prev = prevByPath.get(entry.path);
    if (prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs) {
      unchanged.push(entry);
    } else {
      upload.push(entry);
    }
    prevByPath.delete(entry.path);
  }
  return { upload, remove: [...prevByPath.keys()], unchanged };
}
