/**
 * Google sign-in for Drive backups, on the shared desktop sign-in (src/core/oauth/desktop-oauth.ts:
 * a loopback listener with PKCE, and a pasted address when the browser is on another machine).
 * This module holds what is Drive's own: its scope and words, which Google client it uses, and
 * where its token lives.
 *
 * The refresh token lives in <dataDir>/local/backup/gdrive-token.json (0600),
 * per machine, never in config. Token values are never logged.
 *
 * The same Google client can serve a mail account's Google calendar too (one client may hold
 * both scopes): the calendar's sign-in falls back to `resolveOAuthClient` when it has none of
 * its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../../logging/index.js';
import {
  cancelSignIn, completeSignInFromUrl, deleteTokenFile, exchangeCode as exchangeWith, makeAccessTokenGetter as tokenGetter,
  readTokenFile, refreshAccessToken as refreshWith, revokeGrant, startSignIn, updateTokenFile, writeTokenFile,
  type OAuthClient, type OAuthProvider, type OAuthTokens, type SignInResult,
} from '../oauth/desktop-oauth.js';
import { driveTokenPath, grantHeldElsewhere } from '../oauth/google-grants.js';

export type { OAuthClient } from '../oauth/desktop-oauth.js';
export { SIGN_IN_CANCELLED } from '../oauth/desktop-oauth.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Walnut's own published Google OAuth client goes here once it exists. It is
 * a desktop-app client: Google treats its secret as not confidential, since
 * any installed copy of the app carries it.
 */
export const BUILTIN_GOOGLE_CLIENT = { clientId: '', clientSecret: '' };

/**
 * This machine's Google client: `<dataDir>/local/backup/gdrive-client.json` (0600), beside
 * the token and, like it, never synced to other machines (an encrypted backup carries it,
 * sealed; a new machine needs it before it can read Drive at all). Either `{client_id, client_secret}` or the file
 * Google's console downloads (`{installed: {...}}`). It stands where the built-in client
 * would: Connect needs nothing filled in. Unreadable or malformed reads as absent (logged
 * with its path, never its content).
 */
export function machineClientPath(dataDir: string): string {
  return path.join(dataDir, 'local', 'backup', 'gdrive-client.json');
}

export function readMachineClient(dataDir: string): OAuthClient | null {
  try {
    const raw = JSON.parse(readFileSync(machineClientPath(dataDir), 'utf-8')) as Record<string, unknown>;
    const c = (raw.installed ?? raw) as { client_id?: unknown; client_secret?: unknown };
    const clientId = typeof c.client_id === 'string' ? c.client_id.trim() : '';
    if (!clientId) return null;
    const secret = typeof c.client_secret === 'string' ? c.client_secret.trim() : '';
    return { clientId, clientSecret: secret || undefined, source: 'builtin' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.session.warn('backup: Google client file unreadable, ignored', { path: machineClientPath(dataDir), err: (err as Error).name });
    }
    return null;
  }
}

/**
 * The client a Drive sign-in uses: the user's own from Settings, else the environment's,
 * else this machine's client file (when `dataDir` is given), else the built-in one.
 */
export function resolveOAuthClient(custom?: { client_id?: string; client_secret?: string }, dataDir?: string): OAuthClient | null {
  const customId = custom?.client_id?.trim();
  if (customId) return { clientId: customId, clientSecret: custom?.client_secret?.trim() || undefined, source: 'custom' };
  const envId = process.env.WALNUT_GDRIVE_CLIENT_ID?.trim();
  if (envId) return { clientId: envId, clientSecret: process.env.WALNUT_GDRIVE_CLIENT_SECRET?.trim() || undefined, source: 'builtin' };
  const machine = dataDir ? readMachineClient(dataDir) : null;
  if (machine) return machine;
  if (BUILTIN_GOOGLE_CLIENT.clientId) {
    return { clientId: BUILTIN_GOOGLE_CLIENT.clientId, clientSecret: BUILTIN_GOOGLE_CLIENT.clientSecret || undefined, source: 'builtin' };
  }
  return null;
}

/** Google's sign-in pages (Drive's and the calendar's); the variables point a test at a fake. */
export function oauthEndpoints(): { auth: string; token: string; revoke: string } {
  return {
    auth: process.env.WALNUT_GDRIVE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: process.env.WALNUT_GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    revoke: process.env.WALNUT_GDRIVE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  };
}

