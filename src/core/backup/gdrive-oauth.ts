/**
 * Google sign-in for Drive backups: the desktop-app OAuth flow with a loopback
 * redirect (a temporary listener on http://127.0.0.1:<random port>) and PKCE.
 *
 * When the browser runs on another machine, the redirect cannot reach the
 * listener; the user pastes the address the browser landed on (it carries
 * the code and the state) and completeDriveConnectFromUrl() finishes the same
 * pending sign-in.
 *
 * The refresh token lives in <dataDir>/local/backup/gdrive-token.json (0600),
 * per machine, never in config. Token values are never logged.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const TOKEN_TIMEOUT_MS = 30_000;
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10 * 60_000;

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  source: 'builtin' | 'custom';
}

/**
 * Walnut's own published Google OAuth client goes here once it exists. It is
 * a desktop-app client: Google treats its secret as not confidential, since
 * any installed copy of the app carries it.
 */
export const BUILTIN_GOOGLE_CLIENT = { clientId: '', clientSecret: '' };

export function resolveOAuthClient(custom?: { client_id?: string; client_secret?: string }): OAuthClient | null {
  const customId = custom?.client_id?.trim();
  if (customId) return { clientId: customId, clientSecret: custom?.client_secret?.trim() || undefined, source: 'custom' };
  const envId = process.env.WALNUT_GDRIVE_CLIENT_ID?.trim();
  if (envId) return { clientId: envId, clientSecret: process.env.WALNUT_GDRIVE_CLIENT_SECRET?.trim() || undefined, source: 'builtin' };
  if (BUILTIN_GOOGLE_CLIENT.clientId) {
    return { clientId: BUILTIN_GOOGLE_CLIENT.clientId, clientSecret: BUILTIN_GOOGLE_CLIENT.clientSecret || undefined, source: 'builtin' };
  }
  return null;
}

export function oauthEndpoints(): { auth: string; token: string; revoke: string } {
  return {
    auth: process.env.WALNUT_GDRIVE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: process.env.WALNUT_GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    revoke: process.env.WALNUT_GDRIVE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  };
}

// ── Token file ──

export interface DriveTokens {
  refresh_token: string;
  access_token?: string;
  /** ms since the epoch */
  expires_at?: number;
  client_id: string;
  scope?: string;
  connected_at: string;
  email?: string;
  /** The Drive folder backups go to: machine-local state, kept beside the token. */
  folder_id?: string;
  folder_name?: string;
}

function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'local', 'backup', 'gdrive-token.json');
}

