/**
 * `open-walnut backup` — backups from the CLI, same engines as Settings.
 *
 *   backup run                         one backup now
 *   backup list [--key <k>]            the backups there are
 *   backup restore [--at <id>] [--to <dir>] [--force] [--key <k>] [--profile <p>]
 *
 * With `backup.destination` in config.yaml (and no --bucket flag) these work on
 * encrypted backups; otherwise on the older S3 copy (`backup.bucket`).
 *
 * Restore downloads into a FRESH directory by default and never overwrites a
 * live data dir — disaster recovery must not be able to make things worse.
 */
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../core/config-manager.js';
import { WALNUT_HOME } from '../constants.js';
import type { BackupConfig } from '../core/backup/types.js';

/**
 * The encrypted-backup config a command works on: `--type` builds the
 * destination from flags (a new machine with no config.yaml); otherwise
 * config.yaml's `backup.destination`, unless `--bucket` asks for the older S3
 * copy.
 */
async function encryptedConfig(options: Record<string, unknown>): Promise<BackupConfig | null> {
  const flag = (k: string): string | undefined => (typeof options[k] === 'string' ? (options[k] as string) : undefined);
  const type = flag('type');
  if (type) {
    if (type !== 'r2' && type !== 's3' && type !== 'gdrive') throw new Error('--type is r2, s3 or gdrive');
    const saved = (await getConfig()).backup ?? {};
    return {
      ...saved,
      destination: {
        ...(saved.destination?.type === type ? saved.destination : {}),
        type,
        ...(flag('bucket') ? { bucket: flag('bucket') } : {}),
        ...(flag('prefix') ? { prefix: flag('prefix') } : {}),
        ...(flag('region') ? { region: flag('region') } : {}),
        ...(flag('accountId') ? { account_id: flag('accountId') } : {}),
        ...(flag('endpoint') ? { endpoint: flag('endpoint') } : {}),
        ...(flag('accessKeyId') ? { access_key_id: flag('accessKeyId') } : {}),
        // The env form keeps the secret out of shell history.
        ...(flag('secretAccessKey') ?? process.env.WALNUT_BACKUP_SECRET_ACCESS_KEY
          ? { secret_access_key: flag('secretAccessKey') ?? process.env.WALNUT_BACKUP_SECRET_ACCESS_KEY }
          : {}),
        ...(flag('profile') ? { auth: { method: 'profile' as const, profile: flag('profile') } } : {}),
      },
    };
  }
  if (flag('bucket')) return null;
  const cfg = (await getConfig()).backup;
  return cfg?.destination?.type ? cfg : null;
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
const keyOf = (options: Record<string, unknown>): string | undefined =>
  typeof options.key === 'string' && options.key.trim() ? options.key : process.env.WALNUT_BACKUP_RECOVERY_KEY || undefined;

/** Config for CLI runs: disk config, with bare-machine fallbacks. On a fresh
 *  machine there is no config.yaml yet — allow bucket/region/profile flags. */
async function resolveCliConfig(options: Record<string, unknown>): Promise<BackupConfig> {
  const config = await getConfig();
  const cfg: BackupConfig = { ...(config.backup ?? {}) };
  if (typeof options.bucket === 'string') cfg.bucket = options.bucket;
  if (typeof options.region === 'string') cfg.region = options.region;
  if (typeof options.prefix === 'string') cfg.prefix = options.prefix;
  if (typeof options.profile === 'string') {
    cfg.auth = { method: 'profile', profile: options.profile };
  } else if (!cfg.auth?.method) {
    cfg.auth = { method: 'aws_chain' };
  }
  if (!cfg.bucket) {
    throw new Error('No bucket configured — set backup.bucket in config.yaml or pass --bucket');
  }
  return cfg;
}

export async function runBackupRun(options: Record<string, unknown>): Promise<void> {
  const enc = await encryptedConfig(options);
  if (enc) {
    const { runEncryptedBackup } = await import('../core/backup/encrypted-backup.js');
    const { describeDestination } = await import('../core/backup/destination.js');
    console.log(`Backing up (encrypted) to ${describeDestination(enc.destination!)} ...`);
    let lastPct = -1;
    try {
      const r = await runEncryptedBackup(enc, {
        dataDir: WALNUT_HOME,
        onProgress: (done, total) => {
          const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; console.log(`  ${pct}%`); }
        },
      });
      console.log(`Backup complete: ${r.fileCount} files (${mb(r.totalBytes)}), ${r.changedFiles} read, ${mb(r.uploadedBytes)} uploaded in ${Math.round(r.durationMs / 1000)}s`);
      if (r.skipped.length) console.log(`  ${r.skipped.length} file(s) could not be read and kept their previous copy.`);
      if (r.pruneError) console.log(`  Old backups were not cleaned up: ${r.pruneError}`);
    } catch (err) {
      console.error(`Backup FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }
  const cfg = await resolveCliConfig(options);
  const { runBackup } = await import('../core/backup/s3-backup.js');
  console.log(`Backing up to s3://${cfg.bucket}/${cfg.prefix ?? 'walnut'} ...`);
  let lastPct = -1;
  const result = await runBackup(cfg, {
    onProgress: (uploaded, total) => {
      const pct = total > 0 ? Math.floor((uploaded / total) * 100) : 100;
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        console.log(`  upload ${pct}% (${(uploaded / 1048576).toFixed(1)} MB)`);
      }
    },
  });
  if (!result.ok) {
    console.error(`Backup FAILED: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Backup complete: ${result.uploaded} uploaded, ${result.unchanged} unchanged, ` +
    `${result.removed} removed, ${(result.uploadedBytes / 1048576).toFixed(1)} MB in ${Math.round(result.durationMs / 1000)}s`,
  );
  if (!result.versioningEnabled) {
    console.log(
      'WARNING: bucket versioning is OFF — deleted/overwritten backups cannot be recovered. ' +
      'Enable it: S3 console → bucket → Properties → Bucket Versioning.',
    );
  }
}

/** A failed list or restore: its message alone (a wrong key, a missing bucket), no stack trace. */
export function plainFailure(what: string): (err: unknown) => void {
  return (err) => {
    console.error(`${what} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  };
}

export async function runBackupList(options: Record<string, unknown>): Promise<void> {
  const enc = await encryptedConfig(options);
  if (enc) {
    const { listEncryptedBackups } = await import('../core/backup/encrypted-backup.js');
    const listing = await listEncryptedBackups(enc, { dataDir: WALNUT_HOME, recoveryKey: keyOf(options) });
    if (listing.snapshots.length === 0) {
      console.log(`No backups at ${listing.destination} yet.`);
      return;
    }
    console.log(`Backups at ${listing.destination} (written by ${listing.writer}):`);
    for (const s of listing.snapshots) {
      console.log(`  ${s.id}  ${s.createdAt}  ${s.fileCount} files  ${mb(s.totalBytes)}  from ${s.hostname}`);
    }
    if (listing.unreadable) console.log(`  (${listing.unreadable} could not be read)`);
    return;
  }
  const cfg = await resolveCliConfig(options);
  const { listRestorePoints } = await import('../core/backup/restore.js');
  const points = await listRestorePoints(cfg);
  if (points.length === 0) {
    console.log('No backups found at this bucket/prefix.');
    return;
  }
  console.log(`Restore points at s3://${cfg.bucket}/${cfg.prefix ?? 'walnut'}:`);
  for (const p of points) {
    console.log(`  ${p.createdAt}  ${p.isLatest ? '(latest)' : ''}  versionId=${p.versionId ?? '-'}`);
  }
  if (points.length === 1 && !points[0].versionId) {
    console.log('Note: bucket versioning is off — only the latest backup is restorable.');
  }
}

export async function runBackupRestore(options: Record<string, unknown>): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = typeof options.to === 'string'
    ? path.resolve(options.to)
    : path.join(os.homedir(), `open-walnut-restored-${ts}`);
  const enc = await encryptedConfig(options);
  if (enc) {
    const { restoreEncryptedBackup } = await import('../core/backup/encrypted-backup.js');
    console.log(`Restoring to ${target} ...`);
    let lastPct = -1;
    const r = await restoreEncryptedBackup(enc, {
      dataDir: WALNUT_HOME,
      snapshotId: typeof options.at === 'string' ? options.at : 'latest',
      targetDir: target,
      recoveryKey: keyOf(options),
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; console.log(`  ${pct}%`); }
      },
    });
    console.log(`Restore complete: ${r.restoredFiles} files (${mb(r.restoredBytes)}) from the backup of ${r.snapshot.createdAt} (${r.snapshot.hostname}), every file checked.`);
    const home = path.resolve(WALNUT_HOME);
    console.log(`To use it: quit Walnut, run this (your current data is kept aside, nothing is deleted), then start Walnut:`);
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const aside = `${home}-before-restore-${ts}`;
    console.log(`  [ ! -e ${q(aside)} ] && mv ${q(home)} ${q(aside)} && mv ${q(target)} ${q(home)}`);
    return;
  }
  const cfg = await resolveCliConfig(options);
  const { restoreFromBackup } = await import('../core/backup/restore.js');

  console.log(`Restoring to ${target} ...`);
  const result = await restoreFromBackup(cfg, target, {
    versionId: typeof options.at === 'string' ? options.at : undefined,
    force: options.force === true,
    onFile: (rel, i, total) => {
      if (i % 200 === 0 || i === total) console.log(`  ${i}/${total} files`);
    },
  });
  console.log(
    `Restore complete: ${result.restoredFiles} files from backup taken ${result.manifest.createdAt} ` +
    `(host ${result.manifest.hostname}, walnut ${result.manifest.walnutVersion})`,
  );
  console.log(`To adopt it: stop the server, move ${target} to ~/.open-walnut, restart.`);
}
