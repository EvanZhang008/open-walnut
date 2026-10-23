/**
 * One download primitive for everything Walnut fetches (components, the speech
 * runtime, its models, uv): resumes a `.part` left by an earlier try with a Range
 * request, retries what a retry can fix, gives up on a connection that stops
 * sending, and stays under a deadline. Async streams only: it never holds the
 * event loop, and the file is written as it arrives.
 *
 * It does not judge the bytes: callers check them against the hash they pin
 * (a component's tar hash, a model's file hash) before using anything.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ComponentError } from './types.js';

export interface DownloadOptions {
  /** The size the caller expects: the progress total when the server sends none, and the size bound. */
  expectedBytes?: number;
  /** Fail past this many bytes (default: twice expectedBytes plus 1 MB, else unbounded). */
  maxBytes?: number;
  onProgress?: (done: number, total: number | null) => void;
  signal?: AbortSignal;
  /** An attempt that receives nothing for this long is dropped and retried (default 30 s). */
  idleTimeoutMs?: number;
  /** All attempts together (default 30 min). */
  deadlineMs?: number;
  /** Attempts after the first, each resuming the partial file (default 3). */
  retries?: number;
  /** First wait between attempts; each next one is three times longer (default 1 s). */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  /** Where the bytes arrive before the rename (default `<dest>.part`). */
  partFile?: string;
  /**
   * Checks the complete file before it is renamed to `dest` (a pinned hash). A
   * stop while it runs leaves the complete `.part`, which the next call verifies
   * again without fetching anything. When it throws, the part is removed.
   */
  verify?: (file: string) => Promise<void>;
}

const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

function retryable(message: string, code = 'network', status?: number): ComponentError {
  return Object.assign(new ComponentError(message, code, status), { retryable: true });
}

function isRetryable(err: unknown): boolean {
  return (err as { retryable?: boolean } | null)?.retryable === true;
}

async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

async function writeAll(fh: FileHandle, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

/** `bytes <start>-<end>/<total|*>` */
function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  const m = value ? /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(value.trim()) : null;
  return m ? { start: Number(m[1]), total: m[2] === '*' ? null : Number(m[2]) } : null;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ComponentError('Download stopped', 'aborted')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ComponentError('Download stopped', 'aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Download `url` to `dest` (through `dest.part`); resolves with the byte count. */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<{ bytes: number }> {
  const part = opts.partFile ?? `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const finish = async (bytes: number): Promise<{ bytes: number }> => {
    if (opts.verify) {
      try {
        await opts.verify(part);
      } catch (err) {
        await rm(part, { force: true });
        throw err;
      }
    }
    await rename(part, dest);
    return { bytes };
  };
  // A part as long as the file: an earlier call fetched it all and stopped before
  // the rename (during its verify). Asking for more would only answer 416.
  const have = await sizeOf(part);
  if (opts.expectedBytes && have === opts.expectedBytes) return finish(have);
  const deadlineAt = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(backoff * 3 ** (attempt - 1), Math.max(0, deadlineAt - Date.now()));
      await sleep(wait, opts.signal);
    }
    if (Date.now() >= deadlineAt) break;
    let bytes: number;
    try {
      bytes = await attemptOnce(url, part, deadlineAt, opts);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastErr = err;
      continue;
    }
    return finish(bytes);
  }
  if (Date.now() >= deadlineAt) throw new ComponentError(`Download did not finish within ${Math.round((opts.deadlineMs ?? DEFAULT_DEADLINE_MS) / 1000)} s`, 'deadline');
  throw lastErr;
}

async function attemptOnce(url: string, part: string, deadlineAt: number, opts: DownloadOptions): Promise<number> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const expected = opts.expectedBytes;
  const maxBytes = opts.maxBytes ?? (expected ? expected * 2 + 1024 * 1024 : Number.POSITIVE_INFINITY);
  const have = await sizeOf(part);
  const ctrl = new AbortController();
  let why: 'idle' | 'deadline' | null = null;
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let idleTimer = setTimeout(() => { why = 'idle'; ctrl.abort(); }, idleMs);
  // Clamped: setTimeout fires at once for a delay past 2^31-1 ms.
  const deadlineTimer = setTimeout(() => { why = 'deadline'; ctrl.abort(); }, Math.min(MAX_TIMER_MS, Math.max(0, deadlineAt - Date.now())));
  try {
    if (opts.signal?.aborted) throw new ComponentError('Download stopped', 'aborted');
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: have ? { Range: `bytes=${have}-` } : {},
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (res.status === 416) {
      // The partial file is as long as the whole one or longer: start over.
      await res.body?.cancel().catch(() => {});
      await rm(part, { force: true });
      throw retryable('The partial download no longer matches the file; starting over');
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      const msg = `Download answered HTTP ${res.status}`;
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw retryable(msg, 'http', res.status);
      throw new ComponentError(msg, 'http', res.status);
    }
    const length = res.headers.get('content-length');
    const contentLength = length !== null && /^\d+$/.test(length) ? Number(length) : null;
    let start = 0;
    let total: number | null = contentLength;
    if (res.status === 206) {
      const range = parseContentRange(res.headers.get('content-range'));
      if (!have || (range && range.start !== have)) {
        await res.body.cancel().catch(() => {});
        await rm(part, { force: true });
        throw retryable('The server resumed at the wrong offset; starting over');
      }
      start = have;
      total = range?.total ?? (contentLength !== null ? have + contentLength : null);
    }
    // A 200 to a Range request: the server sends the whole file, so the partial is dropped.
    if (total !== null && total > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new ComponentError(`The download is ${total} bytes, far more than the ${expected} expected`, 'size');
    }
    let done = start;
    let lastReport = 0;
    const fh = await open(part, start ? 'a' : 'w');
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { why = 'idle'; ctrl.abort(); }, idleMs);
        done += value.length;
        if (done > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ComponentError(`The download grew past ${maxBytes} bytes`, 'size');
        }
        await writeAll(fh, value);
        if (opts.onProgress && Date.now() - lastReport > 250) {
          lastReport = Date.now();
          opts.onProgress(done, total ?? expected ?? null);
        }
      }
    } finally {
      await fh.close();
    }
    if (total !== null && done !== total) throw retryable(`The connection closed after ${done} of ${total} bytes`);
    opts.onProgress?.(done, total ?? done);
    return done;
  } catch (err) {
    if (err instanceof ComponentError) throw err;
    if (why === 'idle') throw retryable(`No data for ${Math.round(idleMs / 1000)} s`);
    if (why === 'deadline') throw new ComponentError('The download ran past its deadline', 'deadline');
    if (opts.signal?.aborted) throw new ComponentError('Download stopped', 'aborted');
    const code = (err as { code?: string } | null)?.code;
    // The disk refused (permission, space): a retry fails the same way.
    if (code && /^E(ACCES|PERM|NOSPC|ROFS|ISDIR|NOTDIR)$/.test(code)) throw err;
    throw retryable(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
