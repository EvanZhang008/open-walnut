/**
 * Content-defined chunking (a FastCDC-style gear hash) for backup blobs.
 *
 * A big file is cut where its CONTENT says so, not every N bytes, so bytes
 * inserted near the start of a file move only the chunks around them and the
 * rest dedupe against the previous backup. That matters for the sqlite
 * snapshots: they are re-made every run, and most of their pages are the same.
 *
 * Sizes: chunks are 128 KiB to 2 MiB, about 512 KiB on average. Files at or
 * below SMALL_FILE_BYTES are one blob as they are, with no scan.
 *
 * A run cuts and ids a big file off the event loop (chunk-worker.ts, which holds the same cut
 * rule as a worker's source: tests/core/backup/repo-chunk-worker.test.ts holds the two equal).
 */
import type { Readable } from 'node:stream';

export const MIN_CHUNK = 128 * 1024;
export const AVG_CHUNK = 512 * 1024;
export const MAX_CHUNK = 2 * 1024 * 1024;
export const SMALL_FILE_BYTES = 1024 * 1024;

/** Fixed pseudo-random gear table: every Walnut must cut the same file the same way. */
export const GEAR: Uint32Array = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    // xorshift32, seeded with a constant: deterministic across machines and versions.
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    table[i] = x;
  }
  return table;
})();

/** Normalized chunking: a stricter mask before the average size, a looser one after. */
export const MASK_STRICT = 0xfffff800 >>> 0; // 21 high bits
export const MASK_LOOSE = 0xffff8000 >>> 0; // 17 high bits

/** Length of the next chunk at the start of `buf` (all of it when shorter than MIN_CHUNK). */
export function findCut(buf: Buffer, end = buf.length): number {
  if (end <= MIN_CHUNK) return end;
  const limit = Math.min(end, MAX_CHUNK);
  const normal = Math.min(limit, AVG_CHUNK);
  let h = 0;
  let i = MIN_CHUNK;
  for (; i < normal; i++) {
    h = ((h << 1) + GEAR[buf[i]]) >>> 0;
    if ((h & MASK_STRICT) === 0) return i + 1;
  }
  for (; i < limit; i++) {
    h = ((h << 1) + GEAR[buf[i]]) >>> 0;
    if ((h & MASK_LOOSE) === 0) return i + 1;
  }
  return limit;
}

/** Split a whole buffer into chunks (tests, and trees built in memory). */
export function chunkBuffer(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const rest = buf.subarray(offset);
    const len = findCut(rest);
    out.push(rest.subarray(0, len));
    offset += len;
  }
  return out;
}

/**
 * Chunk a stream. Keeps at most 2 * MAX_CHUNK plus one read of bytes in memory,
 * and cuts only once MAX_CHUNK bytes are pending (or the stream ended), so the
 * cuts are exactly those chunkBuffer would make over the whole file.
 */
export async function* chunkStream(stream: Readable): AsyncGenerator<Buffer> {
  // The reads wait in a list and are joined once 2 * MAX_CHUNK bytes are in: joining every read onto
  // what was pending copied up to 2 MiB per 64 KiB read, about 32 MiB of buffers per chunk
  // (2026-11-25 on the Mac: a run's ~300 MB of changed files took the server from 2 to 5.6 GB).
  let parts: Buffer[] = [];
  let size = 0;
  const cutFull = function* (): Generator<Buffer> {
    let pending = parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
    while (pending.length >= MAX_CHUNK) {
      const len = findCut(pending);
      yield Buffer.from(pending.subarray(0, len));
      pending = pending.subarray(len);
    }
    // The rest is under MAX_CHUNK: its own copy, so the joined buffer is not kept for it.
    parts = pending.length ? [Buffer.from(pending)] : [];
    size = pending.length;
  };
  for await (const piece of stream) {
    const b = piece as Buffer;
    if (!b.length) continue;
    parts.push(b);
    size += b.length;
    // Twice MAX_CHUNK: the rest a cut leaves is under MAX_CHUNK, so each byte is joined about twice.
    if (size >= 2 * MAX_CHUNK) yield* cutFull();
  }
  let pending = parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
  while (pending.length > 0) {
    const len = findCut(pending);
    yield Buffer.from(pending.subarray(0, len));
    pending = pending.subarray(len);
  }
}