export async function readDriveTokens(dataDir: string): Promise<DriveTokens | null> {
  let raw: string;
  try {
    raw = await fs.readFile(tokenPath(dataDir), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const t = JSON.parse(raw) as DriveTokens;
    return t && typeof t.refresh_token === 'string' && t.refresh_token ? t : null;
  } catch {
    return null;
  }
}

export async function writeDriveTokens(dataDir: string, t: DriveTokens): Promise<void> {
  const dest = tokenPath(dataDir);
  const dir = path.dirname(dest);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  const tmp = `${dest}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, dest);
}

export async function deleteDriveTokens(dataDir: string): Promise<void> {
  await fs.rm(tokenPath(dataDir), { force: true });
}

// ── Token endpoint ──

class OAuthTokenError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function postToken(params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  let resp: Response;
  try {
    resp = await fetchImpl(oauthEndpoints().token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthTokenError(`Could not reach Google to sign in (${err instanceof Error ? err.message : String(err)}).`);
  }
  const text = await resp.text().catch(() => '');
  let body: TokenResponse & { error?: string; error_description?: string } = {};
  try {
    body = JSON.parse(text);
  } catch { /* not JSON: reported below */ }
  if (!resp.ok || !body.access_token) {
    const code = body.error;
    const detail = code ? `${code}${body.error_description ? ` (${body.error_description})` : ''}` : `${resp.status}`;
    throw new OAuthTokenError(`Google sign-in failed: ${detail}.`, code);
  }
  return body;
}

function withClient(client: OAuthClient, params: Record<string, string>): Record<string, string> {
  return { ...params, client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
}

export async function exchangeCode(
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<DriveTokens> {
  const r = await postToken(withClient(client, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  }), fetchImpl);
  if (!r.refresh_token) throw new Error('Google did not return a refresh token. Choose "Connect Google Drive" again.');
  if (r.scope && !r.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
    throw new Error('Walnut was not given access to its Google Drive files. Connect again and tick the Drive box on the Google page.');
  }
  return {
    refresh_token: r.refresh_token,
    access_token: r.access_token,
    expires_at: Date.now() + (r.expires_in ?? 3600) * 1000,
    client_id: client.clientId,
    scope: r.scope ?? DRIVE_SCOPE,
    connected_at: new Date().toISOString(),
  };
}

export async function refreshAccessToken(client: OAuthClient, tokens: DriveTokens, fetchImpl?: typeof fetch): Promise<DriveTokens> {
  const r = await postToken(withClient(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), fetchImpl);
  return {
    ...tokens,
    access_token: r.access_token,
    expires_at: Date.now() + (r.expires_in ?? 3600) * 1000,
    refresh_token: r.refresh_token || tokens.refresh_token,
    scope: r.scope ?? tokens.scope,
  };
}

function driveAuthError(message: string): Error {
  const err = new Error(message);
  err.name = 'DriveAuthError';
  return err;
}

/** A token source for DriveStore: cached access token, refreshed when near expiry or forced. */
export function makeAccessTokenGetter(dataDir: string, client: OAuthClient, fetchImpl?: typeof fetch): (forceRefresh?: boolean) => Promise<string> {
  let inflight: Promise<string> | null = null;
  const refresh = async (): Promise<string> => {
    const t = await readDriveTokens(dataDir);
    if (!t) throw driveAuthError('Google Drive is not connected on this machine. Choose "Connect Google Drive" again.');
    let next: DriveTokens;
    try {
      next = await refreshAccessToken(client, t, fetchImpl);
    } catch (err) {
      if (err instanceof OAuthTokenError && err.code === 'invalid_grant') {
        throw driveAuthError('Google Drive access was revoked or has expired. Choose "Connect Google Drive" again.');
      }
      throw err;
    }
    // Re-read so fields written meanwhile (email, folder) are not lost.
    const latest = (await readDriveTokens(dataDir)) ?? t;
    await writeDriveTokens(dataDir, {
      ...latest,
      access_token: next.access_token,
      expires_at: next.expires_at,
      refresh_token: next.refresh_token,
      scope: next.scope,
    });
    return next.access_token!;
  };
  return async (forceRefresh = false) => {
    if (!forceRefresh && !inflight) {
      const t = await readDriveTokens(dataDir);
      if (t?.access_token && t.expires_at && t.expires_at - EXPIRY_MARGIN_MS > Date.now()) return t.access_token;
    }
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  };
}

/** Best effort: tell Google to drop the grant, then forget it here either way. */
export async function revokeDriveTokens(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const t = await readDriveTokens(dataDir).catch(() => null);
  if (t) {
    await fetchImpl(oauthEndpoints().revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh_token }).toString(),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.body?.cancel()).catch(() => {});
  }
  await deleteDriveTokens(dataDir);
}

// ── Sign-in (loopback listener + paste fallback) ──

type ConnectResult = { ok: true; tokens: DriveTokens } | { ok: false; error: string };

interface PendingConnect {
  state: string;
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  server: http.Server;
  timer: NodeJS.Timeout;
  onDone: (r: ConnectResult) => void;
  exchange?: Promise<DriveTokens>;
  done: boolean;
}

/** At most one, keyed by state; module scope so the paste route finds it. */
const pending = new Map<string, PendingConnect>();

function closeServer(p: PendingConnect): void {
  p.server.close();
  p.server.closeIdleConnections?.();
}

function finish(p: PendingConnect, result: ConnectResult | null): void {
  if (p.done) return;
  p.done = true;
  clearTimeout(p.timer);
  pending.delete(p.state);
  closeServer(p);
  if (result) p.onDone(result);
}

function deniedMessage(error: string, description?: string | null): string {
  if (error === 'access_denied') return 'Google sign-in was cancelled: Walnut was not allowed to use Google Drive.';
  return `Google sign-in failed: ${error}${description ? ` (${description})` : ''}.`;
}

function page(title: string, text: string, closeTab = false): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>'
    + `</head><body><h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(text)}</p>`
    // Walnut opened this tab, so the browser lets it close it; when it cannot, the text stays.
    + (closeTab
      ? '<p><button type="button" onclick="window.close()" style="font:inherit;padding:.4rem 1rem">Close this tab</button></p>'
        + '<script>setTimeout(function(){window.close()},1200)</script>'
      : '')
    + '</body></html>';
}

function exchangeOnce(p: PendingConnect, code: string): Promise<DriveTokens> {
  p.exchange ??= exchangeCode(p.client, code, p.verifier, p.redirectUri);
  return p.exchange;
}

function handleRequest(p: PendingConnect, req: http.IncomingMessage, res: http.ServerResponse): void {
  const reply = (status: number, title: string, text: string, closeTab = false) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' });
    res.end(page(title, text, closeTab));
  };
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET' || url.searchParams.get('state') !== p.state || p.done) {
    reply(400, 'Not a Walnut sign-in', 'This address does not belong to the Google Drive sign-in Walnut is waiting for.');
    return;
  }
  const error = url.searchParams.get('error');
  if (error) {
    const msg = deniedMessage(error, url.searchParams.get('error_description'));
    reply(200, 'Google Drive was not connected', `${msg} You can close this tab and go back to Walnut.`);
    finish(p, { ok: false, error: msg });
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    reply(400, 'Not a Walnut sign-in', 'Google did not send a sign-in code. Try "Connect Google Drive" again.');
    return;
  }
  exchangeOnce(p, code).then(
    (tokens) => {
      reply(200, 'Connected', 'Walnut is connected to Google Drive. You can close this tab and go back to Walnut.', true);
      finish(p, { ok: true, tokens });
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      reply(200, 'Google Drive was not connected', `${msg} You can close this tab and go back to Walnut.`);
      finish(p, { ok: false, error: msg });
    },
  );
}

export async function startDriveConnect(
  client: OAuthClient,
  opts: { onDone: (r: ConnectResult) => void; timeoutMs?: number; listenHost?: string },
): Promise<{ authUrl: string; redirectUri: string; state: string }> {
  for (const old of [...pending.values()]) finish(old, null);

  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // eslint-disable-next-line prefer-const -- the handler needs `p` before it exists
  let p: PendingConnect;
  const server = http.createServer((req, res) => handleRequest(p, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, opts.listenHost ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  p = {
    state,
    verifier,
    redirectUri,
    client,
    server,
    onDone: opts.onDone,
    done: false,
    timer: setTimeout(() => {
      finish(p, { ok: false, error: 'Sign-in timed out: Google did not send Walnut back an answer. Choose "Connect Google Drive" again.' });
    }, timeoutMs),
  };
  p.timer.unref?.();
  pending.set(state, p);

  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { authUrl: `${oauthEndpoints().auth}?${q.toString()}`, redirectUri, state };
}

/** The paste fallback: the full address the browser landed on, or just its `code=...&state=...` part. */
export async function completeDriveConnectFromUrl(pasted: string): Promise<DriveTokens> {
  const text = pasted.trim();
  let params: URLSearchParams;
  try {
    params = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ''));
  } catch {
    throw new Error('That is not a web address. Copy the whole address from the browser\'s address bar and paste it again.');
  }
  const state = params.get('state');
  if (!state) throw new Error('That address has no sign-in details in it. Copy the whole address from the browser\'s address bar after you allow access.');
  const p = pending.get(state);
  if (!p) throw new Error('That sign-in is no longer waiting (it timed out or a newer one started). Choose "Connect Google Drive" again.');
  const error = params.get('error');
  if (error) {
    const msg = deniedMessage(error, params.get('error_description'));
    finish(p, { ok: false, error: msg });
    throw new Error(msg);
  }
  const code = params.get('code');
  if (!code) throw new Error('That address has no sign-in code in it. Copy the whole address from the browser\'s address bar after you allow access.');
  try {
    const tokens = await exchangeOnce(p, code);
    finish(p, { ok: true, tokens });
    return tokens;
  } catch (err) {
    finish(p, { ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
