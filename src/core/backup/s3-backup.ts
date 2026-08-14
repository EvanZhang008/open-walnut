/**
 * S3 backup engine — scan, diff, upload, manifest.
 *
 * Strategy: incremental sync against the last manifest (size+mtime), sqlite
 * via safe snapshots, manifest written LAST so its presence == a complete
 * backup. With bucket versioning on, manifest versions are the restore points
 * and object deletes only stack delete markers — that's the anti-ransomware
 * story. All I/O is async; nothing here may block the event loop.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { getVersion } from '../version.js';
import { mapLimit } from '../plugin-skill-loader.js';
import { diffAgainstManifest, scanDataDir, SQLITE_SNAPSHOT_PREFIX } from './scan.js';
import { snapshotSqliteDbs } from './sqlite-snapshot.js';
import type {
  BackupConfig,
  BackupManifest,
  BackupRunResult,
  ManifestEntry,
} from './types.js';

const NETWORK_TIMEOUT_MS = 30_000;
const UPLOAD_CONCURRENCY = 4;
/** PutObject below this size; lib-storage multipart above (its Upload needs a
 *  fully configured client — a plain PutObject also mocks cleanly in tests). */
const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const MANIFEST_KEY = 'backup-manifest.json';

/** Build the SDK credential source for the configured method.
 *  Mirrors credential-verify.ts providerFor — never logs key material. */
export function backupCredentials(
  cfg: BackupConfig,
): AwsCredentialIdentity | AwsCredentialIdentityProvider {
  const auth = cfg.auth ?? {};
  switch (auth.method) {
    case 'access_keys':
      return {
        accessKeyId: auth.aws_access_key_id ?? '',
        secretAccessKey: auth.aws_secret_access_key ?? '',
      };
    case 'profile':
      return fromIni({ profile: auth.profile });
    case 'aws_chain':
    default:
      return fromNodeProviderChain();
  }
}

export function makeS3Client(cfg: BackupConfig): S3Client {
  return new S3Client({
    region: cfg.region ?? 'us-west-2',
    credentials: backupCredentials(cfg),
    requestHandler: { requestTimeout: NETWORK_TIMEOUT_MS },
  });
}

// Bucket layout lives HERE only — restore.ts imports these so the two sides
// can never drift apart on where a backup was written.
export const keyPrefix = (cfg: BackupConfig): string => (cfg.prefix?.replace(/\/+$/, '') || 'walnut');
export const dataKey = (cfg: BackupConfig, rel: string): string => `${keyPrefix(cfg)}/data/${rel}`;
export const manifestKey = (cfg: BackupConfig): string => `${keyPrefix(cfg)}/${MANIFEST_KEY}`;

export interface TestConnectionResult {
  ok: boolean;
  arn?: string;
  account?: string;
  bucketExists?: boolean;
  versioningEnabled?: boolean;
  error?: string;
}

/** Real round-trip credential + bucket check: STS → HeadBucket → versioning. */
export async function testBackupConnection(
  cfg: BackupConfig,
  client?: S3Client,
): Promise<TestConnectionResult> {
  if (!cfg.bucket) return { ok: false, error: 'No bucket configured' };
  try {
    const sts = new STSClient({
      region: cfg.region ?? 'us-west-2',
      credentials: backupCredentials(cfg),
      requestHandler: { requestTimeout: NETWORK_TIMEOUT_MS },
    });
    const who = await sts.send(new GetCallerIdentityCommand({}));
    const s3 = client ?? makeS3Client(cfg);
    await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    const versioning = await getVersioningEnabled(s3, cfg.bucket);
    return {
      ok: true,
      arn: who.Arn,
      account: who.Account,
      bucketExists: true,
      versioningEnabled: versioning,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function getVersioningEnabled(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    const resp = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return resp.Status === 'Enabled';
  } catch {
    // No permission to check — report "off" so the UI nudges, never throws.
    return false;
  }
}

/** One-click deletion protection: PutBucketVersioning. Throws on failure so
 *  the route can tell the user to enable it in the console instead. */
export async function enableBucketVersioning(cfg: BackupConfig, client?: S3Client): Promise<void> {
  if (!cfg.bucket) throw new Error('No bucket configured');
  const s3 = client ?? makeS3Client(cfg);
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: cfg.bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
}

/** Fetch the last complete manifest, or null on a first backup. */
export async function fetchRemoteManifest(
  cfg: BackupConfig,
  client?: S3Client,
): Promise<BackupManifest | null> {
  const s3 = client ?? makeS3Client(cfg);
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: manifestKey(cfg) }),
    );
    const body = await resp.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as BackupManifest;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw err;
  }
}

