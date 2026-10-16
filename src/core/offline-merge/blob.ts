/**
 * Fetching a journal record's note body from its host (`offline.blob {sha, offset}`,
 * journal-v2, docs/plan/walnut-replica-servers-impl.md section 5 "Limits"): bodies never
 * ride inline in `offline.drain`; the daemon answers at most 2 MB per reply, so the body
 * comes in chunks by offset, within the WS frame and read limits. The bytes are checked
 * against the sha the record names before anyone uses them. Note merging (WP11) reads
 * them through here.
 */

import crypto from 'node:crypto';

export interface BlobConnection {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Largest body this Mac takes from a host (the daemon's per-home blob budget is 200 MB). */
export const MAX_BLOB_BYTES = 200 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;

/** The body with this sha256, in full, or a thrown error (a missing body, a wrong hash, a short read). */
export async function fetchOfflineBlob(conn: BlobConnection, sha: string, timeoutMs = 30_000): Promise<Buffer> {
  if (!SHA_RE.test(sha)) throw new Error('offline.blob: not a sha256');
  const parts: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await conn.send('offline.blob', { sha, offset }, timeoutMs);
    if (r.ok === false) throw new Error(String(r.error ?? 'offline.blob refused'));
    const size = Number(r.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BLOB_BYTES) throw new Error(`offline.blob: a body of ${String(r.size)} bytes is out of range`);
    if (Number(r.offset) !== offset) throw new Error(`offline.blob: asked for offset ${offset}, got ${String(r.offset)}`);
    const chunk = Buffer.from(String(r.data ?? ''), 'base64');
    parts.push(chunk);
    offset += chunk.length;
    if (r.done === true || offset >= size) {
      const body = Buffer.concat(parts);
      if (body.length !== size) throw new Error(`offline.blob: read ${body.length} of ${size} bytes`);
      const got = crypto.createHash('sha256').update(body).digest('hex');
      if (got !== sha) throw new Error('offline.blob: the body does not match its sha256');
      return body;
    }
    if (chunk.length === 0) throw new Error('offline.blob: an empty chunk before the end');
  }
  throw new Error('offline.blob: too many chunks');
}
