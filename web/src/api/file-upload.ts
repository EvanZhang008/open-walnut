/**
 * Any file a person attaches to a message (a log, a PDF, a zip), uploaded the
 * moment it is attached, in chunks, with its own progress.
 *
 * The bytes go over HTTP, never the WebSocket (its frame cap closes the socket,
 * see image-upload.ts), through the chunk lane the phone uses:
 *   - a live session: `PUT /api/v1/sessions/:id/uploads/:uploadId`, written on
 *     the session's own host (its task directory);
 *   - no session yet (a new session's first message):
 *     `PUT /api/v1/uploads/:uploadId`, written on the machine Walnut runs on;
 *     a session that then starts on another host gets the file shipped there
 *     before its first line (src/providers/outbound-uploads.ts).
 * The host answers the saved path, and the message names the paths under one
 * header line (`withFilePaths`), the same words the phone writes, so every send
 * path (queue, retry, interrupt) carries them as plain text. MIRROR of
 * src/core/sessions/session-uploads.ts (pinned by a contract test).
 */

import { FILES_ATTACHED_LINE, attachmentHeaderBlock, splitAttachmentHeaders } from '@open-walnut/attachment-headers';
import { getDeviceToken } from './device-token';
import { TEST_RUN_HEADER, testRunLabel } from './test-run';

/** One chunk, as the server takes it (UPLOAD_CHUNK_BYTES). */
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
/** One file (MAX_UPLOAD_BYTES; the phone keeps the same cap). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
/** Files per message, beside the pictures (the phone keeps the same cap). */
export const MAX_FILES = 10;
/** The header of a message with attached files (src/lib/attachment-headers.ts). */
export { FILES_ATTACHED_LINE };

/** Where an attachment's bytes go: a session's host, or this machine before a session exists. */
export interface UploadTarget { sessionId?: string }

const MAX_NAME_BYTES = 200;
/**
 * A whole file is hashed for the host's check only up to this size: WebCrypto
 * holds it in memory, and two upload at once (a phone's web view gives up well
 * before a gigabyte).
 */
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
/** Tries per chunk when the link drops (503) or the request fails outright. */
const CHUNK_TRIES = 4;

/**
 * The name the host will save, by its rule (session-uploads.ts isUploadName): no
 * slash, backslash or control character, no leading dot or space, at most 200
 * UTF-8 bytes, keeping the extension when it has to shorten.
 */
export function safeUploadName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().replace(/^[.\s]+/, '');
  if (name.endsWith('.walnut-part')) name += '_';
  const enc = new TextEncoder();
  if (enc.encode(name).length > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    let stem = ext ? name.slice(0, dot) : name;
    while (stem && enc.encode(stem + ext).length > MAX_NAME_BYTES) stem = Array.from(stem).slice(0, -1).join('');
    name = (stem + ext).trim();
  }
  return name || 'file';
}

/** The message naming saved files under the header (session-uploads.ts withFilePaths). */
export function withFilePaths(text: string, paths: string[]): string {
  return attachmentHeaderBlock('files', paths) + text;
}

/** The parts of a stored message: the paths of its attachment headers and the person's words. */
export interface AttachmentParts {
  images: string[];
  files: string[];
  body: string;
}

/**
 * The attachment headers at the front of a message, read with the parser the
 * server and the queue card use (src/lib/attachment-headers.ts). Null when the
 * message has none, so an ordinary one takes the path it always took.
 */
export function attachmentParts(text: string): AttachmentParts | null {
  const split = splitAttachmentHeaders(text);
  if (split.images.length === 0 && split.files.length === 0) return null;
  return { images: split.images, files: split.files, body: split.text };
}