const AGAIN = 'Choose "Connect Google Drive" again.';
const FLOW = 'gdrive';

export const DRIVE_PROVIDER: OAuthProvider = {
  name: 'Google',
  what: 'Google Drive',
  again: AGAIN,
  endpoints: oauthEndpoints,
  scopes: [DRIVE_SCOPE],
  requiredScope: DRIVE_SCOPE,
  scopeMissing: 'Walnut was not given access to its Google Drive files. Connect again and tick the Drive box on the Google page.',
  authParams: { access_type: 'offline', prompt: 'consent' },
};

// ── Token file ──

export interface DriveTokens extends OAuthTokens {
  /** The Drive folder backups go to: machine-local state, kept beside the token. */
  folder_id?: string;
  folder_name?: string;
}

const tokenPath = driveTokenPath;

export function readDriveTokens(dataDir: string): Promise<DriveTokens | null> {
  return readTokenFile<DriveTokens>(tokenPath(dataDir));
}

export function writeDriveTokens(dataDir: string, t: DriveTokens): Promise<void> {
  return writeTokenFile(tokenPath(dataDir), t);
}

export function deleteDriveTokens(dataDir: string): Promise<void> {
  return deleteTokenFile(tokenPath(dataDir));
}

// ── Token endpoint ──

export function exchangeCode(client: OAuthClient, code: string, codeVerifier: string, redirectUri: string, fetchImpl?: typeof fetch): Promise<DriveTokens> {
  return exchangeWith(DRIVE_PROVIDER, client, code, codeVerifier, redirectUri, fetchImpl);
}

export function refreshAccessToken(client: OAuthClient, tokens: DriveTokens, fetchImpl?: typeof fetch): Promise<DriveTokens> {
  return refreshWith(DRIVE_PROVIDER, client, tokens, fetchImpl);
}

function driveAuthError(message: string): Error {
  const err = new Error(message);
  err.name = 'DriveAuthError';
  return err;
}

/** A token source for DriveStore: cached access token, refreshed when near expiry or forced. */
export function makeAccessTokenGetter(dataDir: string, client: OAuthClient, fetchImpl?: typeof fetch): (forceRefresh?: boolean) => Promise<string> {
  return tokenGetter<DriveTokens>({
    provider: DRIVE_PROVIDER,
    read: () => readDriveTokens(dataDir),
    update: (change) => updateTokenFile<DriveTokens>(tokenPath(dataDir), change),
    client: () => client,
    notConnected: () => driveAuthError(`Google Drive is not connected on this machine. ${AGAIN}`),
    revoked: () => driveAuthError(`Google Drive access was revoked or has expired. ${AGAIN}`),
    fetchImpl,
  });
}

/**
 * Best effort: tell Google to drop the grant, then forget it here either way. A grant a mail
 * account's Google calendar still holds (the same client and account, google-grants.ts) is left
 * at Google: revoking it would sign the calendar out too.
 */
export async function revokeDriveTokens(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const t = await readDriveTokens(dataDir).catch(() => null);
  if (t && !(await grantHeldElsewhere(dataDir, tokenPath(dataDir), t))) await revokeGrant(DRIVE_PROVIDER, t.refresh_token, fetchImpl);
  await deleteDriveTokens(dataDir);
}

// ── Sign-in (loopback listener + paste fallback) ──

/** The person gave up on the sign-in under way (closed the Google page): it ends now, not at its timeout. */
export function cancelDriveConnect(): boolean {
  return cancelSignIn(FLOW);
}

export function startDriveConnect(
  client: OAuthClient,
  opts: { onDone: (r: SignInResult) => void; timeoutMs?: number; listenHost?: string },
): Promise<{ authUrl: string; redirectUri: string; state: string }> {
  return startSignIn(DRIVE_PROVIDER, client, { flow: FLOW, ...opts });
}

/** The paste fallback: the full address the browser landed on, or just its `code=...&state=...` part. */
export function completeDriveConnectFromUrl(pasted: string): Promise<DriveTokens> {
  return completeSignInFromUrl(FLOW, pasted, AGAIN);
}
