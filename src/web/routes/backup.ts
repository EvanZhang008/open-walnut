/**
 * Backup routes — S3 backup configuration testing, manual runs, status.
 * Encrypted backups (S3, R2, Google Drive), restore and the recovery key are
 * in backup-encrypted.ts, mounted on this router.
 *
 * The scheduler itself lives in src/core/backup/backup-scheduler.ts and is
 * started by server.ts (primary box only). server.ts also only MOUNTS this
 * router on the primary: these endpoints sign real AWS requests with the
 * box's credential, which a cloud replica (reachable by any paired device)
 * must never expose.
 *
 * Credential/bucket mixing rule: a request body may EITHER bring its own
 * complete credentials (the settings form's unsaved state) OR rely on what's
 * saved on disk — but a body WITHOUT credentials cannot retarget the saved
 * credential at a different bucket. That combination is the "use the server's
 * AWS identity against my bucket" oracle.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getConfig } from '../../core/config-manager.js';
import { WALNUT_HOME } from '../../constants.js';
import {
  enableBucketVersioning,
  testBackupConnection,
} from '../../core/backup/s3-backup.js';
import { engineOf } from '../../core/backup/destination.js';
import { currentBackupJob } from '../../core/backup/jobs.js';
import type { BackupAuthConfig, BackupConfig } from '../../core/backup/types.js';
import type { BackupSchedulerHandle } from '../../core/backup/backup-scheduler.js';
import { log } from '../../logging/index.js';

export const backupRouter = Router();

/** server.ts hands us the live scheduler (null on cloud replicas). */
let scheduler: BackupSchedulerHandle | null = null;
export function setBackupScheduler(handle: BackupSchedulerHandle | null): void {
  scheduler = handle;
}
export function getBackupScheduler(): BackupSchedulerHandle | null {
  return scheduler;
}

/** True when the body carries its own usable credential source. */
function bodyHasOwnAuth(auth: BackupAuthConfig | undefined): boolean {
  if (!auth?.method) return false;
  if (auth.method === 'access_keys') return Boolean(auth.aws_access_key_id && auth.aws_secret_access_key);
  if (auth.method === 'profile') return Boolean(auth.profile);
  return true; // aws_chain — explicit choice of the machine's ambient chain
}

/**
 * Effective config for /test and /enable-versioning.
 * - Body with its own auth → use the body as-is (form's unsaved state).
 * - Body without auth → saved config only; body may tune non-target fields
 *   (region/prefix) but NOT retarget the saved credential at another bucket.
 */
async function effectiveConfig(body: unknown): Promise<{ cfg: BackupConfig; error?: string }> {
  const fromBody = (body ?? {}) as Partial<BackupConfig>;
  if (bodyHasOwnAuth(fromBody.auth)) {
    return { cfg: { ...fromBody, auth: fromBody.auth } };
  }
  const saved = (await getConfig()).backup ?? {};
  if (fromBody.bucket && saved.bucket && fromBody.bucket !== saved.bucket) {
    return {
      cfg: saved,
      error: 'Bucket differs from the saved configuration — include credentials in the request to test a different bucket.',
    };
  }
  return { cfg: { ...saved, ...fromBody, bucket: saved.bucket ?? fromBody.bucket, auth: saved.auth } };
}

// POST /api/backup/test — real round-trip: STS identity → HeadBucket → versioning.
backupRouter.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cfg, error } = await effectiveConfig(req.body);
    if (error) {
      res.status(400).json({ ok: false, error });
      return;
    }
    const result = await testBackupConnection(cfg);
    log.web.info('backup: test-connection', { ok: result.ok, bucket: cfg.bucket });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/backup/run — manual "Back Up Now". Answers 202 immediately; the
// run continues in the background and progress rides backup:status events.
// (Repo rule: no route may hang for the duration of a network job — a first
// 5GB backup can take hours and would pin a browser connection the whole way.)
backupRouter.post('/run', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!scheduler) {
      res.status(400).json({ error: 'Backups run on the primary machine only' });
      return;
    }
    const job = currentBackupJob();
    // A second "Back up now" while one runs is the same wish: it joins, never an error.
    if (job === 'backup') {
      res.status(202).json({ started: false, running: true });
      return;
    }
    if (job) {
      res.status(409).json({ error: 'A restore is running. Back up again when it finishes.' });
      return;
    }
    const config = await getConfig();
    if (!engineOf(config.backup)) {
      res.status(400).json({ error: 'Backup is not configured' });
      return;
    }
    scheduler.runNow().catch((err) => {
      log.web.warn('backup: manual run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/backup/status — the scheduler's live health object.
backupRouter.get('/status', async (_req: Request, res: Response) => {
  if (!scheduler) {
    res.json({ configured: false, running: false, consecutiveFailures: 0, primary: false });
    return;
  }
  // Another destination was saved since the health was last read: show its backups, not the old one's.
  scheduler.syncDestination((await getConfig()).backup);
  // dataDir: the restore result names the real data folder to swap it with.
  const { computerName } = await import('../../core/backup/local-state.js');
  const { readPendingSwitch, lastSwitchError } = await import('../../core/backup/restore-switch.js');
  res.json({
    ...scheduler.health, primary: true, dataDir: WALNUT_HOME, machineName: await computerName(),
    // "Use this restored data" asked, not done yet (it is done at the next start), or how the last one failed.
    pendingSwitch: await readPendingSwitch(WALNUT_HOME), switchError: await lastSwitchError(WALNUT_HOME),
  });
});

// POST /api/backup/enable-versioning — one-click deletion protection.
backupRouter.post('/enable-versioning', async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { cfg, error } = await effectiveConfig(req.body);
    if (error) {
      res.status(400).json({ ok: false, error });
      return;
    }
    await enableBucketVersioning(cfg);
    if (scheduler) scheduler.health.versioningEnabled = true;
    log.web.info('backup: bucket versioning enabled', { bucket: cfg.bucket });
    res.json({ ok: true });
  } catch (err) {
    // Common case: the credential lacks s3:PutBucketVersioning. Tell the user
    // to flip it in the console instead of a bare 500.
    const msg = err instanceof Error ? err.message : String(err);
    log.web.warn('backup: enable-versioning failed', { error: msg });
    res.status(502).json({
      ok: false,
      error: `Could not enable versioning (${msg}). Enable it in the S3 console: bucket → Properties → Bucket Versioning.`,
    });
  }
});
