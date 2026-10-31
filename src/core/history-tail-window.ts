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

/** What the reader must answer (DaemonFileReader): bytes [start, EOF), undecoded. */
export interface TailReader {
  readFileRangeBuffer(path: string, start: number): Promise<{ buf: Buffer; fileSize: number } | null>
}

interface TailWindow {
  path: string
  /** The file's incarnation (DaemonFileReader stat epoch), when the daemon says it. */
  epoch?: string
  /**
   * The stat's mtime when the read ended where that stat said the file ended; null when
   * more had landed by the read (the next poll then sees an equal size, a newer mtime).
   */
  mtimeMs: number | null
  /** Offset just past the last complete line held. */
  end: number
  /** Where that last complete line starts, and its bytes: re-read to prove an append. */
  lastLineStart: number
  lastLine: Buffer
  /** The complete lines held, ending at `end`, at most the window size. */
  lines: Buffer
  messages: unknown[]
}

/** At most this many windows are kept, least recently used out first. */
export const MAX_TAIL_WINDOWS = 24
/**
 * And at most this many bytes of them, counted as twice the window's lines (the
 * lines plus their parse). Memory pressure cuts it to a quarter (setTailWindowShedding).
 */
export const MAX_TAIL_WINDOW_BYTES = 192 * 1024 * 1024

const windows = new Map<string, TailWindow>()
let heldBytes = 0
let budget = MAX_TAIL_WINDOW_BYTES

const weight = (w: TailWindow): number => w.lines.length * 2

export function _resetTailWindowsForTesting(): void { windows.clear(); heldBytes = 0; budget = MAX_TAIL_WINDOW_BYTES }

function drop(key: string): void {
  const w = windows.get(key)
  if (!w) return
  heldBytes -= weight(w)
  windows.delete(key)
}

/** Drop every window of a session (a rewind commit: same bytes, new meaning). */
export function dropTailWindows(keyPrefix: string): void {
  for (const k of [...windows.keys()]) if (k.startsWith(keyPrefix)) drop(k)
}

/** Memory pressure: a quarter of the budget, least recent first; the newest stays. */
export function setTailWindowShedding(shedding: boolean): void {
  budget = shedding ? Math.floor(MAX_TAIL_WINDOW_BYTES / 4) : MAX_TAIL_WINDOW_BYTES
  evict()
}

function evict(): void {
  const keys = [...windows.keys()]
  const newest = keys[keys.length - 1]
  for (const k of keys) {
    if (windows.size <= MAX_TAIL_WINDOWS && heldBytes <= budget) break
    if (k !== newest) drop(k)
  }
}

function keep(key: string, w: TailWindow): void {
  drop(key)
  windows.set(key, w)
  heldBytes += weight(w)
  evict()
}

/** The window held for `key` moves to most recently used. */
function touch(key: string, w: TailWindow): void {
  windows.delete(key)
  windows.set(key, w)
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
  st: { mtimeMs: number; size: number; epoch?: string },
  window: number,
  parse: (text: string) => Promise<M[]>,
): Promise<M[] | null> {
  const held = windows.get(key)
  if (held && held.path === path && held.epoch === st.epoch) {
    if (held.mtimeMs === st.mtimeMs && held.end === st.size) {
      touch(key, held)
      return held.messages as M[]
    }
    // Equal size is growth only when the last read went past its stat (an append that
    // landed between the two): then its last line is read again and checked. Any other
    // equal size with a new mtime may be an in-place rewrite, which no line check sees.
    const grew = st.size > held.end || (st.size === held.end && held.mtimeMs === null)
    if (grew && st.size - held.end < window) {
      const grown = await grow(key, held, reader, st, window, parse)
      if (grown) return grown
    }
  }
  return fresh(key, reader, path, st, window, parse)
}

async function grow<M>(
  key: string, held: TailWindow, reader: TailReader, st: { mtimeMs: number; size: number; epoch?: string },
  window: number, parse: (text: string) => Promise<M[]>,
): Promise<M[] | null> {
  const res = await reader.readFileRangeBuffer(held.path, held.lastLineStart)
  if (res === null) { drop(key); return null }
  const buf = res.buf
  // The line held last must still be there, byte for byte: else the file was rewritten
  // (a rewind, an edit), and only a fresh window is right.
  if (buf.length < held.lastLine.length || !buf.subarray(0, held.lastLine.length).equals(held.lastLine)) {
    drop(key)
    return null
  }
  const { complete, partial } = split(buf.subarray(held.lastLine.length))
  const lines = trimToWindow(Buffer.concat([held.lines, complete]), window)
  const messages = await parse(Buffer.concat([lines, partial]).toString('utf-8'))
  const end = held.end + complete.length
  const last = complete.length > 0 ? lastLineOf(complete) : null
  keep(key, {
    path: held.path,
    ...(st.epoch !== undefined ? { epoch: st.epoch } : {}),
    mtimeMs: held.lastLineStart + buf.length === st.size ? st.mtimeMs : null,
    end,
    lastLineStart: last ? held.end + last.start : held.lastLineStart,
    lastLine: last ? Buffer.from(last.line) : held.lastLine,
    lines: Buffer.from(lines),
    messages,
  })
  return messages
}

async function fresh<M>(
  key: string, reader: TailReader, path: string, st: { mtimeMs: number; size: number; epoch?: string },
  window: number, parse: (text: string) => Promise<M[]>,
): Promise<M[] | null> {
  drop(key)
  const start = Math.max(0, st.size - window)
  const res = await reader.readFileRangeBuffer(path, start)
  if (res === null) return null
  let buf = res.buf
  // Skip the first (almost certainly partial) line when the read did not start at 0.
  if (start > 0) {
    const nl = buf.indexOf(0x0a)
    buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1)
  }
  const { complete, partial } = split(buf)
  const messages = await parse(buf.toString('utf-8'))
  if (complete.length > 0) {
    // Offsets counted from the bytes the read reached (raw bytes, never a decode).
    const end = start + res.buf.length - partial.length
    const last = lastLineOf(complete)
    keep(key, {
      path, ...(st.epoch !== undefined ? { epoch: st.epoch } : {}),
      mtimeMs: start + res.buf.length === st.size ? st.mtimeMs : null, end,
      lastLineStart: end - last.line.length, lastLine: Buffer.from(last.line),
      lines: Buffer.from(complete), messages,
    })
  }
  return messages
}
