/**
 * Encrypted backup routes (mounted on backupRouter, primary box only):
 * destination test, the list of backups, restore, the recovery key, moving
 * the writer to this machine, and the Google Drive sign-in.
 *
 * Secrets in a request body: a field that still holds the settings view's
 * mask (bullets) takes the saved value, but only for the SAME target (type,
 * bucket, account, endpoint). Pointing the saved keys at another bucket needs
 * the keys typed again, as the legacy routes require.
 *
 * Long work (a restore can take an hour) answers 202 and reports through the
 * `backup:status` event; the Drive sign-in reports through `backup:gdrive`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { WALNUT_HOME } from '../../constants.js';
import { getConfig } from '../../core/config-manager.js';
import { DEFAULT_DRIVE_FOLDER, engineOf } from '../../core/backup/destination.js';
import {
  adoptEncryptedBackups, checkRecoveryKey, listEncryptedBackups, restoreEncryptedBackup, testDestination,
} from '../../core/backup/encrypted-backup.js';
import {
  completeDriveConnectFromUrl, readDriveTokens, resolveOAuthClient, revokeDriveTokens,
  startDriveConnect, writeDriveTokens, makeAccessTokenGetter, type OAuthClient,
} from '../../core/backup/gdrive-oauth.js';
import { driveAbout, findOrCreateFolder } from '../../core/backup/stores/drive-store.js';
import { BackupBusyError, runBackupJob } from '../../core/backup/jobs.js';
import { ensureRecoveryKey, readRecoveryKey, writeRecoveryKey } from '../../core/backup/recovery-key.js';
import { listRestorePoints, restoreFromBackup } from '../../core/backup/restore.js';
import type { BackupConfig, BackupDestinationConfig, RestoreStatus } from '../../core/backup/types.js';
import { log } from '../../logging/index.js';
import { getBackupScheduler } from './backup.js';
import { isPersonAtThisMachine } from './expose.js';

export const encryptedBackupRouter = Router();

const MASK = '•';
const SECRET_KEYS = ['access_key_id', 'secret_access_key', 'client_secret'] as const;
const AUTH_SECRET_KEYS = ['aws_access_key_id', 'aws_secret_access_key'] as const;
const sameTarget = (a: BackupDestinationConfig, b: BackupDestinationConfig): boolean =>
  a.type === b.type && (a.bucket ?? '') === (b.bucket ?? '') && (a.account_id ?? '') === (b.account_id ?? '')
  && (a.endpoint ?? '') === (b.endpoint ?? '') && (a.client_id ?? '') === (b.client_id ?? '');
const masked = (v: unknown): boolean => typeof v === 'string' && v.includes(MASK);

/**
 * The destination a request means: its own (masks restored for the same
 * target, the nested `auth` keys too), else the saved one. `custom` says the
 * request named a target other than the saved one.
 */
async function requestDestination(body: unknown): Promise<{ dest?: BackupDestinationConfig; cfg: BackupConfig; custom?: boolean; error?: string }> {
  const cfg = (await getConfig()).backup ?? {};
  const saved = cfg.destination;
  const sent = (body as { destination?: BackupDestinationConfig } | undefined)?.destination;
  if (!sent?.type) return { dest: saved, cfg };
  const dest: BackupDestinationConfig = { ...sent, ...(sent.auth ? { auth: { ...sent.auth } } : {}) };
  const same = Boolean(saved && sameTarget(saved, dest));
  const refuse = { cfg, error: 'The saved keys belong to another destination. Type the keys for this one.' };
  for (const k of SECRET_KEYS) {
    if (!masked(dest[k])) continue;
    if (!same) return refuse;
    dest[k] = saved![k];
  }
  if (dest.auth) {
    const auth = dest.auth as Record<string, unknown>;
    const savedAuth = (saved?.auth ?? {}) as Record<string, unknown>;
    for (const k of AUTH_SECRET_KEYS) {
      if (!masked(auth[k])) continue;
      if (!same) return refuse;
      auth[k] = savedAuth[k];
    }
  }
  return { dest, cfg: { ...cfg, destination: dest }, custom: !same };
}

