/**
 * Upload attachments over HTTP, then send only a lightweight ref over the WS.
 *
 * ## Why images must not ride a WebSocket RPC
 *
 * The server caps a single WS frame at 4MB (`attachWss`, a deliberate
 * memory-exhaustion guard). The `ws` library enforces that cap by CLOSING the
 * connection with code 1009 — the frame is never delivered, so no handler and no
 * error response ever runs. One phone screenshot is ~4-6MB once base64-encoded,
 * so attaching an image killed the socket and rejected every in-flight RPC with
 * "WebSocket disconnected"; the auto-reconnect then re-sent it and died again.
 *
 * HTTP has no such cap (`express.json({ limit: '15mb' })`), so the bytes go up
 * via `POST /api/images/upload` (which compresses + clamps them on ingest) and
 * the RPC carries `imageRefs: [{ filename }]` — tens of bytes each.
 */

import { apiPost } from './client';
import { getDeviceToken } from './device-token';
import { TEST_RUN_HEADER, testRunLabel } from './test-run';
import {
  CONNECTION_DROPPED, SEND_TIME_UPLOAD_BUDGET_MS, SIGN_IN_REFUSED, UploadAttemptError, WALNUT_UNREACHABLE, transientStatus, withUploadRetry,
} from './upload-retry';
import type { ImageAttachment } from './chat';

/** Pointer to an uploaded image, as accepted by the `chat` / `session:send` RPCs. */
export interface ImageRef {
  filename: string;
}

/**
 * Upload every attachment and return their refs, in the original order.
 *
 * Rejects if ANY upload fails: a partially-attached message is worse than a
 * failed send the user can retry with their text and images still in the box.
 * A dropped connection or a restarting server is waited out first
 * (upload-retry.ts), up to the send-time budget.
 */
export async function uploadImages(images: ImageAttachment[]): Promise<ImageRef[]> {
  return Promise.all(images.map(async (img) => {
    // Uploaded when it was attached (composer-attachments.ts): named by that upload.
    const uploaded = uploadedImageName(img);
    if (uploaded) return { filename: uploaded };
    const res = await withUploadRetry(() => apiPost<{ filename?: string; url?: string }>(
      '/api/images/upload',
      { data: img.data, mediaType: img.mediaType },
      // Big attachment on a busy machine: the default 15s can be too tight.
      { timeoutMs: 60_000 },
    ), { budgetMs: SEND_TIME_UPLOAD_BUDGET_MS });
    // `filename` is authoritative; fall back to parsing `url` for an older server.
    const filename = res.filename ?? res.url?.split('/').pop();
    if (!filename) throw new Error('Image upload returned no filename');
    return { filename };
  }));
}

/**
 * Build the image half of an RPC payload: `imageRefs` after uploading.
 * Returns an empty object when there is nothing attached.
 */
export async function buildImageRefsPayload(
  images?: ImageAttachment[],
): Promise<{ imageRefs?: ImageRef[] }> {
  if (!images || images.length === 0) return {};
  return { imageRefs: await uploadImages(images) };
}

const UPLOADED_URL_RE = /^\/api\/images\/([\w.-]+)$/;

/**
 * The server refused a send because an uploaded picture it names is gone (images.ts
 * `image_not_found`, e.g. the images folder was cleaned while the message waited). Sending the
 * same name again fails the same way forever.
 */
export function isStaleImageRefError(message: string | undefined): boolean {
  return !!message && /is no longer on the server/.test(message);
}

/**
 * The pictures with their upload names dropped, so the next send uploads them again from their
 * bytes; null when one carries no bytes (only its name), which no resend can bring back.
 */
export function withoutUploadedNames(images: ImageAttachment[] | undefined): ImageAttachment[] | null {
  if (!images?.length || images.some((img) => !img.data)) return null;
  return images.map(({ url: _url, ...img }) => img);
}

/** The images-folder name of a picture already uploaded (its `url`), or null. */
export function uploadedImageName(img: ImageAttachment): string | null {
  const m = img.url ? UPLOADED_URL_RE.exec(img.url) : null;
  return m && !m[1].includes('..') ? m[1] : null;
}

/**
 * Upload one picture as it is attached, reporting the bytes sent (XHR: fetch
 * reports no upload progress). Answers its `/api/images/<name>` URL. A dropped
 * connection or a restarting server is waited out with no limit (upload-retry.ts):
 * `onWaiting` says why while it waits; removing the picture aborts.
 */
export function uploadImageWithProgress(
  img: ImageAttachment,
  opts: { signal: AbortSignal; onProgress: (sent: number) => void; onWaiting?: (reason: string | null) => void },
): Promise<string> {
  return withUploadRetry(() => uploadImageOnce(img, opts), { signal: opts.signal, onWaiting: opts.onWaiting });
}

/** One try: a real refusal fails for good, a dropped link or restarting server is tried again. */
function uploadImageOnce(
  img: ImageAttachment,
  opts: { signal: AbortSignal; onProgress: (sent: number) => void },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/images/upload');
    xhr.setRequestHeader('Content-Type', 'application/json');
    const token = getDeviceToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    const label = testRunLabel();
    if (label) xhr.setRequestHeader(TEST_RUN_HEADER, label);
    // Base64 is 4/3 of the bytes: progress is reported on the picture's own size.
    const body = JSON.stringify({ data: img.data, mediaType: img.mediaType });
    const ratio = img.data.length > 0 ? (img.data.length * 3 / 4) / body.length : 1;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress(Math.round(e.loaded * ratio)); };
    const onAbort = () => xhr.abort();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const settle = () => opts.signal.removeEventListener('abort', onAbort);
    xhr.onabort = () => { settle(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    xhr.onerror = () => { settle(); reject(new UploadAttemptError(CONNECTION_DROPPED, true)); };
    xhr.ontimeout = xhr.onerror;
    xhr.onload = () => {
      settle();
      let json: { filename?: string; url?: string; error?: unknown } | null = null;
      try { json = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      const filename = json?.filename ?? json?.url?.split('/').pop();
      if (xhr.status >= 200 && xhr.status < 300 && filename) { resolve(`/api/images/${filename}`); return; }
      // The server's words: a plain string, or a replica's { code, message }.
      const e = json?.error;
      const said = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : '';
      if (transientStatus(xhr.status)) { reject(new UploadAttemptError(said || WALNUT_UNREACHABLE, true)); return; }
      if (xhr.status === 413) { reject(new UploadAttemptError('This picture is too large to send: attach a smaller one', false)); return; }
      if (xhr.status === 401) { reject(new UploadAttemptError(SIGN_IN_REFUSED, false)); return; }
      reject(new UploadAttemptError(said || `The upload was refused (error ${xhr.status}): remove it and attach it again`, false));
    };
    xhr.send(body);
  });
}
