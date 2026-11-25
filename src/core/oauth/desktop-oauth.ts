/**
 * Sign-in for a desktop app (OAuth 2.0 authorization code with PKCE and a loopback redirect), the
 * one flow behind every "Connect" and "Sign in with ..." in Walnut: Google Drive backups, and the
 * Google and Microsoft calendars of mail accounts. A provider (`OAuthProvider`) says where its
 * pages are, which scopes it asks for and how its pages word things; everything else is shared:
 *
 * - a temporary listener on http://127.0.0.1:<random port> receives the browser's answer, checks
 *   its `state`, and trades the code (with the PKCE verifier) for tokens once;
 * - when the browser runs on another machine the person pastes the address it landed on
 *   (`completeSignInFromUrl`), which finishes the same pending sign-in;
 * - each `flow` (a name the caller picks: one per thing being connected) has at most one sign-in
 *   waiting; a newer one of the same flow ends the older one, and a paste reaches only its own flow;
 * - tokens are kept by the caller in a file of its own (`writeTokenFile`: 0600 in a 0700 folder,
 *   written whole through a temporary file), never in config, and never logged.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { clause } from '../../utils/format.js';

const TOKEN_TIMEOUT_MS = 30_000;
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  source: 'builtin' | 'custom';
}

export interface OAuthProvider {
  /** Whose sign-in it is, as the pages say it: "Google", "Microsoft". */
  name: string;
  /** What the sign-in connects, as the pages say it: "Google Drive", "your Google calendar". */
  what: string;
  /** What the person chooses to start again: 'Choose "Connect Google Drive" again.' */
  again: string;
  endpoints(): { auth: string; token: string; revoke?: string };
  scopes: string[];
  /** A scope the grant must hold; a grant without it fails with `scopeMissing`. */
  requiredScope?: string;
  scopeMissing?: string;
  /** Extra query parameters of the sign-in page (access_type, prompt). */
  authParams?: Record<string, string>;
  /** Microsoft wants the scopes again on a refresh. */
  scopeOnRefresh?: boolean;
}

export interface OAuthTokens {
  refresh_token: string;
  access_token?: string;
  /** ms since the epoch */
  expires_at?: number;
  client_id: string;
  scope?: string;
  connected_at: string;
  /** The address the person signed in as, when the provider's id token names it. */
  email?: string;
}

// ── Token files ──

export async function readTokenFile<T extends OAuthTokens>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const t = JSON.parse(raw) as T;
    return t && typeof t.refresh_token === 'string' && t.refresh_token ? t : null;
  } catch {
    return null;
  }
}

/**
 * One queue per token file: a save, a removal and a refresh's write-back of the same sign-in run
 * one after another, so a refresh can never bring back a file a removal took away.
 */
