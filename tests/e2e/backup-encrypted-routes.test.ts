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

async function call<T = Record<string, unknown>>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/backup${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
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

    // Nothing goes up before the user said the key is kept.
    const early = await call('POST', '/run');
    expect(early.status).toBe(400);
    expect(early.body).toMatchObject({ code: 'key_not_saved' });
    await updateConfig({ backup: { ...(await getConfig()).backup, recovery_key_saved_at: new Date().toISOString() } } as never);

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
    // The result says where it came from (the pane may show another service by then).
    expect(scheduler.health.restore?.source).toBe('Cloudflare R2');
    expect(await sameFile(target, 'notes/trips/kyoto.md')).toBe(true);
    expect(await sameFile(target, 'auth.json')).toBe(true);
    // The recovery key rides inside the (encrypted) backup, so the restored home can keep backing up.
    expect((await fsp.readFile(recoveryKeyPath(target), 'utf8')).trim()).toBe(k.body.key);
    // A second restore into the same folder is refused at once: it is not empty any more.
    const again = await call('POST', '/restore', { snapshotId: 'latest', targetDir: target });
    expect(again.status).toBe(400);
    expect(String(again.body.error)).toMatch(/not empty/);
    // A folder Walnut cannot make is said at once, in words.
    const nowhere = await call('POST', '/restore', { snapshotId: 'latest', targetDir: '/proc/walnut-cannot-make-this' });
    expect(nowhere.status).toBe(400);
    expect(String(nowhere.body.error)).toMatch(/can't make a folder|may not make a folder/);
    expect(String(nowhere.body.error)).not.toMatch(/ENOENT|EACCES/);
    // A second "Back up now" while one runs joins it: never an error.
    const [r1, r2run] = await Promise.all([call('POST', '/run'), call('POST', '/run')]);
    expect([r1.status, r2run.status]).toEqual([202, 202]);
    await until(() => !scheduler.health.running);

    // "Use this restored data": only the folder of the restore just finished, asked now, done at the next start.
    expect((await call('POST', '/restore/use', { targetDir: `${WALNUT_HOME}-elsewhere` })).status).toBe(400);
    expect((await call('POST', '/restore/use', { targetDir: target }, { 'x-walnut-caller-sid': 'session-under-test' })).status).toBe(403);
    const use = await call<{ ok: boolean; restarting: boolean; aside: string }>('POST', '/restore/use', { targetDir: target });
    expect(use.body).toMatchObject({ ok: true, restarting: false });
    expect(use.body.aside.startsWith(`${WALNUT_HOME}-before-restore-`)).toBe(true);
    const st = await call<{ pendingSwitch: { restored: string } | null }>('GET', '/status');
    expect(st.body.pendingSwitch?.restored).toBe(path.resolve(target));
    // Nothing moved while this Walnut runs.
    expect(await sameFile(target, 'notes/trips/kyoto.md')).toBe(true);
    expect((await call('POST', '/restore/use/cancel', {})).status).toBe(200);
    expect((await call<{ pendingSwitch: unknown }>('GET', '/status')).body.pendingSwitch).toBeNull();
  }, 60_000);

  it('a service chosen while Walnut runs, or backups moved here, back up at the next check', async () => {
    // Reading the status as it is changes nothing.
    await call('GET', '/status');
    expect(scheduler.health.dueNow).toBeUndefined();
    const before = (await getConfig()).backup!;
    await updateConfig({ backup: { ...before, destination: { ...r2(), prefix: 'walnut-moved' } } } as never);
    const st = await call<{ dueNow?: boolean }>('GET', '/status');
    expect(st.body.dueNow).toBe(true);
    // A run clears it.
    expect((await call('POST', '/run')).status).toBe(202);
    await until(() => !scheduler.health.running && scheduler.health.dueNow === undefined);
    // Moving the backups here (after the confirm in the pane) runs one soon too.
    expect((await call('POST', '/adopt', {})).status).toBe(200);
    expect((await call<{ dueNow?: boolean }>('GET', '/status')).body.dueNow).toBe(true);
    expect((await call('POST', '/run')).status).toBe(202);
    await until(() => !scheduler.health.running && scheduler.health.dueNow === undefined);
    // Back to the first folder: a switch too, so it runs once more (and leaves nothing pending for the tests after).
    await updateConfig({ backup: before } as never);
    expect((await call<{ dueNow?: boolean }>('GET', '/status')).body.dueNow).toBe(true);
    expect((await call('POST', '/run')).status).toBe(202);
    await until(() => !scheduler.health.running && scheduler.health.dueNow === undefined);
  }, 60_000);

  it('a restore under way can be cancelled: it stops and the folder it was writing goes', async () => {
    // Nothing to cancel: said plainly; a session may not cancel the person's restore.
    expect((await call('POST', '/restore/cancel', {})).status).toBe(400);
    const target = `${WALNUT_HOME}-restored-cancel`;
    s3.setGetDelay(1500);
    try {
      expect((await call('POST', '/restore', { snapshotId: 'latest', targetDir: target })).status).toBe(202);
      await until(() => scheduler.health.restore?.running === true);
      expect((await call('POST', '/restore/cancel', {}, { 'x-walnut-caller-sid': 'session-under-test' })).status).toBe(403);
      expect((await call('POST', '/restore/cancel', {})).body).toMatchObject({ ok: true });
      await until(() => scheduler.health.restore?.running === false);
    } finally {
      s3.setGetDelay(0);
    }
    expect(scheduler.health.restore).toMatchObject({ cancelled: true, targetDir: target });
    expect(scheduler.health.restore?.error).toBeUndefined();
    expect(await fsp.stat(target).then(() => true, () => false)).toBe(false);
    // A cancelled restore is never switched in.
    expect((await call('POST', '/restore/use', { targetDir: target })).status).toBe(400);
    expect((await call('POST', '/restore/dismiss', {})).status).toBe(200);
  }, 60_000);

  it('masked secrets stand only for the saved service account', async () => {
    const masked = { ...r2(), secret_access_key: '••••••alue' };
    expect((await call('POST', '/destination/test', { destination: masked })).body).toMatchObject({ ok: true });
    // Another bucket in the same account: the saved key is that account's, so it goes with it.
    const otherBucket = await call('POST', '/destination/test', { destination: { ...masked, bucket: 'another-bucket-here' } });
    expect(otherBucket.status).toBe(200);
    expect(String(otherBucket.body.error ?? '')).not.toMatch(/Type the keys/);
    // Another endpoint: never sent there.
    const r = await call('POST', '/destination/test', { destination: { ...masked, endpoint: 'http://127.0.0.1:1' } });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/Type the keys/);
  });

  it('a session (not the person) cannot sign in, point backups elsewhere, or restore from another key', async () => {
    const agent = { 'x-walnut-caller-sid': 'session-under-test' };
    for (const [method, route, body] of [
      ['POST', '/gdrive/connect', {}],
      ['POST', '/gdrive/complete', { url: 'http://127.0.0.1:1/?code=x&state=y' }],
      ['POST', '/gdrive/disconnect', {}],
      ['POST', '/destination/test', { destination: { ...r2(), bucket: 'elsewhere' } }],
      ['POST', '/snapshots', { recoveryKey: generateRecoveryKey() }],
      ['POST', '/restore', { recoveryKey: generateRecoveryKey(), targetDir: `${WALNUT_HOME}-agent-restore` }],
      ['GET', '/recovery-key', undefined],
      ['POST', '/restore/use/delete-previous', {}],
    ] as const) {
      const r = await call(method, route, body, agent);
      expect(r.status, `${method} ${route}`).toBe(403);
      expect(r.body).toMatchObject({ code: 'person_at_this_machine' });
    }
    // The saved destination it may still read.
    expect((await call('POST', '/destination/test', {}, agent)).body).toMatchObject({ ok: true });
  });

  it('delete-previous with no finished switch deletes nothing and says why', async () => {
    const r = await call('POST', '/restore/use/delete-previous', {});
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/No data set aside/);
    expect((await fsp.stat(WALNUT_HOME)).isDirectory()).toBe(true);
  });

  it('a restore target reached through a symlink into the data home is refused', async () => {
    const link = `${WALNUT_HOME}-link`;
    await fsp.symlink(WALNUT_HOME, link);
    try {
      const r = await call('POST', '/restore', { snapshotId: 'latest', targetDir: path.join(link, 'inside') });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/never writes into the data folder/);
    } finally {
      await fsp.rm(link);
    }
  });

  it('masked keys nested under auth are restored for the saved S3 account only', async () => {
    const saved = (await getConfig()).backup!;
    const s3dest = {
      type: 's3' as const, bucket: 'walnut-r2', endpoint: s3.url, region: 'us-east-1',
      auth: { method: 'access_keys' as const, aws_access_key_id: 'AKTEST', aws_secret_access_key: 'nested-secret' },
    };
    await updateConfig({ backup: { ...saved, destination: s3dest } } as never);
    try {
      const masked = { ...s3dest, auth: { ...s3dest.auth, aws_secret_access_key: '••••••cret' } };
      const t = await call('POST', '/destination/test', { destination: masked });
      expect(t.body, JSON.stringify(t.body)).toMatchObject({ ok: true, canWrite: true });
      const other = await call('POST', '/destination/test', { destination: { ...masked, endpoint: 'http://127.0.0.1:1' } });
      expect(other.status).toBe(400);
    } finally {
      await updateConfig({ backup: saved } as never);
    }
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
    expect(right.body).toMatchObject({ ok: true });
    expect(right.body.snapshotCount).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/recovery-key')).body).toMatchObject({ key: realKey });
  }, 60_000);

  it('a Google client file saved on this machine: the pane names it and Connect uses it, nothing filled in', async () => {
    const { machineClientPath } = await import('../../src/core/backup/gdrive-oauth.js');
    const file = machineClientPath(WALNUT_HOME);
    const envId = process.env.WALNUT_GDRIVE_CLIENT_ID!;
    const envSecret = process.env.WALNUT_GDRIVE_CLIENT_SECRET!;
    delete process.env.WALNUT_GDRIVE_CLIENT_ID;
    delete process.env.WALNUT_GDRIVE_CLIENT_SECRET;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify({ installed: { client_id: envId, client_secret: envSecret } }), { mode: 0o600 });
      expect((await call('GET', '/gdrive/status')).body).toMatchObject({ builtinClient: true, client: 'builtin', machineClientFile: file });
      const c = await call<{ authUrl: string }>('POST', '/gdrive/connect', {});
      expect(new URL(c.body.authUrl).searchParams.get('client_id')).toBe(envId);
      expect((await call('POST', '/gdrive/connect/cancel', {})).body).toMatchObject({ ok: true, cancelled: true });
    } finally {
      await fsp.rm(file, { force: true });
      process.env.WALNUT_GDRIVE_CLIENT_ID = envId;
      process.env.WALNUT_GDRIVE_CLIENT_SECRET = envSecret;
    }
    // Without the file the status says nothing of one.
    expect((await call('GET', '/gdrive/status')).body).not.toHaveProperty('machineClientFile');
  });

  it('Google Drive: connect with PKCE, back up into its folder, restore', async () => {
    const before = await call('GET', '/gdrive/status');
    expect(before.body).toMatchObject({ builtinClient: true, connected: false });
    await updateConfig({ backup: { ...(await getConfig()).backup, destination: { type: 'gdrive' } } } as never);
    const c = await call<{ authUrl: string }>('POST', '/gdrive/connect', {});
    expect(c.body.authUrl).toContain('code_challenge_method=S256');
    expect(c.body.authUrl).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive.file'));
    // While it waits, a reloaded pane can open the same Google page again.
    expect((await call('GET', '/gdrive/status')).body).toMatchObject({ pending: true, authUrl: c.body.authUrl });
    // The fake consents at once and sends the browser to the loopback listener.
    const consent = await fetch(c.body.authUrl, { redirect: 'follow' });
    expect(consent.ok).toBe(true);
    await until(() => events.some((e) => e.name === 'backup:gdrive'));
    expect(events.find((e) => e.name === 'backup:gdrive')!.data).toMatchObject({ connected: true });
    const after = await call('GET', '/gdrive/status');
    // Signed in with Walnut's own client: the pane says nothing about a client of the user's.
    expect(after.body).toMatchObject({ connected: true, folderName: 'Walnut Backup', signedInWith: 'builtin' });
    // The client it signed in with gone (env cleared here; a removed client file the same):
    // the pane is told the token can no longer be refreshed, never that it is the user's own client.
    const envId = process.env.WALNUT_GDRIVE_CLIENT_ID;
    delete process.env.WALNUT_GDRIVE_CLIENT_ID;
    try {
      expect((await call('GET', '/gdrive/status')).body).toMatchObject({ connected: true, signedInWith: 'missing', builtinClient: false });
    } finally {
      process.env.WALNUT_GDRIVE_CLIENT_ID = envId;
    }

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

    // An empty folder field restores into the folder the pane showed, when it has the default's shape beside the data.
    const beside = path.dirname(path.resolve(WALNUT_HOME));
    const shown = path.join(beside, 'open-walnut-restored-2026-11-04T10-00-00');
    expect((await call('POST', '/restore', { snapshotId: 'latest', suggestedDir: shown })).status).toBe(202);
    await until(() => scheduler.health.restore?.running === false && scheduler.health.restore.targetDir === shown);
    expect(await sameFile(shown, 'notes/trips/kyoto.md')).toBe(true);
    // Any other folder named that way is not taken from it: the default name is used instead.
    expect((await call('POST', '/restore', { snapshotId: 'latest', suggestedDir: path.join(WALNUT_HOME, 'open-walnut-restored-2026-11-04T10-00-01') })).status).toBe(202);
    await until(() => scheduler.health.restore?.running === false && scheduler.health.restore.targetDir !== shown);
    expect(path.dirname(scheduler.health.restore!.targetDir!)).toBe(beside);
    expect(path.basename(scheduler.health.restore!.targetDir!)).not.toBe('open-walnut-restored-2026-11-04T10-00-01');
    // A server nobody supervises cannot restart itself: the pane says "next start".
    expect((await call('GET', '/status')).body).toMatchObject({ canRestart: false });

    const d = await call('POST', '/gdrive/disconnect', {});
    expect(d.body).toMatchObject({ ok: true });
    expect((await call('GET', '/gdrive/status')).body).toMatchObject({ connected: false });

    // A sign-in the person gave up on ends on the server: a reloaded pane never shows it waiting.
    expect((await call('POST', '/gdrive/connect', {})).status).toBe(200);
    expect((await call('GET', '/gdrive/status')).body).toMatchObject({ pending: true });
    expect((await call('POST', '/gdrive/connect/cancel', {})).body).toMatchObject({ ok: true, cancelled: true });
    await until(async () => (await call<{ pending: boolean }>('GET', '/gdrive/status')).body.pending === false);
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
    // Both at once (a hand edit, an API call): the legacy bucket is dropped, so an
    // older Walnut never mirrors the home to it in the clear.
    await updateConfig({ backup: { enabled: true, bucket: 'legacy-bucket', destination: r2() } } as never);
    expect((await getConfig()).backup!.bucket).toBeUndefined();
  });
});