/** Credentials and where data may go are the user's own steps: only the person at this computer. */
function personOnly(req: Request, res: Response, what = 'The recovery key is shown and changed'): boolean {
  if (isPersonAtThisMachine(req)) return true;
  res.status(403).json({ error: `${what} only by you, on the computer Walnut runs on.`, code: 'person_at_this_machine' });
  return false;
}

const emitStatus = (): void => getBackupScheduler()?.emitStatus();

function setRestore(status: RestoreStatus | undefined): void {
  const s = getBackupScheduler();
  if (!s) return;
  s.health.restore = status;
  s.emitStatus();
}

// POST /api/backup/destination/test — write, read back and delete a probe; say whether backups are there.
encryptedBackupRouter.post('/destination/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dest, custom, error } = await requestDestination(req.body);
    if (error) return void res.status(400).json({ ok: false, error });
    if (!dest) return void res.status(400).json({ ok: false, error: 'Choose where backups go first.' });
    if (custom && !personOnly(req, res, 'A new backup destination is tried')) return;
    const result = await testDestination(dest, { dataDir: WALNUT_HOME });
    log.web.info('backup: destination test', { ok: result.ok, type: dest.type, hasBackups: result.hasBackups });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/backup/snapshots — the backups at the destination, newest first.
encryptedBackupRouter.post('/snapshots', async (req: Request, res: Response) => {
  try {
    const { dest, cfg, custom, error } = await requestDestination(req.body);
    if (error) return void res.status(400).json({ error });
    const typedKey = typeof req.body?.recoveryKey === 'string' && req.body.recoveryKey.trim();
    if ((custom || typedKey) && !personOnly(req, res, 'Backups elsewhere are listed')) return;
    if (engineOf(cfg) === 'mirror' && !dest) {
      const points = await listRestorePoints(cfg);
      return void res.json({
        engine: 'mirror',
        destination: `s3://${cfg.bucket}/${cfg.prefix ?? 'walnut'}`,
        snapshots: points.map((p) => ({ id: p.versionId ?? 'latest', createdAt: p.createdAt, isLatest: p.isLatest })),
      });
    }
    if (!dest) return void res.status(400).json({ error: 'Choose where backups go first.' });
    const key = typeof req.body?.recoveryKey === 'string' && req.body.recoveryKey.trim() ? req.body.recoveryKey : undefined;
    const listing = await listEncryptedBackups(cfg, { dataDir: WALNUT_HOME, recoveryKey: key });
    res.json({ engine: 'encrypted', ...listing });
  } catch (err) {
    const code = (err as { code?: string }).code;
    res.status(code === 'key_mismatch' || code === 'no_repo' ? 409 : 502).json({
      error: err instanceof Error ? err.message : String(err),
      code,
    });
  }
});

/** Where a restore lands by default: beside the data home, never inside it. */
function defaultRestoreDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(path.dirname(path.resolve(WALNUT_HOME)), `open-walnut-restored-${ts}`);
}

