/**
 * Host-local delivery-marker lookup (`markers.find`, capability 'marker-find-v1').
 *
 * Every delivery of a phone message writes one walnut-injected marker line into
 * the session's stream, carrying the message's id (`walnutMessageId`). The
 * cloud companion asks which of a session's messages reached the CLI before it
 * delivers a later one by the host's direct path. It used to pull the newest
 * 2 MB of the stream over the bridge and search that, so a marker hours of
 * output back was never found: a direct send was then held for up to a day
 * while the Mac slept, and every sweep pass pulled another 2 MB (gate r3, N6).
 * The search runs here instead, next to the file, newest bytes first, and only
 * the ids found cross the bridge.
 *
 * Bounded on every axis: at most MARKER_FIND_MAX_IDS ids of at most
 * MARKER_FIND_MAX_ID_LEN characters, at most MARKER_FIND_MAX_BYTES read, in
 * MARKER_FIND_CHUNK_BYTES reads that each yield to the event loop.
 * `complete` = the whole file was searched (no marker past the bound was
 * missed). The bun twin imports this; daemon-source.ts carries a hand-inlined
 * copy (the template cannot import). Keep the two in sync.
 */

import fsp from 'node:fs/promises'

export const MARKER_FIND_MAX_IDS = 200
export const MARKER_FIND_MAX_ID_LEN = 200
export const MARKER_FIND_MAX_BYTES = 256 * 1024 * 1024
export const MARKER_FIND_CHUNK_BYTES = 4 * 1024 * 1024

export interface MarkerFindResult {
  found: string[]
  /** The whole file was searched. */
  complete: boolean
  size: number
  scanned: number
}

/** The ids, validated; a string says what is wrong. */
export function validMarkerIds(ids: unknown): string[] | string {
  if (!Array.isArray(ids)) return 'markers.find: ids must be an array'
  if (ids.length > MARKER_FIND_MAX_IDS) return 'markers.find: too many ids'
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MARKER_FIND_MAX_ID_LEN) return 'markers.find: invalid id'
  }
  return ids as string[]
}

/** Search `file` from its end for the marker of each id. A missing file has none. */
export async function findDeliveryMarkers(
  file: string, ids: string[], maxBytes = MARKER_FIND_MAX_BYTES, chunkBytes = MARKER_FIND_CHUNK_BYTES,
): Promise<MarkerFindResult> {
  const needles = new Map(ids.map((id) => [id, Buffer.from('"walnutMessageId":' + JSON.stringify(id))]))
  const found = new Set<string>()
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(file, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { found: [], complete: true, size: 0, scanned: 0 }
    throw err
  }
  try {
    const size = (await handle.stat()).size
    let overlap = 0
    for (const needle of needles.values()) overlap = Math.max(overlap, needle.length)
    let end = size
    let scanned = 0
    while (end > 0 && found.size < needles.size && scanned < maxBytes) {
      const start = Math.max(0, end - chunkBytes)
      // Each read reaches `overlap` bytes into the newer chunk: a marker cut by the boundary is still whole here.
      const readEnd = Math.min(size, end + overlap)
      const buf = Buffer.alloc(readEnd - start)
      await handle.read(buf, 0, buf.length, start)
      for (const [id, needle] of needles) {
        if (!found.has(id) && buf.indexOf(needle) !== -1) found.add(id)
      }
      scanned += end - start
      end = start
    }
    return { found: [...found], complete: end === 0, size, scanned }
  } finally {
    await handle.close().catch(() => {})
  }
}