const fileQueues = new Map<string, Promise<void>>();
function onFile<R>(file: string, fn: () => Promise<R>): Promise<R> {
  const key = path.resolve(file);
  const run = (fileQueues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  fileQueues.set(key, tail);
  void tail.then(() => { if (fileQueues.get(key) === tail) fileQueues.delete(key); });
  return run;
}

async function writeNow(file: string, t: OAuthTokens): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

export const writeTokenFile = (file: string, t: OAuthTokens): Promise<void> => onFile(file, () => writeNow(file, t));
export const deleteTokenFile = (file: string): Promise<void> => onFile(file, () => fs.rm(file, { force: true }));

/**
 * Read, change and write a token file in its queue: `change` gets what is there now (null: none)
 * and answers what to write, or null to write nothing. Answers what was there and what was written.
 */
export function updateTokenFile<T extends OAuthTokens>(file: string, change: (current: T | null) => T | null): Promise<{ before: T | null; after: T | null }> {
  return onFile(file, async () => {
    const before = await readTokenFile<T>(file);
    const after = change(before);
    if (after) await writeNow(file, after);
    return { before, after };
  });
}

// ── Token endpoint ──

export class OAuthTokenError extends Error {
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
  id_token?: string;
}

async function postToken(provider: OAuthProvider, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  let resp: Response;
  try {
    resp = await fetchImpl(provider.endpoints().token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthTokenError(`Could not reach ${provider.name} to sign in (${err instanceof Error ? err.message : String(err)}).`);
  }
  const text = await resp.text().catch(() => '');
  let body: TokenResponse & { error?: string; error_description?: string } = {};
  try {
    body = JSON.parse(text);
  } catch { /* not JSON: reported below */ }
  if (!resp.ok || !body.access_token) {
    const code = body.error;
    const detail = code ? `${code}${body.error_description ? ` (${body.error_description.split(/\r?\n/)[0].slice(0, 240)})` : ''}` : `${resp.status}`;
    throw new OAuthTokenError(`${provider.name} sign-in failed: ${clause(detail)}.`, code);
  }
  return body;
}

function withClient(client: OAuthClient, params: Record<string, string>): Record<string, string> {
  return { ...params, client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
}

/** Whether a grant holds a scope: by its full name, or Microsoft's `<resource>/<name>` form of it. */
function granted(scopes: string, wanted: string): boolean {
  return scopes.split(/\s+/).some((s) => s === wanted || s.endsWith(`/${wanted}`));
}

/** The `email` an id token names. Read, not verified: it came straight from the token endpoint over https. */
function emailOf(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const email = claims.email ?? claims.preferred_username;
    return typeof email === 'string' && email.includes('@') ? email : undefined;
  } catch {
    return undefined;
  }
}

export async function exchangeCode(
  provider: OAuthProvider,
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<OAuthTokens> {
  const r = await postToken(provider, withClient(client, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  }), fetchImpl);
  if (!r.refresh_token) throw new Error(`${provider.name} did not return a refresh token. ${provider.again}`);
  if (provider.requiredScope && r.scope && !granted(r.scope, provider.requiredScope)) {
    throw new Error(provider.scopeMissing ?? `Walnut was not given access to ${provider.what}. ${provider.again}`);
  }
  const email = emailOf(r.id_token);
  return {
    refresh_token: r.refresh_token,
    access_token: r.access_token,
    expires_at: Date.now() + (r.expires_in ?? 3600) * 1000,
    client_id: client.clientId,
    scope: r.scope ?? provider.scopes.join(' '),
    connected_at: new Date().toISOString(),
    ...(email ? { email } : {}),
  };
}

export async function refreshAccessToken<T extends OAuthTokens>(provider: OAuthProvider, client: OAuthClient, tokens: T, fetchImpl?: typeof fetch): Promise<T> {
  const r = await postToken(provider, withClient(client, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    ...(provider.scopeOnRefresh ? { scope: provider.scopes.join(' ') } : {}),
  }), fetchImpl);
  return {
    ...tokens,
    access_token: r.access_token,
    expires_at: Date.now() + (r.expires_in ?? 3600) * 1000,
    refresh_token: r.refresh_token || tokens.refresh_token,
    scope: r.scope ?? tokens.scope,
  };
}

/**
 * Whether the provider knows a client, without signing anyone in: a code exchange with a code
 * that cannot be valid. An unknown client (or a wrong secret) answers `invalid_client` or
 * `unauthorized_client`; a known one gets as far as refusing the code.
 */
export async function checkClient(provider: OAuthProvider, client: OAuthClient, fetchImpl?: typeof fetch): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await postToken(provider, withClient(client, {
      grant_type: 'authorization_code',
      code: 'walnut-client-check',
      code_verifier: randomBytes(32).toString('base64url'),
      redirect_uri: 'http://127.0.0.1',
    }), fetchImpl);
    return { ok: true };
  } catch (err) {
    if (err instanceof OAuthTokenError && err.code && !['invalid_client', 'unauthorized_client'].includes(err.code)) return { ok: true };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Best effort: tell the provider to drop a grant (when it has a revoke page). */
export async function revokeGrant(provider: OAuthProvider, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = provider.endpoints().revoke;
  if (!url) return;
  await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.body?.cancel()).catch(() => {});
}

