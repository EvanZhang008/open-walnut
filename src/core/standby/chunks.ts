/**
 * Content ids for the standby copy: a file is cut into content-defined chunks (the backup's
 * own chunker, src/core/backup/repo/chunker.ts, used as it is) and each chunk is named by its
 * sha256. A file that did not change is never sent again, and a database copied page for page
 * (sqlite-pin.ts) shares most chunks with its last copy.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { chunkStream } from '../backup/repo/chunker.js'

export const sha256 = (data: Buffer | Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex')

export const CHUNK_ID = /^[0-9a-f]{64}$/

export interface FileDigest {
  size: number
  /** sha256 of the whole file */
  h: string
  /** chunk ids in order */
  chunks: string[]
  /** each chunk's length, in the same order */
  lengths: number[]
}

/** Read `file` once: its size, its sha256 and its chunk ids. `onChunk` sees each chunk as it is cut. */
export async function digestFile(file: string, onChunk?: (id: string, data: Buffer) => Promise<void> | void): Promise<FileDigest> {
  const whole = crypto.createHash('sha256')
  const chunks: string[] = []
  const lengths: number[] = []
  let size = 0
  for await (const chunk of chunkStream(fs.createReadStream(file))) {
    whole.update(chunk)
    size += chunk.length
    const id = sha256(chunk)
    chunks.push(id)
    lengths.push(chunk.length)
    if (onChunk) await onChunk(id, chunk)
  }
  return { size, h: whole.digest('hex'), chunks, lengths }
}

/** sha256 of a whole file, streamed. */
export async function hashFile(file: string): Promise<{ size: number; h: string }> {
  const whole = crypto.createHash('sha256')
  let size = 0
  for await (const piece of fs.createReadStream(file)) {
    whole.update(piece as Buffer)
    size += (piece as Buffer).length
  }
  return { size, h: whole.digest('hex') }
}

/** Read the chunks of `file` named in `want` (by their place in `digest`), each checked against its id. */
export async function readChunks(file: string, digest: Pick<FileDigest, 'chunks' | 'lengths'>, want: Set<string>, onChunk: (id: string, data: Buffer) => Promise<void>): Promise<void> {
  const fh = await fs.promises.open(file, 'r')
  try {
    let offset = 0
    for (let i = 0; i < digest.chunks.length; i++) {
      const id = digest.chunks[i]
      const len = digest.lengths[i]
      if (want.has(id)) {
        want.delete(id)
        const data = Buffer.alloc(len)
        const { bytesRead } = await fh.read(data, 0, len, offset)
        if (bytesRead !== len || sha256(data) !== id) throw new Error(`${file} changed in staging`)
        await onChunk(id, data)
      }
      offset += len
    }
  } finally {
    await fh.close()
  }
}
