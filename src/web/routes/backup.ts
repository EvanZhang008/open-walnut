/**
 * Backup routes — S3 backup configuration testing, manual runs, status.
 *
 * The scheduler itself lives in src/core/backup/backup-scheduler.ts and is
 * started by server.ts (primary box only); these routes are the UI surface.
 * Every handler that touches the network rides the engine's own request
 * timeouts (30s per S3 call) so a dead network can't pin a route forever.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getConfig } from '../../core/config-manager.js';
import {
  enableBucketVersioning,
  isBackupRunning,
  testBackupConnection,
} from '../../core/backup/s3-backup.js';
import type { BackupConfig } from '../../core/backup/types.js';
import type { BackupSchedulerHandle } from '../../core/backup/backup-scheduler.js';
import { log } from '../../logging/index.js';

export const backupRouter = Router();

/** server.ts hands us the live scheduler (null on cloud replicas). */
let scheduler: BackupSchedulerHandle | null = null;
export function setBackupScheduler(handle: BackupSchedulerHandle | null): void {
  scheduler = handle;
}

/** Effective config: request-body override (the form's unsaved state) wins,
 *  falling back to what's on disk — same shape as config.ts test-connection. */
async function effectiveConfig(body: unknown): Promise<BackupConfig> {
  const config = await getConfig();
  const fromBody = (body ?? {}) as Partial<BackupConfig>;
  const saved = config.backup ?? {};
  return {
    ...saved,
    ...fromBody,
    auth: { ...saved.auth, ...(fromBody.auth ?? {}) },
  };
}

// POST /api/backup/test — real round-trip: STS identity → HeadBucket → versioning.
backupRouter.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await effectiveConfig(req.body);
    const result = await testBackupConnection(cfg);
    log.web.info('backup: test-connection', { ok: result.ok, bucket: cfg.bucket });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/backup/run — manual "Back Up Now". 409 when a run is in flight.
backupRouter.post('/run', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!scheduler) {
      res.status(400).json({ error: 'Backups run on the primary machine only' });
      return;
    }
    if (isBackupRunning()) {
      res.status(409).json({ error: 'A backup is already running' });
      return;
    }
    const result = await scheduler.runNow();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Backup is not configured') {
      res.status(400).json({ error: msg });
      return;
    }
    next(err);
  }
});

// GET /api/backup/status — the scheduler's live health object.
backupRouter.get('/status', (_req: Request, res: Response) => {
  if (!scheduler) {
    res.json({ configured: false, running: false, consecutiveFailures: 0, primary: false });
    return;
  }
  res.json({ ...scheduler.health, primary: true });
});

// POST /api/backup/enable-versioning — one-click deletion protection.
backupRouter.post('/enable-versioning', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await effectiveConfig(req.body);
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
