/**
 * Backup scheduler — the "every X hours" tick.
 *
 * Same shape as startGitAutoCommit (src/web/server.ts): setTimeout
 * SELF-reschedule (a slow multi-GB upload can never stack a second tick),
 * health object broadcast as `backup:status`, and one failure notification
 * per episode. Primary box only — the caller gates on CLOUD_MODE/IS_EPHEMERAL.
 *
 * Two engines (destination.ts engineOf): the legacy S3 mirror when only
 * `backup.bucket` is set, encrypted backups when `backup.destination` is.
 */
import { WALNUT_HOME } from '../../constants.js';
import { friendlyStoreError } from './errors.js';
import { log } from '../../logging/index.js';
import { getConfig } from '../config-manager.js';
import { describeDestination, engineOf, isDestinationReady } from './destination.js';
import { listEncryptedBackups, runEncryptedBackup } from './encrypted-backup.js';
import { backupLockHeld } from './local-state.js';
import { currentBackupJob, runBackupJob } from './jobs.js';
import { RepoError } from './repo/repository.js';
import { fetchRemoteManifest, runBackup } from './s3-backup.js';
import type { BackupConfig, BackupHealth, BackupRunResult } from './types.js';

const MIN_INTERVAL_HOURS = 1;
const DEFAULT_INTERVAL_HOURS = 24;
/** Re-read config often enough that an interval/enable change applies without
 *  a restart, without re-arming a long timer. */
const CHECK_EVERY_MS = 60_000;
const FAILURE_NOTIFY_THRESHOLD = 3;

export interface BackupSchedulerDeps {
  emit: (name: string, data: unknown) => void;
  notify: (n: { title: string; body: string; dedupScope: string; recoveryKey?: string }) => Promise<boolean>;
  /**
   * A backup succeeded after failures — retire the failure notification.
   *
   * Injected through the SAME seam the failure path already uses (this module
   * must never import server code; the server owns the notification store). It
   * is optional so an existing caller/test that only wires `notify` keeps
   * compiling, and the scheduler self-gates on the failure→success transition
   * below so this fires once per episode, not on every healthy run.
   */
  onRecovered?: () => void;
  /** Data home (tests point it at a temp dir). */
  dataDir?: string;
}

export interface BackupSchedulerHandle {
  stop: () => void;
  health: BackupHealth;
  /** Manual "Back Up Now" — shares the engine's single-flight latch. */
  runNow: () => Promise<BackupRunResult>;
  /** Push the current health to every window (after a restore or a setting change). */
  emitStatus: () => void;
  /** Forget the schedule anchor (the destination or the key changed): read it again now, backups on or off. */
  resetAnchor: () => void;
  /** Run the next backup at the next check, whatever the schedule says (the backups were just moved here). */
  runSoon: () => void;
  /**
   * The health shows ONE destination's backups. When the configured one is not
   * the one shown, forget the old one's last backup, error and restore at once,
   * then read the new one's newest backup in the background. True when it moved.
   */
  syncDestination: (cfg: BackupConfig | undefined) => boolean;
}

/** Ready to run: switched on and the chosen engine has what it needs. */
export async function isBackupConfigured(cfg: BackupConfig | undefined, dataDir: string): Promise<boolean> {
  if (!cfg?.enabled) return false;
  const engine = engineOf(cfg);
  if (engine === 'mirror') return Boolean(cfg.bucket);
  // Nothing leaves this computer before the user said the recovery key is kept
  // somewhere (Settings, Backup, "I saved it"; a typed key counts): without it the
  // backups could never be opened again.
  if (engine === 'encrypted') return Boolean(cfg.recovery_key_saved_at) && isDestinationReady(cfg.destination!, dataDir);
  return false;
}

