/**
 * Encrypted backups through the real routes and scheduler, for every
 * destination kind: an S3-protocol server (R2's shape) and Google Drive (a
 * fake Google: OAuth with PKCE, then Drive v3). Each path: test the
 * destination, make the recovery key, back up, list, restore into a fresh
 * folder, and compare the restored files with the data home.
 *
 * Also the safety rules: a second machine's key is refused and never
 * replaced, restore never writes into the data home, masked secrets only
 * stand for the saved target, and the legacy S3 copy is untouched by all this.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('backup-routes'));

import { WALNUT_HOME } from '../../src/constants.js';
import { updateConfig, getConfig } from '../../src/core/config-manager.js';
import { backupRouter, setBackupScheduler } from '../../src/web/routes/backup.js';
import { encryptedBackupRouter, setDriveEventEmitter } from '../../src/web/routes/backup-encrypted.js';
import { startBackupScheduler, type BackupSchedulerHandle } from '../../src/core/backup/backup-scheduler.js';
import { startFakeS3, type FakeS3 } from '../helpers/fake-s3-server.js';
import { startFakeGoogleDrive } from '../helpers/fake-google-drive.js';
import { generateRecoveryKey } from '../../src/core/backup/repo/crypto.js';
import { recoveryKeyPath } from '../../src/core/backup/recovery-key.js';

let server: Server;
let base: string;
let s3: FakeS3;
let google: Awaited<ReturnType<typeof startFakeGoogleDrive>>;
let scheduler: BackupSchedulerHandle;
const events: Array<{ name: string; data: unknown }> = [];

async function call<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/backup${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

async function seed(): Promise<void> {
  await fsp.mkdir(path.join(WALNUT_HOME, 'notes', 'trips'), { recursive: true });
  await fsp.writeFile(path.join(WALNUT_HOME, 'notes', 'trips', 'kyoto.md'), '# Kyoto\n'.repeat(500));
  await fsp.writeFile(path.join(WALNUT_HOME, 'auth.json'), '{"device":"secret-token"}');
}

async function sameFile(restored: string, rel: string): Promise<boolean> {
  const [a, b] = await Promise.all([fsp.readFile(path.join(WALNUT_HOME, rel)), fsp.readFile(path.join(restored, rel))]);
  return a.equals(b);
}

beforeAll(async () => {
  s3 = await startFakeS3({ buckets: ['walnut-r2'] });
  google = await startFakeGoogleDrive();
  for (const [k, v] of Object.entries(google.env)) process.env[k] = v as string;
  const app = express();
  app.use(express.json());
  app.use('/api/backup', backupRouter);
  app.use('/api/backup', encryptedBackupRouter);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const emit = (name: string, data: unknown) => events.push({ name, data: JSON.parse(JSON.stringify(data)) });
  scheduler = startBackupScheduler({ emit, notify: async () => true, dataDir: WALNUT_HOME });
  setBackupScheduler(scheduler);
  setDriveEventEmitter(emit);
  await seed();
});

afterAll(async () => {
  scheduler?.stop();
  setBackupScheduler(null);
  await new Promise<void>((r) => server.close(() => r()));
  await s3.close();
  await google.close();
  for (const k of Object.keys(google.env)) delete process.env[k];
});

const r2 = () => ({
  type: 'r2' as const, bucket: 'walnut-r2', endpoint: s3.url, access_key_id: 'AKTEST', secret_access_key: 'secret-value',
});

describe('encrypted backups through the routes', () => {
  it('R2-shaped destination: test, key, back up, list, restore', async () => {
    const t = await call('POST', '/destination/test', { destination: r2() });
    expect(t.body).toMatchObject({ ok: true, canWrite: true, hasBackups: false, hasKey: false });

    // No config saved yet: the run route refuses plainly.
    expect((await call('POST', '/run')).status).toBe(400);

    await updateConfig({ backup: { enabled: true, interval_hours: 24, destination: r2() } } as never);
    const k = await call<{ key: string; created: boolean }>('POST', '/recovery-key/ensure', {});
    expect(k.body.created).toBe(true);
    expect(k.body.key).toMatch(/^WB1-/);
    const mode = (await fsp.stat(recoveryKeyPath(WALNUT_HOME))).mode & 0o777;
    expect(mode).toBe(0o600);

    expect((await call('POST', '/run')).status).toBe(202);
    await until(() => !scheduler.health.running && !!scheduler.health.lastSnapshotId);
    expect(scheduler.health.error).toBeUndefined();
    expect(scheduler.health.engine).toBe('encrypted');
    // Nothing went up in the clear.
    for (const obj of s3.objects.values()) expect(obj.body.includes(Buffer.from('secret-token'))).toBe(false);

    const list = await call<{ snapshots: Array<{ id: string; fileCount: number }> }>('POST', '/snapshots', {});
    expect(list.body.snapshots).toHaveLength(1);

    // Restore never writes into the data home.
    expect((await call('POST', '/restore', { snapshotId: 'latest', targetDir: path.join(WALNUT_HOME, 'restored') })).status).toBe(400);
    const target = `${WALNUT_HOME}-restored-r2`;
    expect((await call('POST', '/restore', { snapshotId: list.body.snapshots[0].id, targetDir: target })).status).toBe(202);
    await until(() => scheduler.health.restore?.running === false && !!scheduler.health.restore.finishedAt);
    expect(scheduler.health.restore?.error).toBeUndefined();
    expect(await sameFile(target, 'notes/trips/kyoto.md')).toBe(true);
    expect(await sameFile(target, 'auth.json')).toBe(true);
    // The recovery key rides inside the (encrypted) backup, so the restored home can keep backing up.
    expect((await fsp.readFile(recoveryKeyPath(target), 'utf8')).trim()).toBe(k.body.key);
    // A second restore into the same folder is refused: it is not empty any more.
    await call('POST', '/restore', { snapshotId: 'latest', targetDir: target });
    await until(() => scheduler.health.restore?.running === false);
    expect(scheduler.health.restore?.error).toMatch(/not empty/);
  }, 60_000);

  it('masked secrets stand only for the saved target', async () => {
    const masked = { ...r2(), secret_access_key: '••••••alue' };
    expect((await call('POST', '/destination/test', { destination: masked })).body).toMatchObject({ ok: true });
    const other = { ...masked, bucket: 'someone-elses-bucket' };
    const r = await call('POST', '/destination/test', { destination: other });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/Type the keys/);
  });

  it('a new machine with another key is asked for the saved key, and the backups are never replaced', async () => {
    const realKey = (await fsp.readFile(recoveryKeyPath(WALNUT_HOME), 'utf8')).trim();
    await fsp.rm(recoveryKeyPath(WALNUT_HOME));
    // No key here, backups there: ensure asks for the key instead of making one.
    const e = await call('POST', '/recovery-key/ensure', {});
    expect(e.body).toMatchObject({ key: null, needsKey: true });
    // A scheduled run refuses too, and does not create a key.
    scheduler.resetAnchor();
    expect((await call('POST', '/run')).status).toBe(202);
    await until(() => !scheduler.health.running && scheduler.health.consecutiveFailures > 0);
    expect(scheduler.health.errorCode).toBe('key_mismatch');
    await expect(fsp.stat(recoveryKeyPath(WALNUT_HOME))).rejects.toThrow();
    // A wrong key is refused, the right one is kept.
    const wrong = await call('PUT', '/recovery-key', { key: generateRecoveryKey() });
    expect(wrong.status).toBe(400);
    const right = await call<{ ok: boolean; snapshotCount: number }>('PUT', '/recovery-key', { key: realKey.toLowerCase() });
    expect(right.body).toMatchObject({ ok: true, snapshotCount: 1 });
    expect((await call('GET', '/recovery-key')).body).toMatchObject({ key: realKey });
  }, 60_000);

  it('Google Drive: connect with PKCE, back up into its folder, restore', async () => {
    const before = await call('GET', '/gdrive/status');
    expect(before.body).toMatchObject({ builtinClient: true, connected: false });
    await updateConfig({ backup: { ...(await getConfig()).backup, destination: { type: 'gdrive' } } } as never);
    const c = await call<{ authUrl: string }>('POST', '/gdrive/connect', {});
    expect(c.body.authUrl).toContain('code_challenge_method=S256');
    expect(c.body.authUrl).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive.file'));
    // The fake consents at once and sends the browser to the loopback listener.
    const consent = await fetch(c.body.authUrl, { redirect: 'follow' });
    expect(consent.ok).toBe(true);
    await until(() => events.some((e) => e.name === 'backup:gdrive'));
    expect(events.find((e) => e.name === 'backup:gdrive')!.data).toMatchObject({ connected: true });
    const after = await call('GET', '/gdrive/status');
    expect(after.body).toMatchObject({ connected: true, folderName: 'Walnut Backup' });

    // Same recovery key as before (this machine has one); Drive gets a new repository.
    scheduler.resetAnchor();
    expect((await call('POST', '/run')).status).toBe(202);
    await until(() => !scheduler.health.running && scheduler.health.consecutiveFailures === 0 && scheduler.health.destination === 'Google Drive: Walnut Backup' && !!scheduler.health.lastBackupAt);
    const names = google.files().map((f) => f.name);
    expect(names).toContain('walnut-backup.json');
    expect(names.some((n) => n.startsWith('snapshots/'))).toBe(true);
    expect(google.files().filter((f) => f.mimeType === 'application/vnd.google-apps.folder')).toHaveLength(1);

    const target = `${WALNUT_HOME}-restored-drive`;
    expect((await call('POST', '/restore', { snapshotId: 'latest', targetDir: target })).status).toBe(202);
    await until(() => scheduler.health.restore?.running === false && scheduler.health.restore.targetDir === target);
    expect(scheduler.health.restore?.error).toBeUndefined();
    expect(await sameFile(target, 'notes/trips/kyoto.md')).toBe(true);

    const d = await call('POST', '/gdrive/disconnect', {});
    expect(d.body).toMatchObject({ ok: true });
    expect((await call('GET', '/gdrive/status')).body).toMatchObject({ connected: false });
  }, 60_000);

  it('the older S3 copy keeps its own engine', async () => {
    await updateConfig({ backup: { enabled: true, bucket: 'legacy-bucket', region: 'us-west-2' } } as never);
    scheduler.resetAnchor();
    const { isBackupConfigured } = await import('../../src/core/backup/backup-scheduler.js');
    expect(await isBackupConfigured((await getConfig()).backup, WALNUT_HOME)).toBe(true);
    const { engineOf } = await import('../../src/core/backup/destination.js');
    expect(engineOf((await getConfig()).backup)).toBe('mirror');
    // An encrypted config never carries the legacy bucket, so an older Walnut reads it as not configured.
    await updateConfig({ backup: { enabled: true, destination: r2() } } as never);
    const cfg = (await getConfig()).backup!;
    expect(cfg.bucket).toBeUndefined();
    expect(Boolean(cfg.enabled && cfg.bucket)).toBe(false);
  });
});
