import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  BUILTIN_GOOGLE_CLIENT,
  DRIVE_SCOPE,
  completeDriveConnectFromUrl,
  makeAccessTokenGetter,
  readDriveTokens,
  resolveOAuthClient,
  revokeDriveTokens,
  startDriveConnect,
  writeDriveTokens,
  type DriveTokens,
  type OAuthClient,
} from '../../../src/core/backup/gdrive-oauth.js';
import { startFakeGoogleDrive, type FakeGoogleDrive } from '../../helpers/fake-google-drive.js';

type ConnectResult = { ok: true; tokens: DriveTokens } | { ok: false; error: string };

let fake: FakeGoogleDrive;
let client: OAuthClient;
let dataDir: string;
let savedEnv: NodeJS.ProcessEnv;
const tokenFile = () => path.join(dataDir, 'local', 'backup', 'gdrive-token.json');

beforeEach(async () => {
  savedEnv = { ...process.env };
  fake = await startFakeGoogleDrive();
  Object.assign(process.env, fake.env);
  client = { clientId: fake.env.WALNUT_GDRIVE_CLIENT_ID, clientSecret: fake.env.WALNUT_GDRIVE_CLIENT_SECRET, source: 'builtin' };
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-gdrive-oauth-'));
});

afterEach(async () => {
  process.env = savedEnv;
  await fake.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

/** Starts a connect and returns its result as a promise. */
async function connect(timeoutMs?: number) {
  let resolveDone!: (r: ConnectResult) => void;
  const done = new Promise<ConnectResult>((r) => { resolveDone = r; });
  const started = await startDriveConnect(client, { onDone: resolveDone, timeoutMs });
  return { ...started, done };
}

/** What Google would send the browser to after "Allow". */
async function consentRedirect(authUrl: string): Promise<string> {
  const resp = await fetch(authUrl, { redirect: 'manual' });
  expect(resp.status).toBe(302);
  return resp.headers.get('location')!;
}

async function listenerGone(redirectUri: string): Promise<boolean> {
  return fetch(redirectUri, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true);
}

describe('startDriveConnect', () => {
  it('runs the loopback flow with PKCE and hands back tokens', async () => {
    const c = await connect();
    expect(c.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const auth = new URL(c.authUrl);
    expect(auth.origin + auth.pathname).toBe(fake.env.WALNUT_GDRIVE_AUTH_URL);
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      client_id: client.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: DRIVE_SCOPE,
      access_type: 'offline', prompt: 'consent', state: c.state, code_challenge_method: 'S256',
    });
    expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const landing = await consentRedirect(c.authUrl);
    expect(landing.startsWith(`${c.redirectUri}/?`)).toBe(true);
    const page = await fetch(landing);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Walnut is connected to Google Drive. You can close this tab and go back to Walnut.');

    const r = await c.done;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.refresh_token).toMatch(/^1\/\/fake-/);
    expect(r.tokens.access_token).toBeTruthy();
    expect(r.tokens.client_id).toBe(client.clientId);
    expect(r.tokens.scope).toBe(DRIVE_SCOPE);
    expect(r.tokens.expires_at!).toBeGreaterThan(Date.now());
    expect(r.tokens.email).toBeUndefined();
    expect(await readDriveTokens(dataDir)).toBeNull(); // the caller persists
    expect(await listenerGone(c.redirectUri)).toBe(true);
  });

  it('works through the fake consent page', async () => {
    await fake.close();
    fake = await startFakeGoogleDrive({ consentPage: true });
    Object.assign(process.env, fake.env);
    const c = await connect();
    const html = await (await fetch(c.authUrl)).text();
    expect(html).toContain('Sign in with Google (test)');
    expect(html).toContain('See, edit, create, and delete only the specific Google Drive files you use with this app');
    const allow = /id="allow" href="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');
    expect((await fetch(allow)).status).toBe(200);
    expect((await c.done).ok).toBe(true);
  });

  it('answers a wrong or missing state with 400 and keeps listening', async () => {
    const c = await connect();
    expect((await fetch(`${c.redirectUri}/?state=wrong&code=x`)).status).toBe(400);
    expect((await fetch(`${c.redirectUri}/favicon.ico`)).status).toBe(400);
    expect((await fetch(c.redirectUri, { method: 'POST', body: `state=${c.state}` })).status).toBe(400);
    const page = await fetch(await consentRedirect(c.authUrl));
    expect(page.status).toBe(200);
    expect((await c.done).ok).toBe(true);
  });

  it('reports access_denied in plain words', async () => {
    const c = await connect();
    const page = await fetch(`${c.redirectUri}/?state=${c.state}&error=access_denied`);
    expect(await page.text()).toContain('Walnut was not allowed to use Google Drive');
    const r = await c.done;
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/cancelled/) });
    expect(await listenerGone(c.redirectUri)).toBe(true);
  });

  it('times out with an error and closes the listener', async () => {
    const c = await connect(50);
    const r = await c.done;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Sign-in timed out/);
    expect(await listenerGone(c.redirectUri)).toBe(true);
  });

  it('a new connect silently replaces the pending one', async () => {
    let firstDone = false;
    const first = await startDriveConnect(client, { onDone: () => { firstDone = true; } });
    const second = await connect();
    expect(await listenerGone(first.redirectUri)).toBe(true);
    await expect(completeDriveConnectFromUrl(await consentRedirect(first.authUrl))).rejects.toThrow(/no longer waiting/);
    await fetch(await consentRedirect(second.authUrl));
    expect((await second.done).ok).toBe(true);
    expect(firstDone).toBe(false);
  });
});

