/**
 * Google Drive backup store. One folder holds every object as a file whose
 * Drive name is the key verbatim (`packs/ab/<hex>`: Drive names may hold '/').
 * The OAuth scope is drive.file, so Walnut sees only the files it created.
 *
 * Drive addresses files by id, not name, so the store keeps a name -> id cache
 * filled by listing the folder. A name that is not cached is looked up before
 * a create, so a second machine writing the same key updates the file instead
 * of adding a duplicate; if a duplicate exists anyway (a past race), the
 * newest file wins.
 */
import { randomBytes } from 'node:crypto';
import { StoreNotFoundError, type BackupStore, type StoredObject } from './types.js';

const NETWORK_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,size,modifiedTime';
const RETRY_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

export interface DriveEndpoints {
  api: string;
  upload: string;
}

/** Drive's endpoints; the env overrides point tests at a fake server. */
export function driveEndpoints(): DriveEndpoints {
  return {
    api: (process.env.WALNUT_GDRIVE_API_URL || 'https://www.googleapis.com/drive/v3').replace(/\/+$/, ''),
    upload: (process.env.WALNUT_GDRIVE_UPLOAD_URL || 'https://www.googleapis.com/upload/drive/v3').replace(/\/+$/, ''),
  };
}

export type AccessTokenGetter = (forceRefresh?: boolean) => Promise<string>;

export interface DriveRetryOptions {
  /** Total tries per request, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A Drive request that failed for good: `status` 0 means it never got an answer. */
export class DriveApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = 'DriveApiError';
  }
}

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
}

interface RequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Drive's `{error:{code,message,errors:[{reason}]}}` body, read without trusting its shape. */
async function readDriveError(resp: Response): Promise<{ reason?: string; message?: string }> {
  const text = await resp.text().catch(() => '');
  try {
    const err = (JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string } }).error;
    return { reason: err?.errors?.[0]?.reason ?? err?.status, message: err?.message };
  } catch {
    return { message: text.trim().slice(0, 200) || undefined };
  }
}

/** Authorized fetch with timeouts, backoff on throttling and server errors, and one token refresh on 401. */
class DriveHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly getAccessToken: AccessTokenGetter, fetchImpl?: typeof fetch, retry: DriveRetryOptions = {}) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.attempts = Math.max(1, retry.attempts ?? 5);
    this.baseDelayMs = retry.baseDelayMs ?? 500;
    this.sleep = retry.sleep ?? defaultSleep;
  }

  /** Resolves with any 2xx response, and with a 404 when `allow404`; throws DriveApiError otherwise. */
  async request(what: string, spec: RequestSpec, allow404 = false): Promise<Response> {
    let refreshed = false;
    let forceToken = false;
    let lastError = '';
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) {
        const delay = this.baseDelayMs * 2 ** (attempt - 1);
        await this.sleep(delay + Math.random() * delay);
      }
      const token = await this.getAccessToken(forceToken);
      forceToken = false;
      let resp: Response;
      try {
        resp = await this.fetchImpl(spec.url, {
          method: spec.method,
          headers: { Authorization: `Bearer ${token}`, ...spec.headers },
          ...(spec.body !== undefined ? { body: spec.body as unknown as BodyInit } : {}),
          signal: AbortSignal.timeout(spec.timeoutMs ?? NETWORK_TIMEOUT_MS),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        lastError = name === 'TimeoutError' || name === 'AbortError'
          ? 'no answer from Google Drive in time'
          : `could not reach Google Drive (${err instanceof Error ? err.message : String(err)})`;
        continue;
      }
      if (resp.ok || (allow404 && resp.status === 404)) return resp;
      const { reason, message } = await readDriveError(resp);
      const detail = `${resp.status}${reason ? ` ${reason}` : ''}${message ? `: ${message}` : ''}`;
      if (resp.status === 401 && !refreshed) {
        refreshed = true;
        forceToken = true;
        attempt--; // a token refresh is not a retry
        continue;
      }
      const retryable = resp.status === 429 || resp.status >= 500
        || (resp.status === 403 && reason !== undefined && RETRY_REASONS.has(reason));
      if (!retryable) throw new DriveApiError(`Google Drive ${what} failed: ${detail}`, resp.status, reason);
      lastError = detail;
    }
    throw new DriveApiError(`Google Drive ${what} failed after ${this.attempts} tries: ${lastError}`, 0);
  }

  async json<T>(what: string, spec: RequestSpec): Promise<T> {
    const resp = await this.request(what, spec);
    return (await resp.json()) as T;
  }
}

