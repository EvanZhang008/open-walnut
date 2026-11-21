/**
 * Content ids for the standby copy: a file is cut into fixed 1 MiB chunks, each named by its
 * sha256. A file that did not change is never sent again; a file that grew sends its last
 * chunk and the new ones; a SQLite database copied page for page (sqlite-pin.ts) sends only
 * the chunks whose pages changed, because 1 MiB is a whole number of pages.
 *
 * Fixed, not content-defined (as the backup's chunker is): cutting by content costs a pass of
 * JavaScript over every byte, which made a batch of a 1.2 GB database take about 100 s; bytes
 * inserted in the middle of a file (the case content-defined cuts help) are rare in a home,
 * whose large files are databases, appended logs and recordings.
 */
import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

export const CHUNK_BYTES = 1024 * 1024

export const sha256 = (data: Buffer | Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex')

export const CHUNK_ID = /^[0-9a-f]{64}$/

export interface FileDigest {
  size: number
  /** sha256 of the whole file */
  h: string
  /** chunk ids in order */
  chunks: string[]
  /** With `markAt`: sha256 of the first `markAt` bytes (null when the file is shorter). */
  markHash?: string | null
}

export interface DigestOptions {
  /** Read only the first `limit` bytes. */
  limit?: number
  /** Also hash the first `markAt` bytes (the last batch's size of an appended file). */
  markAt?: number
}

export type ChunkSink = (id: string, data: Buffer) => Promise<void> | void

/** Read `file` once: its size, its sha256 and its chunk ids; `sink` sees each chunk as it is read. */
export async function digestFile(file: string, sink?: ChunkSink, opts: DigestOptions = {}): Promise<FileDigest> {
  const whole = crypto.createHash('sha256')
  const mark = opts.markAt !== undefined ? crypto.createHash('sha256') : null
  let markHash: string | null | undefined = mark ? null : undefined
  const chunks: string[] = []
  const limit = opts.limit ?? Infinity
  let size = 0
  const fh = await fs.open(file, 'r')
  try {
    for (;;) {
      const want = Math.min(CHUNK_BYTES, limit - size)
      if (want <= 0) break
      const buf = Buffer.allocUnsafe(want)
      let filled = 0
      while (filled < want) {
        const { bytesRead } = await fh.read(buf, filled, want - filled, size + filled)
        if (!bytesRead) break
        filled += bytesRead
      }
      if (!filled) break
      const data = filled === want ? buf : buf.subarray(0, filled)
      whole.update(data)
      if (mark && markHash === null && opts.markAt! <= size + filled) {
        mark.update(data.subarray(0, opts.markAt! - size))
        markHash = mark.digest('hex')
      } else if (mark && markHash === null) mark.update(data)
      const id = sha256(data)
      chunks.push(id)
      size += filled
      if (sink) await sink(id, data)
      if (filled < want) break
    }
  } finally {
    await fh.close()
  }
  if (mark && markHash === null && opts.markAt === 0) markHash = mark.digest('hex')
  return { size, h: whole.digest('hex'), chunks, ...(mark ? { markHash } : {}) }
}

/** The same digest of bytes in memory (a database copied by sqlite-pin.ts). */
export function digestBuffer(data: Uint8Array): FileDigest {
  const whole = crypto.createHash('sha256').update(data).digest('hex')
  const chunks: string[] = []
  for (let off = 0; off < data.length; off += CHUNK_BYTES) chunks.push(sha256(data.subarray(off, off + CHUNK_BYTES)))
  return { size: data.length, h: whole, chunks }
}

/** sha256 of a whole file, streamed. */
export async function hashFile(file: string): Promise<{ size: number; h: string }> {
  const whole = crypto.createHash('sha256')
  let size = 0
  for await (const piece of createReadStream(file, { highWaterMark: CHUNK_BYTES })) {
    whole.update(piece as Buffer)
    size += (piece as Buffer).length
  }
  return { size, h: whole.digest('hex') }
}