/** The real path of `p`: its nearest existing ancestor resolved through symlinks, the rest appended. */
async function realTarget(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function badTarget(target: string): Promise<string | null> {
  if (!path.isAbsolute(target)) return 'Give the folder as a full path (it starts with /).';
  const home = await realTarget(WALNUT_HOME);
  const t = await realTarget(target);
  if (t === home || t.startsWith(home + path.sep)) return 'Restore never writes into the data folder Walnut is running on. Pick a new folder.';
  if (home.startsWith(t + path.sep)) return 'That folder holds the running data folder. Pick a new, empty folder.';
  return null;
}

// POST /api/backup/restore — bring one backup back into a new folder (202; progress on backup:status).
encryptedBackupRouter.post('/restore', async (req: Request, res: Response) => {
  const { dest, cfg, custom, error } = await requestDestination(req.body);
  if (error) return void res.status(400).json({ error });
  const snapshotId = typeof req.body?.snapshotId === 'string' ? req.body.snapshotId : 'latest';
  const typedKey = typeof req.body?.recoveryKey === 'string' && req.body.recoveryKey.trim();
  const customTarget = typeof req.body?.targetDir === 'string' && req.body.targetDir.trim() !== '';
  // Backups from a destination or key the request brings could be anyone's files, and a
  // folder of the request's choosing gets the whole data home in the clear: the person's step.
  if ((custom || typedKey || customTarget) && !personOnly(req, res, 'A restore from another destination or key, or into a folder of your choice, is started')) return;
  const targetDir = typeof req.body?.targetDir === 'string' && req.body.targetDir.trim()
    ? req.body.targetDir.trim().replace(/^~(?=\/|$)/, os.homedir())
    : defaultRestoreDir();
  const bad = await badTarget(targetDir);
  if (bad) return void res.status(400).json({ error: bad });
  // Said at once, beside the folder field, not later as a failed restore.
  const inTarget = await fs.readdir(targetDir).catch(() => null);
  if (inTarget && inTarget.length > 0) return void res.status(400).json({ error: `${targetDir} is not empty. Pick a new, empty folder (or leave the field empty).` });
  const recoveryKey = typeof req.body?.recoveryKey === 'string' && req.body.recoveryKey.trim() ? req.body.recoveryKey : undefined;
  const mirror = engineOf(cfg) === 'mirror' && !dest;
  if (!mirror && !dest) return void res.status(400).json({ error: 'Choose where backups go first.' });

  const status: RestoreStatus = { running: true, snapshotId, targetDir };
  const job = runBackupJob('restore', async () => {
    setRestore(status);
    try {
      if (mirror) {
        const r = await restoreFromBackup(cfg, targetDir, {
          versionId: snapshotId === 'latest' ? undefined : snapshotId,
          onFile: (_rel, i, total) => {
            if (i % 50 === 0 || i === total) setRestore({ ...status, doneFiles: i, totalFiles: total });
          },
        });
        setRestore({ ...status, running: false, doneFiles: r.restoredFiles, totalFiles: r.restoredFiles, finishedAt: new Date().toISOString() });
      } else {
        let last = 0;
        const r = await restoreEncryptedBackup(cfg, {
          dataDir: WALNUT_HOME, snapshotId, targetDir, recoveryKey,
          onProgress: (doneBytes, totalBytes, doneFiles, totalFiles) => {
            if (Date.now() - last < 500 && doneFiles !== totalFiles) return;
            last = Date.now();
            setRestore({ ...status, doneBytes, totalBytes, doneFiles, totalFiles });
          },
        });
        setRestore({
          ...status, running: false, snapshotId: r.snapshot.id, doneBytes: r.restoredBytes, totalBytes: r.restoredBytes,
          doneFiles: r.restoredFiles, totalFiles: r.restoredFiles, finishedAt: new Date().toISOString(),
        });
        log.web.info('backup: restore complete', { files: r.restoredFiles, bytes: r.restoredBytes });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.web.warn('backup: restore failed', { error: msg });
      setRestore({ ...status, running: false, error: msg, finishedAt: new Date().toISOString() });
    }
  });
  job.catch((err) => {
    if (err instanceof BackupBusyError) return;
    log.web.warn('backup: restore job failed', { error: err instanceof Error ? err.message : String(err) });
  });
  // A job refused at once (another job runs) answers 409 instead of 202.
  const refused = await Promise.race([job.then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(null), 20))]);
  if (refused instanceof BackupBusyError) return void res.status(409).json({ error: refused.message });
  res.status(202).json({ started: true, targetDir });
});

// POST /api/backup/restore/dismiss — the user read the last restore's result: stop showing it.
encryptedBackupRouter.post('/restore/dismiss', (_req: Request, res: Response) => {
  const s = getBackupScheduler();
  if (s?.health.restore && !s.health.restore.running) setRestore(undefined);
  res.json({ ok: true });
});

