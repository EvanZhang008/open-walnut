/**
 * Restore from an S3 backup — CLI-only in v1 (`open-walnut backup restore`).
 *
 * Semantics: download into a FRESH directory, never over a live data dir.
 * Restore points = versions of backup-manifest.json (bucket versioning);
 * without versioning only the latest backup is restorable.
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { makeS3Client, MANIFEST_KEY } from './s3-backup.js';
import { SQLITE_SNAPSHOT_PREFIX } from './scan.js';
import type { BackupConfig, BackupManifest } from './types.js';

const keyPrefix = (cfg: BackupConfig): string => (cfg.prefix?.replace(/\/+$/, '') || 'walnut');

export interface RestorePoint {
  versionId?: string;
  createdAt: string;
  isLatest: boolean;
}

/** List restore points = manifest versions, newest first. */
export async function listRestorePoints(
  cfg: BackupConfig,
  client?: S3Client,
): Promise<RestorePoint[]> {
  const s3 = client ?? makeS3Client(cfg);
  const key = `${keyPrefix(cfg)}/${MANIFEST_KEY}`;
  const resp = await s3.send(
    new ListObjectVersionsCommand({ Bucket: cfg.bucket, Prefix: key }),
  );
  return (resp.Versions ?? [])
    .filter((v) => v.Key === key)
    .map((v) => ({
      versionId: v.VersionId,
      createdAt: v.LastModified?.toISOString() ?? 'unknown',
      isLatest: v.IsLatest ?? false,
    }));
}

export interface RestoreResult {
  manifest: BackupManifest;
  restoredFiles: number;
  targetDir: string;
}

/**
 * Download the backup described by the (optionally versioned) manifest into
 * `targetDir`. Refuses a non-empty target unless `force` — restoring on top
 * of live data is exactly the mistake this guard exists for.
 */
export async function restoreFromBackup(
  cfg: BackupConfig,
  targetDir: string,
  options: { versionId?: string; force?: boolean; client?: S3Client; onFile?: (rel: string, i: number, total: number) => void } = {},
): Promise<RestoreResult> {
  const s3 = options.client ?? makeS3Client(cfg);

  const existing = await fs.readdir(targetDir).catch(() => null);
  if (existing && existing.length > 0 && !options.force) {
    throw new Error(`Target directory ${targetDir} is not empty — pass --force to restore into it anyway.`);
  }
  await fs.mkdir(targetDir, { recursive: true });

  // Manifest (specific version = specific restore point).
  const manifestResp = await s3.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: `${keyPrefix(cfg)}/${MANIFEST_KEY}`,
      ...(options.versionId ? { VersionId: options.versionId } : {}),
    }),
  );
  const manifestRaw = await manifestResp.Body?.transformToString();
  if (!manifestRaw) throw new Error('Backup manifest is empty or missing');
  const manifest = JSON.parse(manifestRaw) as BackupManifest;

  // NOTE: current-version objects only. Restoring a NON-latest manifest whose
  // files were later overwritten would need per-object version resolution —
  // out of scope for v1; the manifest tells us if sizes mismatch (integrity
  // check below) so a wrong mix is detected, not silently accepted.
  let restored = 0;
  for (const entry of manifest.files) {
    // Snapshots restore to their real path: .sqlite-snapshots/tasks/tasks.sqlite → tasks/tasks.sqlite
    const destRel = entry.path.startsWith(`${SQLITE_SNAPSHOT_PREFIX}/`)
      ? entry.path.slice(SQLITE_SNAPSHOT_PREFIX.length + 1)
      : entry.path;
    const dest = path.join(targetDir, destRel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: `${keyPrefix(cfg)}/data/${entry.path}` }),
    );
    if (!obj.Body) throw new Error(`Object missing for ${entry.path}`);
    await pipeline(obj.Body as Readable, createWriteStream(dest));
    const st = await fs.stat(dest);
    if (st.size !== entry.size) {
      throw new Error(
        `Integrity check failed for ${entry.path}: expected ${entry.size} bytes, got ${st.size}. ` +
        `The bucket may hold a newer/older mix — restore aborted.`,
      );
    }
    restored++;
    options.onFile?.(entry.path, restored, manifest.files.length);
  }

  return { manifest, restoredFiles: restored, targetDir };
}
