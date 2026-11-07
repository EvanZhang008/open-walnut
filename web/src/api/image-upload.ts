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
 */
export async function uploadImages(images: ImageAttachment[]): Promise<ImageRef[]> {
  return Promise.all(images.map(async (img) => {
    // Uploaded when it was attached (composer-attachments.ts): named by that upload.
    const uploaded = uploadedImageName(img);
    if (uploaded) return { filename: uploaded };
    const res = await apiPost<{ filename?: string; url?: string }>(
      '/api/images/upload',
      { data: img.data, mediaType: img.mediaType },
      // Big attachment on a busy machine: the default 15s can be too tight.
      { timeoutMs: 60_000 },
    );
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

/** The images-folder name of a picture already uploaded (its `url`), or null. */
export function uploadedImageName(img: ImageAttachment): string | null {
  const m = img.url ? UPLOADED_URL_RE.exec(img.url) : null;
  return m && !m[1].includes('..') ? m[1] : null;
}

/**
 * Upload one picture as it is attached, reporting the bytes sent (XHR: fetch
 * reports no upload progress). Answers its `/api/images/<name>` URL.
 */
export function uploadImageWithProgress(
  img: ImageAttachment,
  opts: { signal: AbortSignal; onProgress: (sent: number) => void },
): Promise<string> {
  return new Promise((resolve, reject) => {
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
    xhr.onerror = () => { settle(); reject(new Error('The connection to Walnut dropped')); };
    xhr.onload = () => {
      settle();
      let json: { filename?: string; url?: string; error?: unknown } | null = null;
      try { json = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      const filename = json?.filename ?? json?.url?.split('/').pop();
      if (xhr.status >= 200 && xhr.status < 300 && filename) { resolve(`/api/images/${filename}`); return; }
      if (xhr.status === 413) { reject(new Error('This picture is too large to send')); return; }
      reject(new Error(typeof json?.error === 'string' ? json.error : xhr.status === 502 || xhr.status === 503 ? 'Walnut is not reachable right now' : `The upload was refused (error ${xhr.status})`));
    };
    xhr.send(body);
  });
}