// GET /api/backup/recovery-key — this machine's key (only to the person at it).
encryptedBackupRouter.get('/recovery-key', async (req: Request, res: Response) => {
  if (!personOnly(req, res)) return;
  const cfg = (await getConfig()).backup ?? {};
  res.json({ key: await readRecoveryKey(WALNUT_HOME), savedAt: cfg.recovery_key_saved_at ?? null });
});

// POST /api/backup/recovery-key/ensure — make the key for a destination with no backups yet.
encryptedBackupRouter.post('/recovery-key/ensure', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!personOnly(req, res)) return;
    const existing = await readRecoveryKey(WALNUT_HOME);
    if (existing) return void res.json({ key: existing, created: false });
    const { dest, error } = await requestDestination(req.body);
    if (error) return void res.status(400).json({ error });
    if (dest) {
      const probe = await testDestination(dest, { dataDir: WALNUT_HOME });
      if (!probe.ok) return void res.status(502).json({ error: probe.error });
      // Backups are already there: they need the key that made them, not a new one.
      if (probe.hasBackups) return void res.json({ key: null, needsKey: true });
    }
    const { key, created } = await ensureRecoveryKey(WALNUT_HOME);
    res.json({ key, created });
  } catch (err) {
    next(err);
  }
});

// PUT /api/backup/recovery-key — keep a key the user typed, after it opens the backups.
encryptedBackupRouter.put('/recovery-key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!personOnly(req, res)) return;
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    const { dest, error } = await requestDestination(req.body);
    if (error) return void res.status(400).json({ error });
    if (!dest) return void res.status(400).json({ error: 'Choose where backups go first.' });
    const check = await checkRecoveryKey(dest, key, { dataDir: WALNUT_HOME });
    if (!check.ok) return void res.status(400).json({ error: check.error });
    const canonical = await writeRecoveryKey(WALNUT_HOME, key);
    getBackupScheduler()?.resetAnchor();
    const s = getBackupScheduler();
    if (s) { s.health.errorCode = undefined; s.health.error = undefined; }
    emitStatus();
    res.json({ ok: true, key: canonical, snapshotCount: check.snapshotCount });
  } catch (err) {
    next(err);
  }
});