/**
 * A cached access token, refreshed when near expiry or when forced (a server answered 401); several
 * callers at once share one refresh. `notConnected` and `revoked` word the two ends a caller shows
 * the person: no tokens at all, and a grant the provider no longer honours (`invalid_grant`).
 */
export function makeAccessTokenGetter<T extends OAuthTokens>(opts: {
  provider: OAuthProvider;
  read: () => Promise<T | null>;
  /** Write back a refreshed token, in the file's queue (updateTokenFile). */
  update: (change: (current: T | null) => T | null) => Promise<{ before: T | null; after: T | null }>;
  client: () => Promise<OAuthClient | null> | OAuthClient | null;
  notConnected: () => Error;
  revoked: () => Error;
  fetchImpl?: typeof fetch;
}): (forceRefresh?: boolean) => Promise<string> {
  let inflight: Promise<string> | null = null;
  const refresh = async (): Promise<string> => {
    const t = await opts.read();
    if (!t) throw opts.notConnected();
    const client = await opts.client();
    if (!client) throw opts.notConnected();
    let next: T;
    try {
      next = await refreshAccessToken(opts.provider, client, t, opts.fetchImpl);
    } catch (err) {
      if (err instanceof OAuthTokenError && err.code === 'invalid_grant') throw opts.revoked();
      throw err;
    }
    // Written back on what is there now, in the file's queue, so fields written meanwhile are not
    // lost, a sign-in removed meanwhile stays removed, and a newer sign-in (another connected_at)
    // is never overwritten with this one's tokens.
    const { before: latest, after } = await opts.update((cur) => (cur && cur.connected_at === t.connected_at
      ? { ...cur, access_token: next.access_token, expires_at: next.expires_at, refresh_token: next.refresh_token, scope: next.scope }
      : null));
    if (after) return next.access_token!;
    if (!latest) throw opts.notConnected();
    // The newer sign-in's own token, or one refreshed from it: never the older one's.
    return latest.access_token && (latest.expires_at ?? 0) - EXPIRY_MARGIN_MS > Date.now() ? latest.access_token : refresh();
  };
  return async (forceRefresh = false) => {
    if (!forceRefresh && !inflight) {
      const t = await opts.read();
      if (!t) throw opts.notConnected();
      if (t.access_token && t.expires_at && t.expires_at - EXPIRY_MARGIN_MS > Date.now()) return t.access_token;
    }
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  };
}

// ── Sign-in (loopback listener + paste fallback) ──

export type SignInResult = { ok: true; tokens: OAuthTokens } | { ok: false; error: string };

export const SIGN_IN_CANCELLED = 'Sign-in cancelled.';

interface PendingSignIn {
  flow: string;
  provider: OAuthProvider;
  state: string;
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  server: http.Server;
  timer: NodeJS.Timeout;
  onDone: (r: SignInResult) => void;
  exchange?: Promise<OAuthTokens>;
  done: boolean;
}

/** Keyed by state; module scope so a paste finds its sign-in. */
const pending = new Map<string, PendingSignIn>();

function finish(p: PendingSignIn, result: SignInResult | null): void {
  if (p.done) return;
  p.done = true;
  clearTimeout(p.timer);
  pending.delete(p.state);
  p.server.close();
  p.server.closeIdleConnections?.();
  if (result) p.onDone(result);
}

/** The person gave up on a flow's sign-in under way (closed its page): it ends now, not at its timeout. */
export function cancelSignIn(flow: string): boolean {
  const mine = [...pending.values()].filter((p) => p.flow === flow);
  for (const p of mine) finish(p, { ok: false, error: SIGN_IN_CANCELLED });
  return mine.length > 0;
}

