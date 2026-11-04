/**
 * Google Drive backup store. One folder holds every object as a file whose
 * Drive name is the key verbatim (`packs/ab/<hex>`: Drive names may hold '/').
 * The OAuth scope is drive.file, so Walnut sees only the files it created.
 *
 * Drive addresses files by id, not name, so the store keeps a name -> id cache
 * filled by listing the folder. A name that is not cached is looked up before
 * a create, so a second machine writing the same key updates the file instead
 * of adding a duplicate. A create that may have landed without an answer
 * (timeout, 5xx) is looked up again before it is retried. If duplicates exist
 * anyway (a past race), reads use the newest, a put keeps only the newest and
 * a delete removes them all.
 */
import { randomBytes } from 'node:crypto';
import { StoreNotFoundError, type BackupStore, type StoredObject } from './types.js';

const NETWORK_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,size,modifiedTime';
const RETRY_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const MAX_RETRY_AFTER_MS = 5 * 60_000;

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
  /** Tries per request when Drive fails (5xx) or cannot be reached, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  /** Tries per request when Drive throttles (429, 403 rate limit), including the first. */
  rateLimitAttempts?: number;
  rateLimitBaseDelayMs?: number;
  /** Ceiling of one throttling backoff (Retry-After may ask for more, up to 5 minutes). */
  rateLimitMaxDelayMs?: number;
  /** Replaces every request's timeout (tests use a short one). */
  timeoutMs?: number;
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