// POST /api/backup/adopt — this machine becomes the one that writes these backups.
encryptedBackupRouter.post('/adopt', async (req: Request, res: Response) => {
  // It stops another computer's backups: the person's step.
  if (!personOnly(req, res, 'Backups are moved to this computer')) return;
  try {
    const cfg = (await getConfig()).backup ?? {};
    if (!cfg.destination) return void res.status(400).json({ error: 'Choose where backups go first.' });
    await adoptEncryptedBackups(cfg, { dataDir: WALNUT_HOME });
    const s = getBackupScheduler();
    if (s) { s.resetAnchor(); s.health.errorCode = undefined; s.health.error = undefined; s.emitStatus(); }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Google Drive sign-in ───────────────────────────────────────────────────

let connectDone: Promise<{ ok: boolean; error?: string; email?: string }> | null = null;

async function driveClientFor(body: unknown): Promise<OAuthClient | null> {
  const { dest } = await requestDestination(body);
  const sent = body as { client_id?: string; client_secret?: string } | undefined;
  if (sent?.client_id?.trim()) {
    const clientId = sent.client_id.trim();
    let secret = sent.client_secret?.trim();
    // The saved secret stands in only for the saved client.
    if (secret?.includes(MASK)) secret = dest?.client_id === clientId ? dest.client_secret : undefined;
    return resolveOAuthClient({ client_id: clientId, client_secret: secret });
  }
  return resolveOAuthClient({ client_id: dest?.client_id, client_secret: dest?.client_secret });
}

// GET /api/backup/gdrive/status
encryptedBackupRouter.get('/gdrive/status', async (_req: Request, res: Response) => {
  const dest = (await getConfig()).backup?.destination;
  const client = resolveOAuthClient({ client_id: dest?.client_id, client_secret: dest?.client_secret });
  const builtin = resolveOAuthClient({});
  const tokens = await readDriveTokens(WALNUT_HOME);
  res.json({
    builtinClient: Boolean(builtin),
    client: client?.source ?? null,
    connected: Boolean(tokens?.folder_id),
    email: tokens?.email ?? null,
    folderName: tokens?.folder_name ?? null,
    connectedAt: tokens?.connected_at ?? null,
    pending: connectDone !== null,
  });
});

// POST /api/backup/gdrive/connect — returns Google's sign-in address; the browser opens it.
encryptedBackupRouter.post('/gdrive/connect', async (req: Request, res: Response) => {
  if (!personOnly(req, res, 'Google Drive is connected')) return;
  try {
    const client = await driveClientFor(req.body);
    if (!client) {
      return void res.status(400).json({ error: 'Add your Google client ID and secret first (steps below).', code: 'no_client' });
    }
    const folderName = ((await getConfig()).backup?.destination?.folder_name || DEFAULT_DRIVE_FOLDER).trim();
    let settle: (r: { ok: boolean; error?: string; email?: string }) => void = () => {};
    const mine: NonNullable<typeof connectDone> = new Promise((r) => { settle = r; });
    connectDone = mine;
    let started: Awaited<ReturnType<typeof startDriveConnect>>;
    try {
      started = await startDriveConnect(client, {
        onDone: (outcome) => {
          void (async () => {
            try {
              if (!outcome.ok) throw new Error(outcome.error);
              let tokens = outcome.tokens;
              await writeDriveTokens(WALNUT_HOME, tokens);
              const getToken = makeAccessTokenGetter(WALNUT_HOME, client);
              const about = await driveAbout(getToken).catch(() => ({} as { email?: string }));
              const folder = await findOrCreateFolder(folderName, getToken);
              tokens = { ...(await readDriveTokens(WALNUT_HOME))!, email: about.email, folder_id: folder.id, folder_name: folderName };
              await writeDriveTokens(WALNUT_HOME, tokens);
              getBackupScheduler()?.resetAnchor();
              log.web.info('backup: google drive connected', { folderCreated: folder.created });
              settle({ ok: true, email: about.email });
              getBackupScheduler()?.emitStatus();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.web.warn('backup: google drive connect failed', { error: msg });
              settle({ ok: false, error: msg });
            }
          })();
        },
      });
    } catch (err) {
      // No sign-in under way: nothing must read as pending.
      settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
      // Only this attempt's own wait goes: a newer sign-in under way stays pending.
      if (connectDone === mine) connectDone = null;
      throw err;
    }
    void mine.then((r) => {
      if (connectDone === mine) connectDone = null;
      broadcastDrive(r);
    });
    res.json({ authUrl: started.authUrl, redirectUri: started.redirectUri });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

let broadcastDrive: (r: { ok: boolean; error?: string; email?: string }) => void = () => {};
export function setDriveEventEmitter(emit: (name: string, data: unknown) => void): void {
  broadcastDrive = (r) => emit('backup:gdrive', { connected: r.ok, email: r.email ?? null, error: r.error ?? null });
}

// POST /api/backup/gdrive/complete — the browser was on another device: paste the address it landed on.
encryptedBackupRouter.post('/gdrive/complete', async (req: Request, res: Response) => {
  if (!personOnly(req, res, 'Google Drive is connected')) return;
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return void res.status(400).json({ error: 'Paste the whole address from the browser.' });
  try {
    const waiting = connectDone;
    await completeDriveConnectFromUrl(url);
    const outcome = waiting ? await waiting : { ok: true };
    if (!outcome.ok) return void res.status(502).json({ error: outcome.error });
    res.json({ ok: true, email: (outcome as { email?: string }).email ?? null });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/backup/gdrive/disconnect — sign out here (backups already in Drive stay).
encryptedBackupRouter.post('/gdrive/disconnect', async (req: Request, res: Response) => {
  if (!personOnly(req, res, 'Google Drive is disconnected')) return;
  await revokeDriveTokens(WALNUT_HOME).catch(() => {});
  getBackupScheduler()?.resetAnchor();
  emitStatus();
  res.json({ ok: true });
});
