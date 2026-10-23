/**
 * The archive of files the compiled Walnut file carries: one zstd-compressed
 * blob, `WNA1` + a little-endian u32 index length + a JSON index of
 * `[path, size, mode]` + the file bytes in index order. scripts/build-binary.mjs
 * packs it; src/binary/runtime-root.ts unpacks it on the first run of a build.
 *
 * Our own format on purpose: a tar reader would be more code than this, and
 * zstd is built into bun's zlib on every target.
 */
import zlib from 'node:zlib'

const MAGIC = Buffer.from('WNA1')

export interface ArchiveEntry {
  /** Relative path inside the runtime root, `/`-separated. */
  path: string
  mode: number
  data: Buffer
}

/** Reject anything that could land outside the runtime root. */
export function checkArchivePath(p: string): string {
  if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`asset archive: unsafe path ${JSON.stringify(p)}`)
  }
  return p
}

export function packArchive(entries: ArchiveEntry[], level = 19): Buffer {
  const index = JSON.stringify(entries.map((e) => [checkArchivePath(e.path), e.data.length, e.mode]))
  const head = Buffer.alloc(8)
  MAGIC.copy(head, 0)
  const indexBytes = Buffer.from(index, 'utf8')
  head.writeUInt32LE(indexBytes.length, 4)
  const raw = Buffer.concat([head, indexBytes, ...entries.map((e) => e.data)])
  return zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } })
}

export function unpackArchive(compressed: Buffer): ArchiveEntry[] {
  const raw = zlib.zstdDecompressSync(compressed)
  if (raw.length < 8 || !raw.subarray(0, 4).equals(MAGIC)) throw new Error('asset archive: bad header')
  const indexLength = raw.readUInt32LE(4)
  const index = JSON.parse(raw.subarray(8, 8 + indexLength).toString('utf8')) as Array<[string, number, number]>
  const out: ArchiveEntry[] = []
  let at = 8 + indexLength
  for (const [p, size, mode] of index) {
    if (at + size > raw.length) throw new Error('asset archive: truncated')
    out.push({ path: checkArchivePath(p), mode, data: raw.subarray(at, at + size) })
    at += size
  }
  return out
}
