/**
 * The tail window of a big transcript, kept between reads and grown by what the CLI
 * appended (readSessionHistoryTail: the minute transcript sweep, search indexing).
 *
 * Before this, every read of a transcript over the window size moved its last 4 MB over
 * the host's link again, changed or not, and the sweep reads every live session each
 * minute (2026-10-31: 185 such reads in an hour from one host, about 780 MB, on the SSH
 * link its sessions share). Now an unchanged transcript moves no bytes, and a grown one
 * moves its last complete line (to prove the file was only appended to) plus what came
 * after it. The window is re-parsed whole each time, so the answer is the same parse a
 * fresh window read gives: the lines of the newest window bytes, from a line start.
 */

/** What the reader must answer (DaemonFileReader). */
export interface TailReader {
  readFileRange(path: string, start: number): Promise<{ content: string; fileSize: number } | null>
}

interface TailWindow {
  path: string
  mtimeMs: number
  /** Offset just past the last complete line held. */
  end: number
  /** Where that last complete line starts, and its bytes: re-read to prove an append. */
  lastLineStart: number
  lastLine: Buffer
  /** The complete lines held, ending at `end`, at most the window size. */
  lines: Buffer
  messages: unknown[]
}

/** At most this many windows (about 4 MB each) are kept, least recently used out first. */
export const MAX_TAIL_WINDOWS = 24

const windows = new Map<string, TailWindow>()

export function _resetTailWindowsForTesting(): void { windows.clear() }

function keep(key: string, w: TailWindow): void {
  windows.delete(key)
  windows.set(key, w)
  while (windows.size > MAX_TAIL_WINDOWS) {
    const oldest = windows.keys().next().value
    if (oldest === undefined) break
    windows.delete(oldest)
  }
}

/**
 * Keep the lines a fresh window read of the last `max` bytes keeps: it starts `max`
 * bytes from the end and drops everything through the first newline there.
 */
function trimToWindow(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf
  const nl = buf.indexOf(0x0a, buf.length - max)
  return nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1)
}

/** Split a read into its complete lines and the partial line after them. */
function split(buf: Buffer): { complete: Buffer; partial: Buffer } {
  const last = buf.lastIndexOf(0x0a)
  return last < 0
    ? { complete: Buffer.alloc(0), partial: buf }
    : { complete: buf.subarray(0, last + 1), partial: buf.subarray(last + 1) }
}

function lastLineOf(complete: Buffer): { start: number; line: Buffer } {
  const prev = complete.lastIndexOf(0x0a, complete.length - 2)
  return { start: prev + 1, line: complete.subarray(prev + 1) }
}

/**
 * The parse of the newest `window` bytes of `path` (line-aligned), reading only what
 * changed since the last call for the same key. `parse` gets the window text and
 * returns its messages (session-history parseHistoryWindowText). null: unreadable.
 */
export async function readTailWindow<M>(
  key: string,
  reader: TailReader,
  path: string,
  st: { mtimeMs: number; size: number },
  window: number,
  parse: (text: string) => Promise<M[]>,
): Promise<M[] | null> {
  const held = windows.get(key)
  if (held && held.path === path) {
    if (held.mtimeMs === st.mtimeMs && held.end === st.size) {
      keep(key, held)
      return held.messages as M[]
    }
    if (st.size > held.end && st.size - held.end < window) {
      const grown = await grow(key, held, reader, st, window, parse)
      if (grown) return grown
    }
  }
  return fresh(key, reader, path, st, window, parse)
}

async function grow<M>(
  key: string, held: TailWindow, reader: TailReader, st: { mtimeMs: number; size: number },
  window: number, parse: (text: string) => Promise<M[]>,
): Promise<M[] | null> {
  const res = await reader.readFileRange(held.path, held.lastLineStart)
  if (res === null) { windows.delete(key); return null }
  const buf = Buffer.from(res.content, 'utf-8')
  // The line held last must still be there, byte for byte: else the file was rewritten
  // (a /compact, a rewind), and only a fresh window is right.
  if (buf.length < held.lastLine.length || !buf.subarray(0, held.lastLine.length).equals(held.lastLine)) {
    windows.delete(key)
    return null
  }
  const { complete, partial } = split(buf.subarray(held.lastLine.length))
  const lines = trimToWindow(Buffer.concat([held.lines, complete]), window)
  const messages = await parse(Buffer.concat([lines, partial]).toString('utf-8'))
  const end = held.end + complete.length
  const last = complete.length > 0 ? lastLineOf(complete) : null
  keep(key, {
    path: held.path,
    mtimeMs: st.mtimeMs,
    end,
    lastLineStart: last ? held.end + last.start : held.lastLineStart,
    lastLine: last ? Buffer.from(last.line) : held.lastLine,
    lines: Buffer.from(lines),
    messages,
  })
  return messages
}

async function fresh<M>(
  key: string, reader: TailReader, path: string, st: { mtimeMs: number; size: number },
  window: number, parse: (text: string) => Promise<M[]>,
): Promise<M[] | null> {
  windows.delete(key)
  const start = Math.max(0, st.size - window)
  const res = await reader.readFileRange(path, start)
  if (res === null) return null
  let buf = Buffer.from(res.content, 'utf-8')
  // Skip the first (almost certainly partial) line when the read did not start at 0.
  if (start > 0) {
    const nl = buf.indexOf(0x0a)
    buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1)
  }
  const { complete, partial } = split(buf)
  const messages = await parse(buf.toString('utf-8'))
  if (complete.length > 0) {
    // Offsets counted from the end the read reached: the first line was cut anywhere,
    // maybe inside a character, so its decoded length is not its length on disk. A
    // wrong count is caught anyway: the next read checks the last line byte for byte.
    const end = res.fileSize - partial.length
    const last = lastLineOf(complete)
    keep(key, {
      path, mtimeMs: st.mtimeMs, end,
      lastLineStart: end - last.line.length, lastLine: Buffer.from(last.line),
      lines: Buffer.from(complete), messages,
    })
  }
  return messages
}