/** Retry-After as milliseconds (seconds or an HTTP date), clamped to [0, 5 min]. */
function retryAfterMs(resp: Response): number | undefined {
  const v = resp.headers.get('retry-after')?.trim();
  if (!v) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(v) ? Number(v) * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Authorized fetch with timeouts, backoff and one token refresh on 401.
 * Failures (no answer, 5xx) and throttling (429, 403 rate limit) have separate
 * budgets: throttling backs off longer and gets more tries.
 */
class DriveHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly rateLimitAttempts: number;
  private readonly rateLimitBaseDelayMs: number;
  private readonly rateLimitMaxDelayMs: number;
  private readonly timeoutMs?: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly getAccessToken: AccessTokenGetter, fetchImpl?: typeof fetch, retry: DriveRetryOptions = {}) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.attempts = Math.max(1, retry.attempts ?? 5);
    this.baseDelayMs = retry.baseDelayMs ?? 500;
    this.rateLimitAttempts = Math.max(1, retry.rateLimitAttempts ?? 8);
    this.rateLimitBaseDelayMs = retry.rateLimitBaseDelayMs ?? 1000;
    this.rateLimitMaxDelayMs = retry.rateLimitMaxDelayMs ?? 64_000;
    this.timeoutMs = retry.timeoutMs;
    this.sleep = retry.sleep ?? defaultSleep;
  }

  /** Resolves with any 2xx response, and with a 404 when `allow404`; throws DriveApiError otherwise. */
  async request(what: string, spec: RequestSpec, allow404 = false): Promise<Response> {
    return (await this.send(what, spec, allow404))!;
  }

  /**
   * Like request, for a call that is not safe to repeat blindly (a create).
   * Before retrying after a try that got no answer or a 5xx (it may have
   * taken effect), `alreadyDone` is asked; true ends the call with undefined.
   * Throttled tries were refused, so they are retried without asking.
   */
  async send(what: string, spec: RequestSpec, allow404 = false, alreadyDone?: () => Promise<boolean>): Promise<Response | undefined> {
    let refreshed = false;
    let forceToken = false;
    let lastError = '';
    let tries = 0;
    let failures = 0;
    let throttled = 0;
    let wait = 0;
    let ambiguous = false;
    for (;;) {
      if (wait > 0) await this.sleep(wait);
      if (ambiguous && alreadyDone && await alreadyDone()) return undefined;
      wait = 0;
      ambiguous = false;
      const token = await this.getAccessToken(forceToken);
      forceToken = false;
      tries++;
      let resp: Response;
      try {
        resp = await this.fetchImpl(spec.url, {
          method: spec.method,
          headers: { Authorization: `Bearer ${token}`, ...spec.headers },
          ...(spec.body !== undefined ? { body: spec.body as unknown as BodyInit } : {}),
          signal: AbortSignal.timeout(this.timeoutMs ?? spec.timeoutMs ?? NETWORK_TIMEOUT_MS),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        lastError = name === 'TimeoutError' || name === 'AbortError'
          ? 'no answer from Google Drive in time'
          : `could not reach Google Drive (${err instanceof Error ? err.message : String(err)})`;
        if (++failures >= this.attempts) break;
        wait = this.failureDelay(failures);
        ambiguous = true;
        continue;
      }
      if (resp.ok || (allow404 && resp.status === 404)) return resp;
      const { reason, message } = await readDriveError(resp);
      const detail = `${resp.status}${reason ? ` ${reason}` : ''}${message ? `: ${message}` : ''}`;
      if (resp.status === 401 && !refreshed) {
        refreshed = true;
        forceToken = true;
        tries--; // a token refresh is not a retry
        continue;
      }
      const throttle = resp.status === 429 || (resp.status === 403 && reason !== undefined && RETRY_REASONS.has(reason));
      if (!throttle && resp.status < 500) throw new DriveApiError(`Google Drive ${what} failed: ${detail}`, resp.status, reason);
      lastError = detail;
      if (throttle) {
        if (++throttled >= this.rateLimitAttempts) break;
        wait = retryAfterMs(resp) ?? this.throttleDelay(throttled);
      } else {
        if (++failures >= this.attempts) break;
        wait = retryAfterMs(resp) ?? this.failureDelay(failures);
        ambiguous = true;
      }
    }
    throw new DriveApiError(`Google Drive ${what} failed after ${tries} tries: ${lastError}`, 0);
  }

  /** Before the nth retry after a failure: base * 2^(n-1), plus up to as much again. */
  private failureDelay(n: number): number {
    const delay = this.baseDelayMs * 2 ** (n - 1);
    return delay + Math.random() * delay;
  }

  /** Before the nth retry after throttling: base * 2^(n-1) plus up to one base of jitter, capped. */
  private throttleDelay(n: number): number {
    const delay = this.rateLimitBaseDelayMs * 2 ** (n - 1) + Math.random() * this.rateLimitBaseDelayMs;
    return Math.min(this.rateLimitMaxDelayMs, delay);
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

/** Files grouped by name, newest first in each group. */
function byNewest(files: DriveFile[]): Map<string, DriveFile[]> {
  const out = new Map<string, DriveFile[]>();
  for (const f of files) {
    const group = out.get(f.name);
    if (group) group.push(f);
    else out.set(f.name, [f]);
  }
  for (const group of out.values()) group.sort((a, b) => mtime(b) - mtime(a));
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
  /** name -> every known file of that name in the folder, newest first. */
  private readonly byName = new Map<string, DriveFile[]>();

  constructor(private readonly o: DriveStoreOptions) {
    this.http = new DriveHttp(o.getAccessToken, o.fetchImpl, o.retry);
  }

  describe(): string {
    return `Google Drive: ${this.o.folderName}`;
  }

  private get ep(): DriveEndpoints {
    return this.o.endpoints ?? driveEndpoints();
  }

  /** Every file named `key` in the folder, newest first, asked of Drive (the cache is refreshed). */
  private async lookup(key: string): Promise<DriveFile[]> {
    const files = await listAll(this.http, this.ep.api, `lookup of ${key}`,
      `name=${qLiteral(key)} and ${qLiteral(this.o.folderId)} in parents and trashed=false`, FILE_FIELDS);
    const copies = byNewest(files.filter((f) => f.name === key)).get(key) ?? [];
    if (copies.length) this.byName.set(key, copies);
    else this.byName.delete(key);
    return copies;
  }

  /** The files named `key`, newest first, from the cache or a fresh lookup. */
  private async copies(key: string, fresh = false): Promise<DriveFile[]> {
    const hit = fresh ? undefined : this.byName.get(key);
    return hit?.length ? hit : this.lookup(key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    let copies = await this.copies(key);
    for (let pass = 0; pass < 2 && copies.length; pass++) {
      const [newest, ...extra] = copies;
      const updated = await this.upload(key, body, newest.id);
      if (updated) {
        this.byName.set(key, [updated]);
        await this.removeCopies(key, extra);
        return;
      }
      // The newest file is gone (deleted elsewhere): look again, then create.
      copies = pass === 0 ? await this.lookup(key) : [];
    }
    this.byName.set(key, [await this.create(key, body)]);
  }

  /** A new file named `key`; a retried create is checked so it never leaves two. */
  private async create(key: string, body: Buffer): Promise<DriveFile> {
    let checked = false;
    let landed: DriveFile | undefined;
    const made = await this.upload(key, body, undefined, async () => {
      checked = true;
      landed = (await this.lookup(key)).find((f) => Number(f.size ?? -1) === body.length);
      return landed !== undefined;
    });
    if (!checked) return made!;
    // Some try may have landed unseen besides the one that answered: keep the newest only.
    const [newest, ...extra] = await this.lookup(key);
    await this.removeCopies(key, extra);
    return newest ?? made ?? landed!;
  }

  /** Deletes these files; one that is already gone is fine. */
  private async removeCopies(key: string, files: DriveFile[]): Promise<void> {
    for (const f of files) {
      const resp = await this.http.request(`delete of ${key}`, {
        method: 'DELETE',
        url: `${this.ep.api}/files/${encodeURIComponent(f.id)}`,
      }, true);
      await resp.body?.cancel().catch(() => {});
    }
  }

  /**
   * Creates (no id) or replaces the content of a file; undefined when the file
   * to update is gone, or when a create's `alreadyDone` found it had landed.
   */
  private async upload(key: string, body: Buffer, id?: string, alreadyDone?: () => Promise<boolean>): Promise<DriveFile | undefined> {
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
      const resp = await this.http.send(what, {
        method,
        url: `${base}?uploadType=multipart&fields=${FILE_FIELDS}`,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      }, Boolean(id), alreadyDone);
      if (!resp || resp.status === 404) return undefined;
      return (await resp.json()) as DriveFile;
    }

    // Large bodies: open a resumable session (safe to repeat), then send the bytes to it.
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
    const resp = await this.http.send(what, {
      method: 'PUT',
      url: location,
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }, false, alreadyDone);
    return resp ? ((await resp.json()) as DriveFile) : undefined;
  }

  async get(key: string): Promise<Buffer> {
    for (const fresh of [false, true]) {
      const file = (await this.copies(key, fresh))[0];
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
    for (const [name, group] of byNewest(files)) this.byName.set(name, group);
    const out: StoredObject[] = [];
    for (const [name, [f]] of this.byName) {
      if (!name.startsWith(prefix)) continue;
      const modifiedAt = mtime(f);
      out.push({ key: name, size: Number(f.size ?? 0), ...(modifiedAt ? { modifiedAt } : {}) });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Deletes every file named `key`: the fresh lookup plus any cached copy it missed. */
  async delete(key: string): Promise<void> {
    const cached = this.byName.get(key) ?? [];
    const found = await this.lookup(key);
    const ids = new Set(found.map((f) => f.id));
    await this.removeCopies(key, [...found, ...cached.filter((f) => !ids.has(f.id))]);
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
