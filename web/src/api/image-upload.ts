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