/** Whether a flow has a sign-in waiting. */
export function signInPending(flow: string): boolean {
  return [...pending.values()].some((p) => p.flow === flow);
}

function deniedMessage(p: PendingSignIn, error: string, description?: string | null): string {
  if (error === 'access_denied') return `${p.provider.name} sign-in was cancelled: Walnut was not allowed to use ${p.provider.what}.`;
  return `${p.provider.name} sign-in failed: ${error}${description ? ` (${description.slice(0, 240)})` : ''}.`;
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

function exchangeOnce(p: PendingSignIn, code: string): Promise<OAuthTokens> {
  p.exchange ??= exchangeCode(p.provider, p.client, code, p.verifier, p.redirectUri);
  return p.exchange;
}

function handleRequest(p: PendingSignIn, req: http.IncomingMessage, res: http.ServerResponse): void {
  const reply = (status: number, title: string, text: string, closeTab = false) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' });
    res.end(page(title, text, closeTab));
  };
  const notConnected = `${p.provider.what[0].toUpperCase()}${p.provider.what.slice(1)} was not connected`;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET' || url.searchParams.get('state') !== p.state || p.done) {
    reply(400, 'Not a Walnut sign-in', `This address does not belong to the ${p.provider.what} sign-in Walnut is waiting for.`);
    return;
  }
  const error = url.searchParams.get('error');
  if (error) {
    const msg = deniedMessage(p, error, url.searchParams.get('error_description'));
    reply(200, notConnected, `${msg} You can close this tab and go back to Walnut.`);
    finish(p, { ok: false, error: msg });
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    reply(400, 'Not a Walnut sign-in', `${p.provider.name} did not send a sign-in code. ${p.provider.again}`);
    return;
  }
  exchangeOnce(p, code).then(
    (tokens) => {
      reply(200, 'Connected', `Walnut is connected to ${p.provider.what}. You can close this tab and go back to Walnut.`, true);
      finish(p, { ok: true, tokens });
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      reply(200, notConnected, `${msg} You can close this tab and go back to Walnut.`);
      finish(p, { ok: false, error: msg });
    },
  );
}

export async function startSignIn(
  provider: OAuthProvider,
  client: OAuthClient,
  opts: { flow: string; onDone: (r: SignInResult) => void; timeoutMs?: number; listenHost?: string; authParams?: Record<string, string> },
): Promise<{ authUrl: string; redirectUri: string; state: string }> {
  for (const old of [...pending.values()]) if (old.flow === opts.flow) finish(old, null);

  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // eslint-disable-next-line prefer-const -- the handler needs `p` before it exists
  let p: PendingSignIn;
  const server = http.createServer((req, res) => handleRequest(p, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, opts.listenHost ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  p = {
    flow: opts.flow,
    provider,
    state,
    verifier,
    redirectUri,
    client,
    server,
    onDone: opts.onDone,
    done: false,
    timer: setTimeout(() => {
      finish(p, { ok: false, error: `Sign-in timed out: ${provider.name} did not send Walnut back an answer. ${provider.again}` });
    }, opts.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS),
  };
  p.timer.unref?.();
  pending.set(state, p);

  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scopes.join(' '),
    ...provider.authParams,
    ...opts.authParams,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { authUrl: `${provider.endpoints().auth}?${q.toString()}`, redirectUri, state };
}

/** The paste fallback: the full address the browser landed on, or just its `code=...&state=...` part. */
export async function completeSignInFromUrl(flow: string, pasted: string, again = 'Start the sign-in again.'): Promise<OAuthTokens> {
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
  if (!p || p.flow !== flow) throw new Error(`That sign-in is no longer waiting (it timed out or a newer one started). ${again}`);
  const error = params.get('error');
  if (error) {
    const msg = deniedMessage(p, error, params.get('error_description'));
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