/** A friendly size: "812 B", "4.2 KB", "3 MB", "4 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[u]}`;
}

export class FileUploadError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'FileUploadError';
  }
}

export function newUploadId(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`;
  return `up-${id}`;
}

interface ChunkReply { received: number; size: number; done: boolean; path?: string }
type ChunkOutcome =
  | { kind: 'reply'; reply: ChunkReply }
  | { kind: 'resume'; at: number }
  | { kind: 'restart' }
  | { kind: 'retry'; message: string }
  | { kind: 'fail'; message: string; code?: string };

function chunkUrl(target: UploadTarget, uploadId: string, q: Record<string, string>): string {
  const base = target.sessionId
    ? `/api/v1/sessions/${encodeURIComponent(target.sessionId)}/uploads/${encodeURIComponent(uploadId)}`
    : `/api/v1/uploads/${encodeURIComponent(uploadId)}`;
  return `${base}?${new URLSearchParams(q).toString()}`;
}

/** One chunk over XHR, the only browser API that reports upload progress. */
function putChunk(url: string, body: Blob, signal: AbortSignal, onSent: (bytes: number) => void): Promise<ChunkOutcome> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const token = getDeviceToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    const label = testRunLabel();
    if (label) xhr.setRequestHeader(TEST_RUN_HEADER, label);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onSent(e.loaded); };
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onabort = () => { signal.removeEventListener('abort', onAbort); reject(new DOMException('Upload cancelled', 'AbortError')); };
    xhr.onerror = () => { signal.removeEventListener('abort', onAbort); resolve({ kind: 'retry', message: 'The connection to Walnut dropped' }); };
    xhr.ontimeout = xhr.onerror;
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort);
      let json: Record<string, unknown> | null = null;
      try { json = JSON.parse(xhr.responseText) as Record<string, unknown>; } catch { /* not JSON */ }
      const err = (json?.error ?? null) as { code?: string; message?: string; received?: number } | null;
      if (xhr.status >= 200 && xhr.status < 300 && json) { resolve({ kind: 'reply', reply: json as unknown as ChunkReply }); return; }
      if (xhr.status === 409 && err?.code === 'upload_offset_mismatch') { resolve({ kind: 'resume', at: Math.max(0, Number(err.received ?? 0)) }); return; }
      if (xhr.status === 422) { resolve({ kind: 'restart' }); return; }
      const said = err?.message || (typeof json?.error === 'string' ? json.error : '');
      if (xhr.status === 503 || xhr.status === 502 || xhr.status === 0) {
        resolve({ kind: 'retry', message: said || 'The session\'s host is not reachable right now' });
        return;
      }
      const message = said || `The upload was refused (error ${xhr.status})`;
      if (xhr.status === 404 && !target404Known(json)) {
        resolve({ kind: 'fail', message: 'This Walnut cannot take files yet: update it, then try again', code: 'not_supported' });
        return;
      }
      resolve({ kind: 'fail', message, code: err?.code });
    };
    xhr.send(body);
  });
}

/** A 404 that names the session (gone) rather than a server without the route. */
function target404Known(json: Record<string, unknown> | null): boolean {
  const err = json?.error as { code?: string } | undefined;
  return err?.code === 'not_found';
}

async function sha256Hex(file: Blob): Promise<string | undefined> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle || file.size > MAX_HASHED_BYTES) return undefined;
  try {
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Upload cancelled', 'AbortError')); }, { once: true });
});

export interface UploadOptions {
  uploadId: string;
  name: string;
  signal: AbortSignal;
  /** Bytes the host holds so far (monotonic within one try). */
  onProgress: (sent: number) => void;
}

/**
 * Upload `file` and answer its path on the host. Resumes from what the host
 * holds; a chunk whose link dropped is sent again a few times before it fails.
 * Rejects with FileUploadError (shown on the card) or an AbortError (removed).
 */
export async function uploadFile(file: Blob, target: UploadTarget, opts: UploadOptions): Promise<string> {
  const size = file.size;
  if (size > MAX_FILE_BYTES) throw new FileUploadError(`Files can be at most ${formatBytes(MAX_FILE_BYTES)}`, 'too_large');
  const sha256 = await sha256Hex(file);
  let offset = 0;
  let restarts = 0;
  let tries = 0;
  for (;;) {
    const end = Math.min(size, offset + UPLOAD_CHUNK_BYTES);
    const last = end === size;
    const q: Record<string, string> = { offset: String(offset), size: String(size), name: opts.name };
    if (last && sha256) q.sha256 = sha256;
    const at = offset;
    const out = await putChunk(chunkUrl(target, opts.uploadId, q), file.slice(offset, end), opts.signal, (sent) => opts.onProgress(at + sent));
    if (out.kind === 'reply') {
      tries = 0;
      if (out.reply.done && out.reply.path) { opts.onProgress(size); return out.reply.path; }
      offset = Math.max(offset, Math.min(size, out.reply.received));
      opts.onProgress(offset);
      if (last && !out.reply.done) throw new FileUploadError('The host did not finish the file');
      continue;
    }
    if (out.kind === 'resume') { offset = Math.min(out.at, size); opts.onProgress(offset); continue; }
    if (out.kind === 'restart') {
      if (++restarts > 1) throw new FileUploadError('The file arrived different from what was sent', 'upload_checksum_mismatch');
      offset = 0;
      opts.onProgress(0);
      continue;
    }
    if (out.kind === 'retry') {
      if (++tries >= CHUNK_TRIES) throw new FileUploadError(out.message, 'offline');
      await pause(600 * 2 ** (tries - 1), opts.signal);
      continue;
    }
    throw new FileUploadError(out.message, out.code);
  }
}