describe('completeDriveConnectFromUrl', () => {
  it('finishes from the pasted address and closes the listener', async () => {
    const c = await connect();
    const landing = await consentRedirect(c.authUrl);
    const tokens = await completeDriveConnectFromUrl(`  ${landing}\n`);
    expect(tokens.refresh_token).toBeTruthy();
    const r = await c.done;
    expect(r.ok && r.tokens.refresh_token).toBe(tokens.refresh_token);
    expect(await listenerGone(c.redirectUri)).toBe(true);
    await expect(completeDriveConnectFromUrl(landing)).rejects.toThrow(/no longer waiting/);
  });

  it('accepts just the query part', async () => {
    const c = await connect();
    const query = new URL(await consentRedirect(c.authUrl)).search.slice(1);
    expect((await completeDriveConnectFromUrl(query)).refresh_token).toBeTruthy();
    expect((await c.done).ok).toBe(true);
  });

  it('rejects an address without sign-in details', async () => {
    const c = await connect();
    await expect(completeDriveConnectFromUrl('http://127.0.0.1:1/')).rejects.toThrow(/no sign-in details/);
    await expect(completeDriveConnectFromUrl(`http://127.0.0.1:1/?state=${c.state}`)).rejects.toThrow(/no sign-in code/);
    await expect(completeDriveConnectFromUrl('state=other&code=x')).rejects.toThrow(/no longer waiting/);
    // Still pending after the bad pastes.
    await fetch(await consentRedirect(c.authUrl));
    expect((await c.done).ok).toBe(true);
  });
});

