/**
 * From `backup.destination` in config.yaml to a BackupStore.
 */
import { makeAccessTokenGetter, readDriveTokens, resolveOAuthClient } from './gdrive-oauth.js';
import { DriveStore } from './stores/drive-store.js';
import { r2Endpoint, S3Store } from './stores/s3-store.js';
import type { BackupStore } from './stores/types.js';
import type { BackupConfig, BackupDestinationConfig } from './types.js';

export const DEFAULT_REPO_PREFIX = 'walnut-backup';
export const DEFAULT_DRIVE_FOLDER = 'Walnut Backup';

export type BackupEngine = 'mirror' | 'encrypted';

/** Which engine this config runs, or null when backups are not set up. */
export function engineOf(cfg: BackupConfig | undefined): BackupEngine | null {
  if (cfg?.destination?.type) return 'encrypted';
  if (cfg?.bucket) return 'mirror';
  return null;
}

/**
 * What config still lacks before this destination can be used (empty =
 * complete). Google Drive's sign-in is machine-local, so isDestinationReady
 * checks it too.
 */
export function missingFields(dest: BackupDestinationConfig): string[] {
  const missing: string[] = [];
  // In the order the form shows them.
  if (dest.type === 'r2' && !dest.account_id?.trim() && !dest.endpoint?.trim()) missing.push('account ID');
  if (dest.type === 'r2' || dest.type === 's3') {
    if (!dest.bucket?.trim()) missing.push('bucket');
  }
  if (dest.type === 'r2') {
    if (!dest.access_key_id?.trim()) missing.push('access key ID');
    if (!dest.secret_access_key?.trim()) missing.push('secret access key');
  }
  if (dest.type === 's3' && dest.endpoint?.trim()) {
    const topLevel = Boolean(dest.access_key_id?.trim() && dest.secret_access_key?.trim());
    const inAuth = dest.auth?.method === 'access_keys' && Boolean(dest.auth.aws_access_key_id?.trim() && dest.auth.aws_secret_access_key?.trim());
    if (!topLevel && !inAuth) missing.push('access keys');
  }
  return missing;
}

/** Complete in config, and (Google Drive) signed in on this machine. */
export async function isDestinationReady(dest: BackupDestinationConfig, dataDir: string): Promise<boolean> {
  if (missingFields(dest).length > 0) return false;
  if (dest.type === 'gdrive') return Boolean((await readDriveTokens(dataDir))?.folder_id);
  return true;
}

export function describeDestination(dest: BackupDestinationConfig): string {
  if (dest.type === 'gdrive') return `Google Drive: ${dest.folder_name || DEFAULT_DRIVE_FOLDER}`;
  return `${dest.type}://${dest.bucket ?? ''}/${dest.prefix?.replace(/^\/+|\/+$/g, '') || DEFAULT_REPO_PREFIX}`;
}

export async function makeStore(dest: BackupDestinationConfig, dataDir: string): Promise<BackupStore> {
  const missing = missingFields(dest);
  if (missing.length > 0) throw new Error(`Backup destination is not set up: ${missing.join(', ')} missing.`);
  if (dest.type === 'gdrive') {
    const client = resolveOAuthClient({ client_id: dest.client_id, client_secret: dest.client_secret });
    if (!client) throw new Error('No Google client is set up for Drive backups. Connect Google Drive in Settings.');
    const tokens = await readDriveTokens(dataDir);
    if (!tokens?.folder_id) {
      throw new Error('Google Drive is not connected on this machine. Choose "Connect Google Drive" in Settings.');
    }
    return new DriveStore({
      folderId: tokens.folder_id,
      folderName: tokens.folder_name || dest.folder_name || DEFAULT_DRIVE_FOLDER,
      getAccessToken: makeAccessTokenGetter(dataDir, client),
    });
  }
  const endpoint = dest.endpoint?.trim() || (dest.type === 'r2' ? r2Endpoint(dest.account_id!) : undefined);
  return new S3Store({
    kind: dest.type,
    bucket: dest.bucket!.trim(),
    prefix: dest.prefix?.trim() || DEFAULT_REPO_PREFIX,
    region: dest.region?.trim() || undefined,
    endpoint,
    accessKeyId: dest.access_key_id?.trim() || undefined,
    secretAccessKey: dest.secret_access_key?.trim() || undefined,
    auth: dest.auth,
  });
}
