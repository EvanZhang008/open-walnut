/**
 * S3 backup — shared types.
 *
 * The backup subsystem uploads the canonical half of the data dir to a
 * user-owned S3 bucket on a schedule. Everything here is plain data so the
 * scanner/diff logic stays pure and unit-testable without an S3 client.
 */

/**
 * `backup:` section of config.yaml.
 *
 * Two engines, chosen by what is set:
 *   - `destination` set: the encrypted repository (repo/), to S3, Cloudflare R2
 *     or Google Drive. The legacy `bucket` stays unset, so an older Walnut that
 *     only knows `bucket` reads backups as not configured and uploads nothing.
 *   - only `bucket` set: the original S3 mirror (s3-backup.ts), unchanged for
 *     the people already using it.
 */
export interface BackupConfig {
  enabled?: boolean;
  /** Legacy S3 mirror only. */
  bucket?: string;
  region?: string;
  /** Key prefix inside the bucket. Default 'walnut'. */
  prefix?: string;
  /** Hours between automatic backups. Default 24, minimum 1. */
  interval_hours?: number;
  auth?: BackupAuthConfig;
  /** Encrypted backups: where they go. */
  destination?: BackupDestinationConfig;
  /**
   * Services set up before (one per type), kept so switching back needs no
   * retyping. Only `destination` is backed up to; these are never used.
   */
  other_destinations?: BackupDestinationConfig[];
  /** Encrypted backups: how many to keep. Default 7 daily + 4 weekly. */
  retention?: { daily?: number; weekly?: number };
  /** When the user confirmed they saved the recovery key (Settings stops asking). */
  recovery_key_saved_at?: string;
}

export type BackupDestinationType = 's3' | 'r2' | 'gdrive';

export interface BackupDestinationConfig {
  type: BackupDestinationType;
  /** s3, r2: the bucket. */
  bucket?: string;
  /** s3, r2: folder inside the bucket. Default 'walnut-backup'. */
  prefix?: string;
  /** s3: AWS region. */
  region?: string;
  /** r2: the Cloudflare account id (the endpoint is derived from it). */
  account_id?: string;
  /** s3, r2: any S3-compatible endpoint instead (R2 EU jurisdiction, MinIO, ...). */
  endpoint?: string;
  /** r2 and S3-compatible: an access key pair. Masked by config-redact. */
  access_key_id?: string;
  secret_access_key?: string;
  /** s3 on AWS: the credential source, as the legacy mirror. */
  auth?: BackupAuthConfig;
  /** gdrive: the folder's name (default "Walnut Backup"). Its id and the
   *  sign-in are this machine's own (local/backup/gdrive-token.json). */
  folder_name?: string;
  /** gdrive: the user's own Google OAuth client, when Walnut's is not used. */
  client_id?: string;
  client_secret?: string;
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
  /** A passing note, not a failure (a terminal's backup holds the lock). */
  notice?: string;
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
  /** Which engine runs: the legacy S3 mirror or encrypted backups. */
  engine?: 'mirror' | 'encrypted';
  /** Encrypted backups: where they go (`r2://bucket/prefix`, `Google Drive: Walnut Backup`). */
  destination?: string;
  /** Encrypted backups: a problem the user must act on (wrong key, another writer). */
  errorCode?: string;
  lastSnapshotId?: string;
  /** Encrypted backups: how many backups are kept now. */
  snapshotCount?: number;
  /** A restore in progress or just finished. */
  restore?: RestoreStatus;
}

export interface RestoreStatus {
  running: boolean;
  snapshotId?: string;
  targetDir?: string;
  /** Where the backup came from, as the user reads it ("Cloudflare R2"). */
  source?: string;
  /** When the backup restored was made. */
  snapshotAt?: string;
  doneBytes?: number;
  totalBytes?: number;
  doneFiles?: number;
  totalFiles?: number;
  finishedAt?: string;
  error?: string;
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
