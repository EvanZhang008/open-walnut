/**
 * S3 backup — shared types.
 *
 * The backup subsystem uploads the canonical half of the data dir to a
 * user-owned S3 bucket on a schedule. Everything here is plain data so the
 * scanner/diff logic stays pure and unit-testable without an S3 client.
 */

/** `backup:` section of config.yaml. */
export interface BackupConfig {
  enabled?: boolean;
  bucket?: string;
  region?: string;
  /** Key prefix inside the bucket. Default 'walnut'. */
  prefix?: string;
  /** Hours between automatic backups. Default 24, minimum 1. */
  interval_hours?: number;
  auth?: BackupAuthConfig;
}

/** Credential source for the S3 client — mirrors the Bedrock methods. */
export interface BackupAuthConfig {
  method?: 'access_keys' | 'profile' | 'aws_chain';
  profile?: string;
  aws_access_key_id?: string;
  /** Masked by config-redact before leaving the box (SECRET_FIELDS). */
  aws_secret_access_key?: string;
}

/** One file in a backup manifest. Paths are relative to the data dir root. */
export interface ManifestEntry {
  path: string;
  size: number;
  /** mtime in ms — cheap change detector alongside size. */
  mtimeMs: number;
}

/**
 * backup-manifest.json — written LAST, so its presence means the backup it
 * describes is complete. With bucket versioning on, the manifest's version
 * history doubles as the list of restorable points in time.
 */
export interface BackupManifest {
  version: 1;
  createdAt: string;
  /** Machine that wrote the backup — two machines sharing a prefix is refused. */
  hostname: string;
  walnutVersion: string;
  fileCount: number;
  totalBytes: number;
  files: ManifestEntry[];
}

/** Result of comparing a fresh scan against the previous manifest. */
export interface BackupDiff {
  /** New or changed since the last manifest — to upload. */
  upload: ManifestEntry[];
  /** Present in the last manifest but gone locally — to delete (versioning
   *  keeps the old object versions, so this is safe). */
  remove: string[];
  /** Unchanged — already in the bucket. */
  unchanged: ManifestEntry[];
}

/** Live health of the backup subsystem, broadcast as `backup:status`. */
export interface BackupHealth {
  configured: boolean;
  running: boolean;
  lastBackupAt?: string;
  lastDurationMs?: number;
  lastFileCount?: number;
  lastTotalBytes?: number;
  lastUploadedBytes?: number;
  /** Upload progress for the in-flight run (drives the UI progress bar). */
  progress?: { uploadedBytes: number; totalBytes: number };
  consecutiveFailures: number;
  error?: string;
  /** False = bucket has no versioning — deletion protection is off. */
  versioningEnabled?: boolean;
}

/** Outcome of one backup run. */
export interface BackupRunResult {
  ok: boolean;
  uploaded: number;
  removed: number;
  unchanged: number;
  totalBytes: number;
  uploadedBytes: number;
  durationMs: number;
  versioningEnabled: boolean;
  error?: string;
}
