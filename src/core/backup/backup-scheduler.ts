/**
 * Backup scheduler — the "every X hours" tick.
 *
 * Same shape as startGitAutoCommit (src/web/server.ts): setTimeout
 * SELF-reschedule (a slow multi-GB upload can never stack a second tick),
 * health object broadcast as `backup:status`, and one failure notification
 * per episode. Primary box only — the caller gates on CLOUD_MODE/IS_EPHEMERAL.
 */
import { log } from '../../logging/index.js';
import { getConfig } from '../config-manager.js';
import { isBackupRunning, runBackup } from './s3-backup.js';
import type { BackupConfig, BackupHealth, BackupRunResult } from './types.js';

const MIN_INTERVAL_HOURS = 1;
const DEFAULT_INTERVAL_HOURS = 24;
/** Re-read config often enough that an interval/enable change applies without
 *  a restart, without re-arming a long timer. */
const CHECK_EVERY_MS = 60_000;
const FAILURE_NOTIFY_THRESHOLD = 3;

export interface BackupSchedulerDeps {
  emit: (name: string, data: unknown) => void;
  notify: (n: { title: string; body: string; dedupScope: string }) => Promise<boolean>;
}

export interface BackupSchedulerHandle {
  stop: () => void;
  health: BackupHealth;
  /** Manual "Back Up Now" — shares the engine's single-flight latch. */
  runNow: () => Promise<BackupRunResult>;
}

export function startBackupScheduler(deps: BackupSchedulerDeps): BackupSchedulerHandle {
  const health: BackupHealth = { configured: false, running: false, consecutiveFailures: 0 };
  let notifiedForEpisode = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRunAtMs = 0;

  const emitStatus = (): void => deps.emit('backup:status', health);

  const applyResult = (result: BackupRunResult): void => {
    health.running = false;
    health.progress = undefined;
    health.versioningEnabled = result.versioningEnabled;
    if (result.ok) {
      health.lastBackupAt = new Date().toISOString();
      health.lastDurationMs = result.durationMs;
      health.lastFileCount = result.uploaded + result.unchanged;
      health.lastTotalBytes = result.totalBytes;
      health.lastUploadedBytes = result.uploadedBytes;
      health.consecutiveFailures = 0;
      health.error = undefined;
      notifiedForEpisode = false;
    } else {
      health.consecutiveFailures++;
      health.error = result.error;
      if (health.consecutiveFailures >= FAILURE_NOTIFY_THRESHOLD && !notifiedForEpisode) {
        notifiedForEpisode = true;
        void deps
          .notify({
            title: 'S3 Backup Failing',
            body: `Backup has failed ${health.consecutiveFailures} times in a row: ${result.error}`,
            dedupScope: 'backup:s3',
          })
          .then((published) => {
            if (!published) notifiedForEpisode = false;
          });
      }
    }
    emitStatus();
  };

  const execute = async (cfg: BackupConfig): Promise<BackupRunResult> => {
    health.running = true;
    emitStatus();
    const result = await runBackup(cfg, {
      onProgress: (uploadedBytes, totalBytes) => {
        health.progress = { uploadedBytes, totalBytes };
        emitStatus();
      },
    });
    lastRunAtMs = Date.now();
    applyResult(result);
    return result;
  };

  const tick = async (): Promise<void> => {
    try {
      const config = await getConfig();
      const cfg = config.backup;
      health.configured = Boolean(cfg?.enabled && cfg.bucket);
      if (health.configured && !isBackupRunning()) {
        const hours = Math.max(cfg!.interval_hours ?? DEFAULT_INTERVAL_HOURS, MIN_INTERVAL_HOURS);
        const dueAtMs = lastRunAtMs + hours * 3_600_000;
        // First tick after boot backs up immediately only if never run — a
        // successful run in this process anchors the schedule.
        if (Date.now() >= dueAtMs) {
          await execute(cfg!);
        }
      }
    } catch (err) {
      log.session.warn('backup: scheduler tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), CHECK_EVERY_MS);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(() => void tick(), CHECK_EVERY_MS);
  timer.unref?.();
  log.session.info('backup: scheduler started', { checkEveryMs: CHECK_EVERY_MS });
  emitStatus();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    health,
    async runNow(): Promise<BackupRunResult> {
      const config = await getConfig();
      const cfg = config.backup;
      if (!cfg?.bucket) throw new Error('Backup is not configured');
      const result = await execute(cfg);
      return result;
    },
  };
}
