/**
 * A fake OAuth 2.0 provider's endpoints (authorization code with PKCE S256, refresh, revoke), to
 * mount in a test server of a provider (fake-google-drive.ts, fake-calendar-providers.ts).
 *
 * - auth: checks the request, then redirects to `redirect_uri` with a code and the state (or
 *   shows a consent page with Allow and Cancel when `consentPage` is set);
 * - token: `authorization_code` checks the client (when `clients` lists them), the redirect URI
 *   and the PKCE verifier; `refresh_token` mints a new access token; an `openid`/`email` scope
 *   gets an id token naming `email` (else the login hint);
 * - revoke: drops the whole grant a refresh or access token belongs to (every token of the same
 *   client and account), as Google's revoke does.
 * Errors use the providers' JSON shape (`error`, `error_description`).
 */
import type http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export interface FakeOAuthOptions {
  ttlSec?: number;
  paths?: { auth?: string; token?: string; revoke?: string };
  /** A consent page instead of an immediate redirect: its title and what it lists. */
  consentPage?: { title: string; lines: string[] };
  /** Known clients (id → secret, null for a public client). Unset: any client is known. */
  clients?: Record<string, string | null>;
  /** Who signs in (the id token's email): an address, or one per login hint; default the login hint. */
  email?: SignInAs;
  /** Prefix of minted tokens (`ya29.fake-`, `EwB-fake-`). */
  tokenPrefix?: string;
}

export type SignInAs = string | ((loginHint: string) => string);

export interface FakeOAuth {
  /** Answers the request when it is one of the OAuth endpoints; false otherwise. `body`: already read by the caller. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, u: URL, body?: string): Promise<boolean>;
  mintAccessToken(ttlSec?: number): string;
  /** Whether a Bearer header carries an unexpired access token. */
  validBearer(authorization: string | undefined): boolean;
  /** Every access token stops working (a provider-side expiry), refresh tokens stay. */
  expireAccessTokens(): void;
  /** Every grant is revoked: refresh tokens and access tokens stop working. */
  revokeAll(): void;
  /** Who the next sign-ins are (the id token's email); undefined: the login hint. */
  signInAs(email?: SignInAs): void;
  /** Form bodies of the token requests, in order. */
  tokenRequests: URLSearchParams[];
}