export function startBackupScheduler(deps: BackupSchedulerDeps): BackupSchedulerHandle {
  const dataDir = deps.dataDir ?? WALNUT_HOME;
  const health: BackupHealth = { configured: false, running: false, consecutiveFailures: 0 };
  let notifiedForEpisode = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRunAtMs = 0;
  /** The destination the anchor was read for: a new one is read again. */
  let anchorFor = '';
  /** Run at the next check, whatever the anchor says (a service chosen while running, backups moved here). */
  let forceDue = false;

  const emitStatus = (): void => deps.emit('backup:status', health);

  const describe = (cfg: BackupConfig): string =>
    engineOf(cfg) === 'encrypted' ? describeDestination(cfg.destination!) : `s3://${cfg.bucket}/${cfg.prefix ?? 'walnut'}`;

  const applyResult = (result: BackupRunResult, errorCode?: string): void => {
    health.running = false;
    health.progress = undefined;
    health.versioningEnabled = result.versioningEnabled;
    if (result.ok) {
      // Captured BEFORE the reset below: this is the failure→success edge, and
      // the only moment the 'Backup Failing' card should be retired. Reading
      // it after the reset would make every healthy run look like a recovery and
      // turn the 60s tick into a permanent no-op store scan.
      const wasFailing = health.consecutiveFailures > 0;
      health.lastBackupAt = new Date().toISOString();
      health.lastDurationMs = result.durationMs;
      health.lastFileCount = result.uploaded + result.unchanged;
      health.lastTotalBytes = result.totalBytes;
      health.lastUploadedBytes = result.uploadedBytes;
      health.consecutiveFailures = 0;
      // The mirror's per-file skips were never shown after a good run; keep it so.
      health.error = health.engine === 'encrypted' ? result.error : undefined;
      health.errorCode = undefined;
      notifiedForEpisode = false;
      if (wasFailing) deps.onRecovered?.();
    } else {
      health.consecutiveFailures++;
      health.error = result.error;
      health.errorCode = errorCode;
      // A problem only the user can fix (wrong key, another machine writes
      // here) is shown in Settings at once; the card still waits for 3.
      if (health.consecutiveFailures >= FAILURE_NOTIFY_THRESHOLD && !notifiedForEpisode) {
        notifiedForEpisode = true;
        void deps
          .notify({
            title: health.engine === 'encrypted' ? 'Backup Failing' : 'S3 Backup Failing',
            body: `Backup has failed ${health.consecutiveFailures} times in a row: ${result.error}`,
            dedupScope: health.engine === 'encrypted' ? 'backup:encrypted' : 'backup:s3',
            recoveryKey: 'backup',
          })
          .then((published) => {
            if (!published) notifiedForEpisode = false;
          });
      }
    }
    emitStatus();
  };

  const runEncrypted = async (cfg: BackupConfig): Promise<{ result: BackupRunResult; errorCode?: string }> => {
    const start = Date.now();
    try {
      let lastEmit = 0;
      const r = await runEncryptedBackup(cfg, {
        dataDir,
        onProgress: (done, total) => {
          health.progress = { uploadedBytes: done, totalBytes: total };
          // Every window gets a frame per emit: a few a second, not one per file.
          const now = Date.now();
          if (now - lastEmit >= 250 || done === total) {
            lastEmit = now;
            emitStatus();
          }
        },
      });
      health.lastSnapshotId = r.snapshotId;
      if (r.snapshotCount !== undefined) health.snapshotCount = r.snapshotCount;
      const notes = [
        ...(r.skipped.length ? [`${r.skipped.length} file(s) could not be read and kept their previous copy: ${r.skipped.slice(0, 5).join(', ')}`] : []),
        ...(r.pruneError ? [`Old backups were not cleaned up this time: ${r.pruneError}`] : []),
      ];
      return {
        result: {
          ok: true,
          uploaded: r.changedFiles,
          removed: 0,
          unchanged: r.fileCount - r.changedFiles,
          totalBytes: r.totalBytes,
          uploadedBytes: r.uploadedBytes,
          durationMs: r.durationMs,
          versioningEnabled: false,
          ...(notes.length ? { error: notes.join(' ') } : {}),
        },
      };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = err instanceof RepoError ? raw : friendlyStoreError(err, cfg.destination!);
      log.session.warn('backup: encrypted run failed', { error: raw });
      return {
        result: {
          ok: false, uploaded: 0, removed: 0, unchanged: 0, totalBytes: 0, uploadedBytes: 0,
          durationMs: Date.now() - start, versioningEnabled: false, error: msg,
        },
        errorCode: err instanceof RepoError ? err.code
          : err instanceof Error && err.name === 'DriveAuthError' ? 'drive_auth'
          : err instanceof Error && err.name === 'BackupLockedError' ? 'busy'
          : undefined,
      };
    }
  };

  const execute = async (cfg: BackupConfig): Promise<BackupRunResult> =>
    runBackupJob('backup', async () => {
      health.running = true;
      health.engine = engineOf(cfg) ?? undefined;
      health.destination = describe(cfg);
      emitStatus();
      let outcome: { result: BackupRunResult; errorCode?: string };
      if (health.engine === 'encrypted') {
        outcome = await runEncrypted(cfg);
      } else {
        outcome = {
          result: await runBackup(cfg, {
            dataDir,
            onProgress: (uploadedBytes, totalBytes) => {
              health.progress = { uploadedBytes, totalBytes };
              emitStatus();
            },
          }),
        };
      }
      if (outcome.errorCode === 'busy') {
        // A terminal's `open-walnut backup` holds the lock: not a failure. Read the
        // anchor again next tick, so the backup it makes counts as this one.
        health.running = false;
        health.progress = undefined;
        health.notice = 'A backup or restore started from a terminal is running; this one waits for it.';
        anchorFor = '';
        emitStatus();
        return outcome.result;
      }
      health.notice = undefined;
      lastRunAtMs = Date.now();
      forceDue = false;
      health.dueNow = undefined;
      applyResult(outcome.result, outcome.errorCode);
      return outcome.result;
    });

  /** The schedule anchor must survive restarts (dev:prod restarts this server
   *  several times a day; lastRunAtMs alone would make every boot "due"). The
   *  durable anchor is the newest backup at the destination, read once per
   *  process and destination. */
  const forgetDestination = (at: string | undefined): void => {
    health.destination = at;
    health.lastBackupAt = undefined;
    health.lastDurationMs = undefined;
    health.lastFileCount = undefined;
    health.lastTotalBytes = undefined;
    health.lastUploadedBytes = undefined;
    health.lastSnapshotId = undefined;
    health.snapshotCount = undefined;
    health.versioningEnabled = undefined;
    health.notice = undefined;
    health.error = undefined;
    health.errorCode = undefined;
    health.consecutiveFailures = 0;
    notifiedForEpisode = false;
    if (!health.restore?.running) health.restore = undefined;
    anchorFor = '';
    lastRunAtMs = 0;
  };

  const syncDestination = (cfg: BackupConfig | undefined): boolean => {
    const at = cfg && engineOf(cfg) ? describe(cfg) : undefined;
    if (health.destination === at || health.running) return false;
    // A service chosen while Walnut runs (not the first read at start) backs up within a
    // minute: the newest backup there may be older than the data, and the user just chose it.
    const switched = health.destination !== undefined && at !== undefined;
    forgetDestination(at);
    if (switched) { forceDue = true; health.dueNow = true; }
    emitStatus();
    if (cfg && at) {
      void (async () => {
        if (engineOf(cfg) === 'encrypted' && !(await isDestinationReady(cfg.destination!, dataDir))) return;
        await readAnchor(cfg);
      })().catch(() => {});
    }
    return true;
  };

  const readAnchor = async (cfg: BackupConfig): Promise<void> => {
    const at = describe(cfg);
    if (anchorFor === at) return;
    anchorFor = at;
    lastRunAtMs = 0;
    health.destination = at;
    health.engine = engineOf(cfg) ?? undefined;
    try {
      if (health.engine === 'encrypted') {
        const listing = await listEncryptedBackups(cfg, { dataDir });
        health.snapshotCount = listing.snapshots.length;
        // Another computer writes these: run at the next check, so the pane asks about it
        // now (a restore on a new computer), not when the schedule comes round a day later.
        const otherWriter = listing.snapshots.length > 0 && !listing.thisWriter;
        const newest = listing.snapshots[0];
        if (newest) {
          lastRunAtMs = Date.parse(newest.createdAt) || 0;
          health.lastBackupAt = newest.createdAt;
          health.lastFileCount = newest.fileCount;
          health.lastTotalBytes = newest.totalBytes;
          health.lastSnapshotId = newest.id;
        }
        if (otherWriter) lastRunAtMs = 0;
      } else {
        const previous = await fetchRemoteManifest(cfg);
        if (previous) {
          lastRunAtMs = Date.parse(previous.createdAt) || 0;
          health.lastBackupAt = previous.createdAt;
        }
      }
    } catch {
      /* unreachable destination or no key yet — the run itself will surface the error */
    }
    emitStatus();
  };

  /** Read the anchor now when the destination can be read, backups on or off (the pane shows what is there). */
  const readAnchorNow = (): void => {
    void (async () => {
      const cfg = (await getConfig()).backup;
      if (!cfg || !engineOf(cfg) || currentBackupJob() !== null) return;
      if (engineOf(cfg) === 'encrypted' && !(await isDestinationReady(cfg.destination!, dataDir))) return;
      await readAnchor(cfg);
    })().catch(() => {});
  };

  const tick = async (): Promise<void> => {
    try {
      const config = await getConfig();
      const cfg = config.backup;
      syncDestination(cfg);
      // The terminal's run ended: its notice goes even when no run of ours follows
      // (the backup it made counts, so the next one may be a day away).
      if (health.notice && !(await backupLockHeld(dataDir))) {
        health.notice = undefined;
        emitStatus();
      }
      health.configured = await isBackupConfigured(cfg, dataDir);
      if (health.configured && currentBackupJob() === null) {
        await readAnchor(cfg!);
        const hours = Math.max(cfg!.interval_hours ?? DEFAULT_INTERVAL_HOURS, MIN_INTERVAL_HOURS);
        const dueAtMs = lastRunAtMs + hours * 3_600_000;
        // Never backed up anywhere → first tick runs immediately.
        if (forceDue || Date.now() >= dueAtMs) {
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
      if (!engineOf(cfg)) throw new Error('Backup is not configured');
      return execute(cfg!);
    },
    emitStatus,
    resetAnchor(): void {
      anchorFor = '';
      readAnchorNow();
    },
    runSoon(): void {
      forceDue = true;
      health.dueNow = true;
      emitStatus();
    },
    syncDestination,
  };
}
