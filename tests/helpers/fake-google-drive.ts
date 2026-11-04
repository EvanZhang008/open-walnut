/**
 * In-process fake of Google's OAuth endpoints and the Drive v3 subset that
 * Walnut's Drive backup store uses, over node:http on 127.0.0.1.
 *
 * OAuth: /o/oauth2/v2/auth (optional consent page), /token (authorization_code
 * with PKCE S256 check, refresh_token), /revoke. Drive: files list/create/
 * get/delete/about under /drive/v3, and multipart, resumable and media
 * uploads under /upload/drive/v3. Every Drive call needs a valid, unexpired
 * Bearer token. Errors use Google's JSON shape.
 *
 * Standalone: `bun tests/helpers/fake-google-drive.ts --serve --port 4999`
 * prints one JSON line `{"url": ..., "env": {...}}` and stays up.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

export interface FakeDriveFile {
  id: string;
  name: string;
  parents: string[];
  size: number;
  mimeType: string;
}

export interface FakeGoogleDrive {
  url: string;
  /** WALNUT_GDRIVE_* variables pointing Walnut at this fake. */
  env: Record<string, string>;
  files(): FakeDriveFile[];
  /** The next `n` Drive requests (those matching `match` on `METHOD /path?query`, if given) answer `status` with this error reason. */
  failNext(n: number, status: number, reason?: string, match?: RegExp): void;
  /** `METHOD /path?query` of every request, in order. */
  requests: string[];
  /** A valid access token without the OAuth dance (for store tests). */
  mintAccessToken(ttlSec?: number): string;
  /** Put a file straight into the fake (e.g. a duplicate name from a past race). */
  addFile(name: string, parentId: string, data: Buffer): FakeDriveFile;
  close(): Promise<void>;
}

interface StoredFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  data: Buffer;
  createdTime: string;
  modifiedTime: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const REASON_MESSAGES: Record<string, string> = {
  storageQuotaExceeded: "The user's Drive storage quota has been exceeded.",
  rateLimitExceeded: 'Rate Limit Exceeded',
  userRateLimitExceeded: 'User Rate Limit Exceeded',
  backendError: 'Backend Error',
  forbidden: 'Forbidden',
  notFound: 'File not found.',
};

const id = (n = 16) => randomBytes(n).toString('base64url');

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** multipart/related: [JSON metadata, media]. */
function parseMultipart(body: Buffer, contentType: string): { metadata: Record<string, unknown>; media: Buffer } {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) throw new Error('no boundary');
  const delim = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let at = body.indexOf(delim);
  while (at !== -1) {
    const start = at + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    // Part = CRLF headers CRLF CRLF content CRLF
    parts.push(body.subarray(start + 2, next - 2));
    at = next;
  }
  const content = (p: Buffer) => p.subarray(p.indexOf('\r\n\r\n') + 4);
  if (parts.length < 2) throw new Error('expected two parts');
  return { metadata: JSON.parse(content(parts[0]).toString('utf-8') || '{}'), media: Buffer.from(content(parts[1])) };
}

type Clause = { name?: string; mimeType?: string; parent?: string; trashed?: boolean };

/** The Drive `q` forms Walnut sends: name=, mimeType=, '<id>' in parents, trashed=, joined by `and`. */
function parseQuery(q: string): Clause | null {
  const re = /\s*(?:name\s*=\s*'((?:[^'\\]|\\.)*)'|mimeType\s*=\s*'((?:[^'\\]|\\.)*)'|'((?:[^'\\]|\\.)*)'\s+in\s+parents|trashed\s*=\s*(true|false))\s*(?:and\b|$)/y;
  const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
  const out: Clause = {};
  re.lastIndex = 0;
  while (re.lastIndex < q.length) {
    const m = re.exec(q);
    if (!m) return null;
    if (m[1] !== undefined) out.name = unescape(m[1]);
    if (m[2] !== undefined) out.mimeType = unescape(m[2]);
    if (m[3] !== undefined) out.parent = unescape(m[3]);
    if (m[4] !== undefined) out.trashed = m[4] === 'true';
  }
  return out;
}