/** A Drive query string literal: backslash and quote are escaped. */
function qLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function filesUrl(api: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  return `${api}/files?${qs.toString()}`;
}

function mtime(f: DriveFile): number {
  const t = Date.parse(f.modifiedTime ?? '');
  return Number.isFinite(t) ? t : 0;
}

/** Every page of a files query. */
async function listAll(http: DriveHttp, api: string, what: string, q: string, fields: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await http.json<{ files?: DriveFile[]; nextPageToken?: string }>(what, {
      method: 'GET',
      url: filesUrl(api, { q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', pageToken, spaces: 'drive' }),
    });
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

export interface DriveStoreOptions {
  folderId: string;
  folderName: string;
  getAccessToken: AccessTokenGetter;
  endpoints?: DriveEndpoints;
  fetchImpl?: typeof fetch;
  retry?: DriveRetryOptions;
}

export class DriveStore implements BackupStore {
  readonly kind = 'gdrive' as const;
  private readonly http: DriveHttp;
  /** name -> the newest file of that name in the folder. */
  private readonly byName = new Map<string, DriveFile>();

  constructor(private readonly o: DriveStoreOptions) {
    this.http = new DriveHttp(o.getAccessToken, o.fetchImpl, o.retry);
  }

  describe(): string {
    return `Google Drive: ${this.o.folderName}`;
  }

  private get ep(): DriveEndpoints {
    return this.o.endpoints ?? driveEndpoints();
  }

  private remember(files: DriveFile[]): void {
    for (const f of files) {
      const seen = this.byName.get(f.name);
      if (!seen || mtime(f) >= mtime(seen)) this.byName.set(f.name, f);
    }
  }

  /** The newest file named `key`, from the cache or a fresh lookup. */
  private async find(key: string, fresh = false): Promise<DriveFile | undefined> {
    if (!fresh) {
      const hit = this.byName.get(key);
      if (hit) return hit;
    }
    this.byName.delete(key);
    const files = await listAll(this.http, this.ep.api, `lookup of ${key}`,
      `name=${qLiteral(key)} and ${qLiteral(this.o.folderId)} in parents and trashed=false`, FILE_FIELDS);
    this.remember(files.filter((f) => f.name === key));
    return this.byName.get(key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    let existing = await this.find(key);
    if (existing) {
      const updated = await this.upload(key, body, existing.id);
      if (updated) {
        this.byName.set(key, updated);
        return;
      }
      // The cached file is gone (deleted elsewhere): look again, then create.
      existing = await this.find(key, true);
      if (existing) {
        const again = await this.upload(key, body, existing.id);
        if (again) {
          this.byName.set(key, again);
          return;
        }
      }
    }
    const created = await this.upload(key, body);
    if (created) this.byName.set(key, created);
  }

  /** Creates (no id) or replaces the content of a file; undefined when the file to update is gone. */
  private async upload(key: string, body: Buffer, id?: string): Promise<DriveFile | undefined> {
    const what = `upload of ${key}`;
    const method = id ? 'PATCH' : 'POST';
    const base = id ? `${this.ep.upload}/files/${encodeURIComponent(id)}` : `${this.ep.upload}/files`;
    const metadata = id ? {} : { name: key, parents: [this.o.folderId], mimeType: 'application/octet-stream' };

    if (body.length <= MULTIPART_MAX_BYTES) {
      const boundary = `walnut-${randomBytes(12).toString('hex')}`;
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
          + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const resp = await this.http.request(what, {
        method,
        url: `${base}?uploadType=multipart&fields=${FILE_FIELDS}`,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      }, Boolean(id));
      if (resp.status === 404) return undefined;
      return (await resp.json()) as DriveFile;
    }

    // Large bodies: open a resumable session, then send the bytes to it.
    const session = await this.http.request(what, {
      method,
      url: `${base}?uploadType=resumable&fields=${FILE_FIELDS}`,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(body.length),
      },
      body: JSON.stringify(metadata),
    }, Boolean(id));
    if (session.status === 404) return undefined;
    const location = session.headers.get('location');
    await session.body?.cancel().catch(() => {});
    if (!location) throw new DriveApiError(`Google Drive ${what} failed: no upload session address in the answer`, session.status);
    const resp = await this.http.request(what, {
      method: 'PUT',
      url: location,
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return (await resp.json()) as DriveFile;
  }

  async get(key: string): Promise<Buffer> {
    for (const fresh of [false, true]) {
      const file = await this.find(key, fresh);
      if (!file) throw new StoreNotFoundError(key);
      const resp = await this.http.request(`download of ${key}`, {
        method: 'GET',
        url: `${this.ep.api}/files/${encodeURIComponent(file.id)}?alt=media`,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      }, true);
      if (resp.status !== 404) return Buffer.from(await resp.arrayBuffer());
      await resp.body?.cancel().catch(() => {});
    }
    this.byName.delete(key);
    throw new StoreNotFoundError(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const files = await listAll(this.http, this.ep.api, `listing of ${this.o.folderName}`,
      `${qLiteral(this.o.folderId)} in parents and trashed=false`, FILE_FIELDS);
    this.byName.clear();
    this.remember(files);
    const out: StoredObject[] = [];
    for (const f of this.byName.values()) {
      if (!f.name.startsWith(prefix)) continue;
      const modifiedAt = mtime(f);
      out.push({ key: f.name, size: Number(f.size ?? 0), ...(modifiedAt ? { modifiedAt } : {}) });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async delete(key: string): Promise<void> {
    const file = await this.find(key);
    if (!file) return;
    const resp = await this.http.request(`delete of ${key}`, {
      method: 'DELETE',
      url: `${this.ep.api}/files/${encodeURIComponent(file.id)}`,
    }, true);
    await resp.body?.cancel().catch(() => {});
    this.byName.delete(key);
  }
}

/** The oldest non-trashed folder called `name`, or a new one in My Drive. */
export async function findOrCreateFolder(
  name: string,
  getAccessToken: AccessTokenGetter,
  endpoints: DriveEndpoints = driveEndpoints(),
  fetchImpl?: typeof fetch,
  retry?: DriveRetryOptions,
): Promise<{ id: string; created: boolean }> {
  const http = new DriveHttp(getAccessToken, fetchImpl, retry);
  const found = await listAll(http, endpoints.api, `search for the folder ${name}`,
    `name=${qLiteral(name)} and mimeType=${qLiteral(FOLDER_MIME)} and trashed=false`, 'id,name,createdTime');
  const matches = found.filter((f) => f.name === name)
    .sort((a, b) => (Date.parse(a.createdTime ?? '') || 0) - (Date.parse(b.createdTime ?? '') || 0));
  if (matches[0]) return { id: matches[0].id, created: false };
  const made = await http.json<DriveFile>(`creation of the folder ${name}`, {
    method: 'POST',
    url: `${endpoints.api}/files?fields=id`,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
  return { id: made.id, created: true };
}

/** Who is signed in, and how full their Drive is (limit is absent for unlimited plans). */
export async function driveAbout(
  getAccessToken: AccessTokenGetter,
  endpoints: DriveEndpoints = driveEndpoints(),
  fetchImpl?: typeof fetch,
): Promise<{ email?: string; displayName?: string; limitBytes?: number; usageBytes?: number }> {
  const http = new DriveHttp(getAccessToken, fetchImpl);
  const about = await http.json<{
    user?: { emailAddress?: string; displayName?: string };
    storageQuota?: { limit?: string; usage?: string };
  }>('account check', { method: 'GET', url: `${endpoints.api}/about?fields=${encodeURIComponent('user(emailAddress,displayName),storageQuota(limit,usage)')}` });
  const num = (s?: string) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : undefined);
  return {
    email: about.user?.emailAddress,
    displayName: about.user?.displayName,
    limitBytes: num(about.storageQuota?.limit),
    usageBytes: num(about.storageQuota?.usage),
  };
}