const rid = (n = 16) => randomBytes(n).toString('base64url');

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function createFakeOAuth(opts: FakeOAuthOptions = {}): FakeOAuth {
  const ttl = opts.ttlSec ?? 3600;
  const paths = { auth: '/o/oauth2/v2/auth', token: '/token', revoke: '/revoke', ...opts.paths };
  const prefix = opts.tokenPrefix ?? 'ya29.fake-';
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; scope: string; hint: string }>();
  const refreshTokens = new Map<string, { clientId: string; scope: string; hint: string }>();
  const accessTokens = new Map<string, number>();
  /** The grant (`client id|account`) each token belongs to; a revoke drops every token of it. */
  const grantOf = new Map<string, string>();
  const tokenRequests: URLSearchParams[] = [];
  let email = opts.email;
  const who = (hint: string) => (typeof email === 'function' ? email(hint) : email ?? hint);

  const mintAccessToken = (ttlSec = ttl, grant?: string) => {
    const t = `${prefix}${rid()}`;
    accessTokens.set(t, Date.now() + ttlSec * 1000);
    if (grant) grantOf.set(t, grant);
    return t;
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(body));
  };
  const html = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const idToken = (scope: string, hint: string) => {
    if (!/\b(openid|email)\b/.test(scope)) return {};
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return { id_token: `${enc({ alg: 'none' })}.${enc({ email: who(hint), sub: 'fake-user' })}.sig` };
  };
  const clientOk = (form: URLSearchParams) => {
    if (!opts.clients) return true;
    const id = form.get('client_id') ?? '';
    if (!(id in opts.clients)) return false;
    const secret = opts.clients[id];
    return secret === null || form.get('client_secret') === secret;
  };

  return {
    tokenRequests,
    mintAccessToken,
    validBearer(authorization) {
      const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
      const exp = token ? accessTokens.get(token) : undefined;
      return !!exp && exp > Date.now();
    },
    expireAccessTokens() { accessTokens.clear(); },
    signInAs(next) { email = next; },
    revokeAll() { refreshTokens.clear(); accessTokens.clear(); },
    async handle(req, res, u, body) {
      if (req.method === 'GET' && u.pathname === paths.auth) {
        const p = u.searchParams;
        const redirectUri = p.get('redirect_uri') ?? '';
        if (!p.get('client_id') || !redirectUri || p.get('response_type') !== 'code' || !p.get('state')
          || !p.get('code_challenge') || p.get('code_challenge_method') !== 'S256') {
          html(res, 400, '<h1>400. That is an error.</h1><p>Error 400: invalid_request</p>');
          return true;
        }
        const code = `4/fake-${rid()}`;
        codes.set(code, { clientId: p.get('client_id')!, redirectUri, challenge: p.get('code_challenge')!, scope: p.get('scope') ?? '', hint: p.get('login_hint') ?? 'pat@example.com' });
        const back = (params: Record<string, string>) => {
          const r = new URL(redirectUri);
          for (const [k, v] of Object.entries(params)) r.searchParams.set(k, v);
          return r.toString();
        };
        const allow = back({ state: p.get('state')!, code, scope: p.get('scope') ?? '' });
        if (!opts.consentPage) {
          res.writeHead(302, { Location: allow });
          res.end();
          return true;
        }
        const deny = back({ state: p.get('state')!, error: 'access_denied' });
        const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const { title, lines } = opts.consentPage;
        html(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f1f3f4;margin:0}main{background:#fff;max-width:28rem;margin:4rem auto;padding:2rem;border:1px solid #dadce0;border-radius:8px}
h1{font-size:1.4rem;font-weight:400}a.btn{display:inline-block;padding:.5rem 1.5rem;border-radius:4px;text-decoration:none;margin-right:.5rem}
.allow{background:#1a73e8;color:#fff}.cancel{color:#1a73e8}</style></head><body><main>
<h1>${title}</h1><p><strong>Walnut</strong> wants access to your account</p>
<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
<p><a class="btn cancel" id="cancel" href="${attr(deny)}">Cancel</a><a class="btn allow" id="allow" href="${attr(allow)}">Allow</a></p>
</main></body></html>`);
        return true;
      }
      if (req.method !== 'POST' || (u.pathname !== paths.token && u.pathname !== paths.revoke)) return false;
      const form = new URLSearchParams(body ?? await readBody(req));
      if (u.pathname === paths.revoke) {
        const t = form.get('token') ?? '';
        if (!refreshTokens.has(t) && !accessTokens.has(t)) return json(res, 400, { error: 'invalid_token', error_description: 'Token expired or revoked' }), true;
        const grant = grantOf.get(t);
        refreshTokens.delete(t);
        accessTokens.delete(t);
        for (const [token, g] of grantOf) {
          if (grant && g === grant) { refreshTokens.delete(token); accessTokens.delete(token); grantOf.delete(token); }
        }
        json(res, 200, {});
        return true;
      }
      tokenRequests.push(form);
      const bad = (desc: string) => json(res, 400, { error: 'invalid_grant', error_description: desc });
      if (!clientOk(form)) return json(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }), true;
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!c) return bad('Malformed auth code.'), true;
        if (c.clientId !== form.get('client_id')) return json(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' }), true;
        if (c.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'redirect_uri_mismatch', error_description: 'Bad Request' }), true;
        if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return bad('Invalid code verifier.'), true;
        const rt = `1//fake-${rid()}`;
        refreshTokens.set(rt, { clientId: c.clientId, scope: c.scope, hint: c.hint });
        const g = `${c.clientId}|${who(c.hint).toLowerCase()}`;
        grantOf.set(rt, g);
        json(res, 200, { access_token: mintAccessToken(ttl, g), expires_in: ttl, refresh_token: rt, scope: c.scope, token_type: 'Bearer', ...idToken(c.scope, c.hint) });
        return true;
      }
      if (grant === 'refresh_token') {
        const r = refreshTokens.get(form.get('refresh_token') ?? '');
        if (!r) return bad('Token has been expired or revoked.'), true;
        json(res, 200, { access_token: mintAccessToken(ttl, grantOf.get(form.get('refresh_token') ?? '')), expires_in: ttl, scope: r.scope, token_type: 'Bearer' });
        return true;
      }
      json(res, 400, { error: 'unsupported_grant_type', error_description: `Invalid grant_type: ${grant}` });
      return true;
    },
  };
}