export async function startFakeGoogleDrive(
  opts: {
    accessTokenTtlSec?: number;
    port?: number;
    consentPage?: boolean;
    /** Cap on files per list page, below what the client asks for (Drive may return fewer). */
    maxPageSize?: number;
  } = {},
): Promise<FakeGoogleDrive> {
  const ttl = opts.accessTokenTtlSec ?? 3600;
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; scope: string }>();
  const refreshTokens = new Map<string, { clientId: string; scope: string }>();
  const accessTokens = new Map<string, number>();
  const files = new Map<string, StoredFile>();
  const sessions = new Map<string, { fileId?: string; metadata: Record<string, unknown> }>();
  const failures: Array<{ status: number; reason: string; match?: RegExp }> = [];
  const requests: string[] = [];
  let clock = Date.now();
  // Strictly increasing timestamps, so "newest" is well defined within one test.
  const now = () => new Date((clock = Math.max(clock + 1, Date.now()))).toISOString();
  let url = '';

  const mintAccessToken = (ttlSec = ttl) => {
    const t = `ya29.fake-${id()}`;
    accessTokens.set(t, Date.now() + ttlSec * 1000);
    return t;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', ...headers });
    res.end(JSON.stringify(body));
  };
  const driveError = (res: http.ServerResponse, status: number, reason: string, message = REASON_MESSAGES[reason] ?? reason) =>
    json(res, status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
  const html = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const resource = (f: StoredFile) => ({
    kind: 'drive#file', id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents,
    createdTime: f.createdTime, modifiedTime: f.modifiedTime,
    ...(f.mimeType === FOLDER_MIME ? {} : { size: String(f.data.length) }),
  });

  const createFile = (res: http.ServerResponse, metadata: Record<string, unknown>, data: Buffer) => {
    const parents = Array.isArray(metadata.parents) ? (metadata.parents as string[]) : ['root'];
    for (const p of parents) {
      if (p !== 'root' && files.get(p)?.mimeType !== FOLDER_MIME) return driveError(res, 404, 'notFound', `File not found: ${p}.`);
    }
    const t = now();
    const f: StoredFile = {
      id: id(), name: typeof metadata.name === 'string' ? metadata.name : 'Untitled', parents,
      mimeType: typeof metadata.mimeType === 'string' ? metadata.mimeType : 'application/octet-stream',
      data, createdTime: t, modifiedTime: t,
    };
    files.set(f.id, f);
    json(res, 200, resource(f));
  };
  const updateFile = (res: http.ServerResponse, fileId: string, metadata: Record<string, unknown>, data: Buffer) => {
    const f = files.get(fileId);
    if (!f) return driveError(res, 404, 'notFound', `File not found: ${fileId}.`);
    if (typeof metadata.name === 'string') f.name = metadata.name;
    f.data = data;
    f.modifiedTime = now();
    json(res, 200, resource(f));
  };

  const oauth = async (req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<boolean> => {
    if (req.method === 'GET' && u.pathname === '/o/oauth2/v2/auth') {
      const p = u.searchParams;
      const redirectUri = p.get('redirect_uri') ?? '';
      if (!p.get('client_id') || !redirectUri || p.get('response_type') !== 'code' || !p.get('state')
        || !p.get('code_challenge') || p.get('code_challenge_method') !== 'S256') {
        html(res, 400, '<h1>400. That is an error.</h1><p>Error 400: invalid_request</p>');
        return true;
      }
      const code = `4/fake-${id()}`;
      codes.set(code, { clientId: p.get('client_id')!, redirectUri, challenge: p.get('code_challenge')!, scope: p.get('scope') ?? '' });
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
      html(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Sign in with Google (test)</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f1f3f4;margin:0}main{background:#fff;max-width:28rem;margin:4rem auto;padding:2rem;border:1px solid #dadce0;border-radius:8px}
h1{font-size:1.4rem;font-weight:400}a.btn{display:inline-block;padding:.5rem 1.5rem;border-radius:4px;text-decoration:none;margin-right:.5rem}
.allow{background:#1a73e8;color:#fff}.cancel{color:#1a73e8}</style></head><body><main>
<h1>Sign in with Google (test)</h1><p><strong>Walnut</strong> wants access to your Google Account</p>
<ul><li>See, edit, create, and delete only the specific Google Drive files you use with this app</li></ul>
<p><a class="btn cancel" id="cancel" href="${attr(deny)}">Cancel</a><a class="btn allow" id="allow" href="${attr(allow)}">Allow</a></p>
</main></body></html>`);
      return true;
    }
    if (req.method === 'POST' && (u.pathname === '/token' || u.pathname === '/revoke')) {
      const form = new URLSearchParams((await readBody(req)).toString('utf-8'));
      if (u.pathname === '/revoke') {
        const t = form.get('token') ?? '';
        if (!refreshTokens.delete(t) && !accessTokens.delete(t)) return json(res, 400, { error: 'invalid_token', error_description: 'Token expired or revoked' }), true;
        json(res, 200, {});
        return true;
      }
      const bad = (desc: string) => json(res, 400, { error: 'invalid_grant', error_description: desc });
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!c) return bad('Malformed auth code.'), true;
        if (c.clientId !== form.get('client_id')) return json(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' }), true;
        if (c.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'redirect_uri_mismatch', error_description: 'Bad Request' }), true;
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return bad('Invalid code verifier.'), true;
        const rt = `1//fake-${id()}`;
        refreshTokens.set(rt, { clientId: c.clientId, scope: c.scope });
        json(res, 200, { access_token: mintAccessToken(), expires_in: ttl, refresh_token: rt, scope: c.scope, token_type: 'Bearer' });
        return true;
      }
      if (grant === 'refresh_token') {
        const r = refreshTokens.get(form.get('refresh_token') ?? '');
        if (!r) return bad('Token has been expired or revoked.'), true;
        json(res, 200, { access_token: mintAccessToken(), expires_in: ttl, scope: r.scope, token_type: 'Bearer' });
        return true;
      }
      json(res, 400, { error: 'unsupported_grant_type', error_description: `Invalid grant_type: ${grant}` });
      return true;
    }
    return false;
  };

  const drive = async (req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<void> => {
    const line = `${req.method} ${u.pathname}${u.search}`;
    const at = failures.findIndex((f) => !f.match || f.match.test(line));
    if (at >= 0) {
      const [fail] = failures.splice(at, 1);
      return driveError(res, fail.status, fail.reason);
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const exp = token ? accessTokens.get(token) : undefined;
    if (!exp || exp <= Date.now()) {
      return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', errors: [{ reason: 'authError', message: 'Invalid Credentials' }], status: 'UNAUTHENTICATED' } });
    }
    const m = req.method ?? 'GET';
    const p = u.pathname;
    const fileMatch = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(p);
    const fileId = fileMatch ? decodeURIComponent(fileMatch[1]) : undefined;
    const uploadType = u.searchParams.get('uploadType');

    if (m === 'GET' && p === '/drive/v3/about') {
      let usage = 0;
      for (const f of files.values()) usage += f.data.length;
      return json(res, 200, { user: { emailAddress: 'tester@example.com', displayName: 'Test User' }, storageQuota: { limit: String(15 * 1024 ** 3), usage: String(usage) } });
    }
    if (m === 'GET' && p === '/drive/v3/files') {
      const q = parseQuery(u.searchParams.get('q') ?? '');
      if (!q) return driveError(res, 400, 'invalid', 'Invalid Value');
      const pageSize = Math.min(opts.maxPageSize ?? 1000, Math.max(1, Number(u.searchParams.get('pageSize') ?? 100)));
      const offset = Number(u.searchParams.get('pageToken') ?? 0);
      const all = [...files.values()].filter((f) => (q.name === undefined || f.name === q.name)
        && (q.mimeType === undefined || f.mimeType === q.mimeType)
        && (q.parent === undefined || f.parents.includes(q.parent)));
      const slice = all.slice(offset, offset + pageSize);
      return json(res, 200, {
        kind: 'drive#fileList',
        ...(offset + pageSize < all.length ? { nextPageToken: String(offset + pageSize) } : {}),
        files: slice.map(resource),
      });
    }
    if (m === 'POST' && p === '/drive/v3/files') {
      return createFile(res, JSON.parse((await readBody(req)).toString('utf-8') || '{}'), Buffer.alloc(0));
    }
    if (fileId && p.startsWith('/drive/') && (m === 'GET' || m === 'DELETE')) {
      const f = files.get(fileId);
      if (!f) return driveError(res, 404, 'notFound', `File not found: ${fileId}.`);
      if (m === 'DELETE') {
        files.delete(fileId);
        res.writeHead(204);
        return void res.end();
      }
      if (u.searchParams.get('alt') === 'media') {
        res.writeHead(200, { 'Content-Type': f.mimeType, 'Content-Length': String(f.data.length) });
        return void res.end(f.data);
      }
      return json(res, 200, resource(f));
    }
    if (p.startsWith('/upload/drive/v3/files')) {
      const uploadId = u.searchParams.get('upload_id');
      if (m === 'PUT' && uploadId) {
        const s = sessions.get(uploadId);
        if (!s) return driveError(res, 404, 'notFound', 'Upload session not found.');
        sessions.delete(uploadId);
        const data = await readBody(req);
        return s.fileId ? updateFile(res, s.fileId, s.metadata, data) : createFile(res, s.metadata, data);
      }
      if ((m === 'POST' && p === '/upload/drive/v3/files') || (m === 'PATCH' && fileId)) {
        const body = await readBody(req);
        if (fileId && !files.has(fileId)) return driveError(res, 404, 'notFound', `File not found: ${fileId}.`);
        if (uploadType === 'resumable') {
          const sid = id();
          sessions.set(sid, { fileId, metadata: JSON.parse(body.toString('utf-8') || '{}') });
          res.writeHead(200, { Location: `${url}${p}?uploadType=resumable&upload_id=${sid}` });
          return void res.end();
        }
        let metadata: Record<string, unknown> = {};
        let media = body;
        if (uploadType === 'multipart') {
          try {
            ({ metadata, media } = parseMultipart(body, req.headers['content-type'] ?? ''));
          } catch {
            return driveError(res, 400, 'badContent', 'Malformed multipart body.');
          }
        } else if (uploadType !== 'media') {
          return driveError(res, 400, 'invalid', `Invalid uploadType: ${uploadType}`);
        }
        return fileId ? updateFile(res, fileId, metadata, media) : createFile(res, metadata, media);
      }
    }
    driveError(res, 404, 'notFound', `No route for ${m} ${p}`);
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(`${req.method} ${u.pathname}${u.search}`);
    void (async () => {
      if (await oauth(req, res, u)) return;
      if (u.pathname.startsWith('/drive/') || u.pathname.startsWith('/upload/')) return drive(req, res, u);
      res.writeHead(404);
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) driveError(res, 500, 'backendError', err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    env: {
      WALNUT_GDRIVE_API_URL: `${url}/drive/v3`,
      WALNUT_GDRIVE_UPLOAD_URL: `${url}/upload/drive/v3`,
      WALNUT_GDRIVE_AUTH_URL: `${url}/o/oauth2/v2/auth`,
      WALNUT_GDRIVE_TOKEN_URL: `${url}/token`,
      WALNUT_GDRIVE_REVOKE_URL: `${url}/revoke`,
      WALNUT_GDRIVE_CLIENT_ID: 'fake-client.apps.googleusercontent.com',
      WALNUT_GDRIVE_CLIENT_SECRET: 'fake-client-secret',
    },
    files: () => [...files.values()].map((f) => ({ id: f.id, name: f.name, parents: [...f.parents], size: f.data.length, mimeType: f.mimeType })),
    failNext(n, status, reason, match) {
      const r = reason ?? (status === 429 ? 'rateLimitExceeded' : status >= 500 ? 'backendError' : status === 404 ? 'notFound' : 'forbidden');
      for (let i = 0; i < n; i++) failures.push({ status, reason: r, match });
    },
    requests,
    mintAccessToken,
    addFile(name, parentId, data) {
      const t = now();
      const f: StoredFile = { id: id(), name, parents: [parentId], mimeType: 'application/octet-stream', data, createdTime: t, modifiedTime: t };
      files.set(f.id, f);
      return { id: f.id, name, parents: [parentId], size: data.length, mimeType: f.mimeType };
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const isMain = (import.meta as { main?: boolean }).main === true
  || (process.argv.includes('--serve') && /fake-google-drive\.[cm]?[jt]s$/.test(process.argv[1] ?? ''));
if (isMain) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 0;
  void startFakeGoogleDrive({ consentPage: true, port }).then((fake) => {
    process.stdout.write(`${JSON.stringify({ url: fake.url, env: fake.env })}\n`);
  });
}
