/**
 * When a local session last did anything, read from the CLI's own transcript.
 *
 * The health monitor's idle clock lives in memory (the session manager's
 * `lastEventAt`) and starts at 0 when the server restarts. It used to skip such
 * a session until its CLI wrote again, and a CLI waiting for its next message
 * writes nothing, so every deploy made every idle session unreapable. The
 * transcript survives restarts and every entry the CLI writes carries its own
 * `timestamp`; lines another writer appends without one are passed over.
 */
import fsp from 'node:fs/promises'

/** Tail sizes tried in turn: one tool result can fill the first on its own. */
const TAIL_BYTES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]

/** The newest entry timestamp in `text` (JSONL), or null. */
export function lastEntryTimestampMs(text: string): number | null {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    end = start - 1
    if (!line.includes('"timestamp"')) continue
    let entry: { timestamp?: unknown }
    try { entry = JSON.parse(line) } catch { continue }
    const ms = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/** The newest entry timestamp of the transcript at `file`, or null. */
export async function transcriptLastActivityMs(file: string): Promise<number | null> {
  let fh: fsp.FileHandle | undefined
  try {
    fh = await fsp.open(file, 'r')
    const { size } = await fh.stat()
    for (const tail of TAIL_BYTES) {
      const length = Math.min(size, tail)
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, size - length)
      let text = buf.toString('utf8')
      // A cut first line is not an entry.
      if (size > length) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1) }
      const ms = lastEntryTimestampMs(text)
      if (ms != null || length === size) return ms
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}