describe('tokens', () => {
  async function connectedTokens(): Promise<DriveTokens> {
    const c = await connect();
    return completeDriveConnectFromUrl(await consentRedirect(c.authUrl));
  }
  const tokenRequests = () => fake.requests.filter((r) => r.startsWith('POST /token')).length;

  it('refreshes an expired access token, persists it 0600, and keeps other fields', async () => {
    const t = await connectedTokens();
    await writeDriveTokens(dataDir, { ...t, access_token: 'ya29.old', expires_at: Date.now() - 1000, email: 'a@example.com', folder_id: 'F1', folder_name: 'Walnut Backup' });
    const getter = makeAccessTokenGetter(dataDir, client);
    const before = tokenRequests();
    const fresh = await getter();
    expect(fresh).not.toBe('ya29.old');
    expect(tokenRequests()).toBe(before + 1);
    expect(await getter()).toBe(fresh); // cached
    expect(tokenRequests()).toBe(before + 1);

    const saved = (await readDriveTokens(dataDir))!;
    expect(saved).toMatchObject({ access_token: fresh, refresh_token: t.refresh_token, email: 'a@example.com', folder_id: 'F1', folder_name: 'Walnut Backup' });
    expect((await fsp.stat(tokenFile())).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.dirname(tokenFile()))).mode & 0o777).toBe(0o700);
    expect((await fsp.readdir(path.dirname(tokenFile()))).filter((n) => n.includes('.tmp-'))).toEqual([]);

    // A forced refresh, asked three times at once, is one request.
    const forced = await Promise.all([getter(true), getter(true), getter(true)]);
    expect(new Set(forced).size).toBe(1);
    expect(forced[0]).not.toBe(fresh);
    expect(tokenRequests()).toBe(before + 2);
  });

  it('refreshes when the token is inside the 60 s margin', async () => {
    const t = await connectedTokens();
    await writeDriveTokens(dataDir, { ...t, expires_at: Date.now() + 30_000 });
    expect(await makeAccessTokenGetter(dataDir, client)()).not.toBe(t.access_token);
  });

  it('turns invalid_grant into DriveAuthError', async () => {
    const t = await connectedTokens();
    await writeDriveTokens(dataDir, { ...t, refresh_token: '1//unknown', expires_at: 0 });
    const err = await makeAccessTokenGetter(dataDir, client)().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('DriveAuthError');
    expect((err as Error).message).toMatch(/revoked or has expired.*Connect Google Drive/);
    expect((err as Error).message).not.toContain('1//unknown');
  });

  it('revoke tells Google and deletes the file', async () => {
    const t = await connectedTokens();
    await writeDriveTokens(dataDir, t);
    await revokeDriveTokens(dataDir);
    expect(fake.requests).toContain('POST /revoke');
    expect(await readDriveTokens(dataDir)).toBeNull();
    // The grant is gone at Google too.
    await writeDriveTokens(dataDir, { ...t, expires_at: 0 });
    await expect(makeAccessTokenGetter(dataDir, client)()).rejects.toMatchObject({ name: 'DriveAuthError' });
    // Revoking with nothing stored, or with Google unreachable, still succeeds.
    await revokeDriveTokens(dataDir);
    await writeDriveTokens(dataDir, t);
    process.env.WALNUT_GDRIVE_REVOKE_URL = 'http://127.0.0.1:1/revoke';
    await revokeDriveTokens(dataDir);
    expect(await readDriveTokens(dataDir)).toBeNull();
  });
});

describe('resolveOAuthClient', () => {
  it('prefers config, then env, then the built-in client', () => {
    process.env.WALNUT_GDRIVE_CLIENT_ID = 'env-id';
    process.env.WALNUT_GDRIVE_CLIENT_SECRET = 'env-secret';
    expect(resolveOAuthClient({ client_id: ' mine ', client_secret: 's' })).toEqual({ clientId: 'mine', clientSecret: 's', source: 'custom' });
    expect(resolveOAuthClient({ client_id: '' })).toEqual({ clientId: 'env-id', clientSecret: 'env-secret', source: 'builtin' });
    delete process.env.WALNUT_GDRIVE_CLIENT_ID;
    delete process.env.WALNUT_GDRIVE_CLIENT_SECRET;
    if (BUILTIN_GOOGLE_CLIENT.clientId) {
      expect(resolveOAuthClient()?.clientId).toBe(BUILTIN_GOOGLE_CLIENT.clientId);
    } else {
      expect(resolveOAuthClient()).toBeNull();
    }
    expect(resolveOAuthClient({ client_id: 'mine' })).toEqual({ clientId: 'mine', clientSecret: undefined, source: 'custom' });
  });
});
