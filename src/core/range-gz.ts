/**
 * The bytes of an `fs.readRange` answer: `dataGz` (fs-read-range-gz-v1, gzip, base64) or
 * `data` (base64). Unpacked off the event loop (zlib's thread pool), at most the bytes the
 * daemon said it read, so a corrupt or oversized answer cannot grow past the range asked for.
 */
import zlib from 'node:zlib'

/** Output chunk of one unpack: a 4 MB window in a few thread-pool hops, not 256 (16 KB default). */
const GUNZIP_CHUNK = 1024 * 1024

export async function rangeBytes(res: Record<string, unknown>, bytesRead: number): Promise<Buffer> {
  if (typeof res.dataGz !== 'string') return Buffer.from(res.data as string, 'base64')
  const packed = Buffer.from(res.dataGz, 'base64')
  const out = await new Promise<Buffer>((resolve, reject) =>
    zlib.gunzip(packed, { maxOutputLength: Math.max(1, bytesRead), chunkSize: GUNZIP_CHUNK }, (err, buf) => (err ? reject(err) : resolve(buf))))
  if (out.length !== bytesRead) throw new Error(`fs.readRange: gzipped range unpacked to ${out.length} bytes, not ${bytesRead}`)
  return out
}