// ── Single-flight latch: the scheduler tick and "Back Up Now" share it, so a
// manual click during a slow run can never start a second concurrent upload.
let inFlight: Promise<BackupRunResult> | null = null;

export function isBackupRunning(): boolean {
  return inFlight !== null;
}

export interface RunBackupOptions {
  client?: S3Client;
  dataDir?: string;
  /** Called as bytes land — drives the health progress field. */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

/** Run one backup; concurrent calls join the in-flight run. */
export function runBackup(cfg: BackupConfig, opts: RunBackupOptions = {}): Promise<BackupRunResult> {
  if (inFlight) return inFlight;
  inFlight = doRunBackup(cfg, opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRunBackup(cfg: BackupConfig, opts: RunBackupOptions): Promise<BackupRunResult> {
  const start = Date.now();
  const dataDir = opts.dataDir ?? WALNUT_HOME;
  const fail = (error: string): BackupRunResult => ({
    ok: false, uploaded: 0, removed: 0, unchanged: 0, totalBytes: 0,
    uploadedBytes: 0, durationMs: Date.now() - start, versioningEnabled: false, error,
  });
  if (!cfg.bucket) return fail('No bucket configured');

  const s3 = opts.client ?? makeS3Client(cfg);
  const stagingDir = path.join(dataDir, 'tmp', 'backup-staging');

  try {
    const versioningEnabled = await getVersioningEnabled(s3, cfg.bucket);

    // Previous manifest = incremental baseline + machine-mismatch guard.
    const previous = await fetchRemoteManifest(cfg, s3);
    const hostname = os.hostname();
    if (previous && previous.hostname !== hostname) {
      return fail(
        `Bucket prefix "${keyPrefix(cfg)}" already holds a backup from "${previous.hostname}". ` +
        `Two machines must not share a prefix — set a distinct backup.prefix on this machine.`,
      );
    }

    // Scan + sqlite snapshots (staging dir is inside excluded tmp/).
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });
    const scanned = await scanDataDir(dataDir);
    const snapshots = await snapshotSqliteDbs(dataDir, stagingDir);
    const all = [...scanned, ...snapshots.entries];

    const diff = diffAgainstManifest(all, previous);
    // A DB whose snapshot FAILED this run looks "deleted locally" to the diff.
    // Deleting its previous backup (and dropping it from the manifest) would
    // turn a transient snapshot error into real data loss — keep the previous
    // entry alive instead and let a later run refresh it.
    const failedSnapshotPaths = new Set(
      snapshots.failed.map((rel) => `${SQLITE_SNAPSHOT_PREFIX}/${rel}`),
    );
    const preserved = (previous?.files ?? []).filter((f) => failedSnapshotPaths.has(f.path));
    diff.remove = diff.remove.filter((rel) => !failedSnapshotPaths.has(rel));

    const totalBytes = all.reduce((n, f) => n + f.size, 0);
    const uploadTotal = diff.upload.reduce((n, f) => n + f.size, 0);
    log.session.info('backup: run starting', {
      files: all.length, upload: diff.upload.length, remove: diff.remove.length,
      unchanged: diff.unchanged.length, uploadBytes: uploadTotal, bucket: cfg.bucket,
      snapshotFailures: snapshots.failed.length,
    });

    // Upload changed files, bounded concurrency. Per-file failures are
    // isolated (same policy as sqlite snapshots): one live-mutating file must
    // not abort the whole run. A failed/vanished file keeps its PREVIOUS
    // manifest entry when it had one, so restore never loses it.
    let uploadedBytes = 0;
    const uploadOne = async (entry: ManifestEntry): Promise<ManifestEntry | null> => {
      const isSnapshot = entry.path.startsWith(`${SQLITE_SNAPSHOT_PREFIX}/`);
      const localPath = isSnapshot
        ? path.join(stagingDir, entry.path.slice(SQLITE_SNAPSHOT_PREFIX.length + 1))
        : path.join(dataDir, entry.path);
      // Re-stat at upload time: live-written files (chat history, outbox JSON)
      // routinely change size between scan and upload, and a stream body with
      // a stale ContentLength either fails the put or stores a torn object.
      const st = await fs.stat(localPath);
      const fresh: ManifestEntry = { path: entry.path, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      if (fresh.size <= MULTIPART_THRESHOLD_BYTES) {
        // ContentLength is required when the body is a stream.
        await s3.send(
          new PutObjectCommand({
            Bucket: cfg.bucket,
            Key: dataKey(cfg, entry.path),
            Body: createReadStream(localPath),
            ContentLength: fresh.size,
          }),
        );
      } else {
        // lib-storage multipart for big files (notes attachments, media).
        const upload = new Upload({
          client: s3,
          params: {
            Bucket: cfg.bucket,
            Key: dataKey(cfg, entry.path),
            Body: createReadStream(localPath),
          },
          partSize: 8 * 1024 * 1024,
          queueSize: 2,
        });
        await upload.done();
      }
      uploadedBytes += fresh.size;
      opts.onProgress?.(uploadedBytes, uploadTotal);
      return fresh;
    };
    const prevByPath = new Map((previous?.files ?? []).map((f) => [f.path, f]));
    const uploadFailures: string[] = [];
    const uploadedEntries = await mapLimit(diff.upload, UPLOAD_CONCURRENCY, async (entry) => {
      try {
        return await uploadOne(entry);
      } catch (err) {
        uploadFailures.push(entry.path);
        log.session.warn('backup: file upload failed — skipping', {
          file: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep the previous backup's entry (if any) so the manifest stays
        // truthful about what the bucket actually holds for this path.
        return prevByPath.get(entry.path) ?? null;
      }
    });

    // Delete files gone locally (versioning keeps their old versions).
    for (const rel of diff.remove) {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: dataKey(cfg, rel) }));
    }

    // Manifest LAST — its presence marks this backup complete. It lists what
    // the BUCKET holds: freshly-uploaded entries (re-stat'd sizes), unchanged
    // entries, and preserved previous entries for failed snapshots/uploads.
    const uploadedByPath = new Map(
      uploadedEntries.filter((e): e is ManifestEntry => e !== null).map((e) => [e.path, e]),
    );
    const manifestFiles = [
      ...diff.unchanged,
      ...uploadedByPath.values(),
      ...preserved,
    ].sort((a, b) => a.path.localeCompare(b.path));
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      hostname,
      walnutVersion: getVersion(),
      fileCount: manifestFiles.length,
      totalBytes,
      files: manifestFiles,
    };
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: manifestKey(cfg),
        Body: JSON.stringify(manifest),
        ContentType: 'application/json',
      }),
    );

    await fs.rm(stagingDir, { recursive: true, force: true });
    const durationMs = Date.now() - start;
    const uploadedOk = diff.upload.length - uploadFailures.length;
    log.session.info('backup: run complete', {
      uploaded: uploadedOk, failed: uploadFailures.length,
      removed: diff.remove.length, durationMs, uploadedBytes,
    });
    return {
      ok: true,
      uploaded: uploadedOk,
      removed: diff.remove.length,
      unchanged: diff.unchanged.length,
      totalBytes,
      uploadedBytes,
      durationMs,
      versioningEnabled,
      ...(uploadFailures.length > 0
        ? { error: `${uploadFailures.length} file(s) skipped (still covered by the previous backup where possible): ${uploadFailures.slice(0, 5).join(', ')}` }
        : {}),
    };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    log.session.warn('backup: run failed', { error: msg });
    return fail(msg);
  }
}

