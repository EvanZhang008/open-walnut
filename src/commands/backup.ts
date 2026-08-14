/**
 * `open-walnut backup` — S3 backup from the CLI.
 *
 *   backup run                         one backup now (same engine as the UI)
 *   backup list                        restore points (manifest versions)
 *   backup restore [--at <versionId>] [--to <dir>] [--force] [--profile <p>]
 *
 * Restore downloads into a FRESH directory by default and never overwrites a
 * live data dir — disaster recovery must not be able to make things worse.
 */
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../core/config-manager.js';
import type { BackupConfig } from '../core/backup/types.js';

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

export async function runBackupList(options: Record<string, unknown>): Promise<void> {
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
  const cfg = await resolveCliConfig(options);
  const { restoreFromBackup } = await import('../core/backup/restore.js');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = typeof options.to === 'string'
    ? path.resolve(options.to)
    : path.join(os.homedir(), `.open-walnut-restored-${ts}`);

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
