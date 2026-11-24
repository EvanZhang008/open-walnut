/**
 * The lines one window [start, stop) of a JSONL file owns, read in bounded
 * chunks: what older-history pages of a file too large for the full read are
 * parsed from (session-history.ts readSessionHistoryRange).
 *
 * Windows laid end to end must read every line once, so ownership is by where
 * a line STARTS: the partial line at `start` belongs to the window before, and
 * the line crossing `stop` is read to its newline. One exception keeps a call
 * whole: tool-result lines right after a boundary belong to the window before,
 * which holds their call. Split there, a call is read without its result and
 * shows as still running in history (and the result alone parses to nothing).
 * Both sides apply the same rule, so the tiling stays exact.
 */

export interface JsonlRangeReader {
  readRangeBytes(path: string, start: number, length: number): Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null>
}

const CHUNK = 1024 * 1024;
/** The shortest read: most lines fit, so a head read rarely takes a second one. */
const MIN_CHUNK = 64 * 1024;
/** Result lines a window may take past its end (and its successor skips). */
const MAX_RESULT_LINES = 64;

/** A user line that carries only tool results: the tail of the call before it. */
export function isToolResultLine(line: string): boolean {
  if (!line.includes('"tool_result"')) return false;
  try {
    const o = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    const content = o.message?.content;
    return o.type === 'user' && Array.isArray(content) && content.length > 0
      && content.every((b) => (b as { type?: string } | null)?.type === 'tool_result');
  } catch {
    return false;
  }
}

/** Reads a file line by line from a byte offset, one chunk at a time. */
class LineCursor {
  private buf = Buffer.alloc(0);
  private bufStart: number;
  private eof = false;
  read = 0;

  /**
   * `stop` sizes the reads: up to it a read takes what is left of the window (at
   * least MIN_CHUNK, at most CHUNK). Past it only the rest of one line and the
   * results after it are wanted, so reads start at MIN_CHUNK and double up to
   * CHUNK (a long line still costs few round trips). A head read for a window's
   * first timestamp then costs a short read, not a whole chunk.
   */
  constructor(private reader: JsonlRangeReader, private path: string, private pos: number, private stop = Infinity) {
    this.bufStart = pos;
  }

  private pastChunk = MIN_CHUNK;

  private chunkAt(at: number): number {
    if (at < this.stop) return Math.min(CHUNK, Math.max(MIN_CHUNK, this.stop - at + 1));
    const n = this.pastChunk;
    this.pastChunk = Math.min(CHUNK, n * 2);
    return n;
  }

  /**
   * The next line (without its newline), where it starts, and whether its
   * newline was there (a last line without one may still be being written);
   * null at EOF.
   */
  async next(): Promise<{ text: string; start: number; whole: boolean } | null | 'unreadable'> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a, this.pos - this.bufStart);
      if (nl >= 0 || (this.eof && this.pos - this.bufStart < this.buf.length)) {
        const endIdx = nl >= 0 ? nl : this.buf.length;
        const start = this.pos;
        const text = this.buf.subarray(this.pos - this.bufStart, endIdx).toString('utf-8');
        this.pos = this.bufStart + endIdx + 1;
        return { text, start, whole: nl >= 0 };
      }
      if (this.eof) return null;
      const at = this.bufStart + this.buf.length;
      const res = await this.reader.readRangeBytes(this.path, at, this.chunkAt(at));
      if (!res) return 'unreadable';
      this.read += res.buf.length;
      // Drop what was already handed out before growing the buffer.
      const keep = this.buf.subarray(this.pos - this.bufStart);
      this.bufStart = this.pos;
      this.buf = Buffer.concat([keep, res.buf]);
      if (res.eof || res.buf.length === 0) this.eof = true;
    }
  }
}

/**
 * The window's lines joined by newlines, or null when the file cannot be read
 * or the window would materialize more than `limit` bytes.
 *
 * `complete` says the window can never change: a whole line after it was read
 * (so every line it owns was whole, and an append-only file only grows past it).
 * A window that ran into the end of the file may still gain a line or the
 * rest of one, so a caller keeping windows keeps only complete ones.
 */
export async function readJsonlLineWindow(
  reader: JsonlRangeReader, path: string, start: number, stop: number, limit: number,
): Promise<{ text: string; complete: boolean } | null> {
  // From one byte early: the first "line" is then the rest of the line holding
  // byte start-1, which the window before owns (empty when `start` is a line start).
  const cursor = new LineCursor(reader, path, start > 0 ? start - 1 : 0, stop);
  const out: string[] = [];
  let bytes = 0;
  let line = await cursor.next();
  if (line === 'unreadable') return null;
  if (start > 0 && line) {
    line = await cursor.next();
    if (line === 'unreadable') return null;
    // Leading tool results belong to the call in the window before.
    for (let n = 0; line && n < MAX_RESULT_LINES && isToolResultLine(line.text); n++) {
      line = await cursor.next();
      if (line === 'unreadable') return null;
    }
  }
  while (line && line.start < stop) {
    out.push(line.text);
    bytes += line.text.length + 1;
    if (bytes > limit) return null;
    line = await cursor.next();
    if (line === 'unreadable') return null;
  }
  for (let n = 0; line && n < MAX_RESULT_LINES && isToolResultLine(line.text); n++) {
    out.push(line.text);
    bytes += line.text.length + 1;
    if (bytes > limit) return null;
    line = await cursor.next();
    if (line === 'unreadable') return null;
  }
  // The line after the window decides ownership (a tool result would belong to
  // it), so it must be whole too: half written, it cannot be told apart yet.
  return { text: out.join('\n'), complete: line !== null && line.whole };
}

/**
 * Complete windows already read, kept by text (oldest out first).
 *
 * A page of older history on a remote host costs whole windows over the tunnel
 * (4 MB each, about 1.5 s at the ~2.5 MB/s measured from a dev host), and the
 * route answering it gives up at its 5 s deadline while the read goes on. Kept
 * nowhere, that finished read was thrown away and the retry paid for it again:
 * 2026-11-16, an agent paging back through four 15 to 45 MB sessions got the
 * same 503 for twenty minutes. A complete window never changes (see
 * readJsonlLineWindow), so its text is kept: the read the deadline cut off
 * answers the retry. Text, not parsed rows, so whatever is merged into a
 * window's parse later (synthetic user lines) is never served stale.
 */
const KEPT_WINDOWS_MAX_CHARS = 32 * 1024 * 1024;
const keptWindows = new Map<string, string>();
let keptChars = 0;

function keepWindow(key: string, text: string): void {
  const prev = keptWindows.get(key);
  if (prev !== undefined) keptChars -= prev.length;
  keptWindows.delete(key);
  if (text.length > KEPT_WINDOWS_MAX_CHARS) return;
  keptWindows.set(key, text);
  keptChars += text.length;
  while (keptChars > KEPT_WINDOWS_MAX_CHARS) {
    const oldest = keptWindows.keys().next();
    if (oldest.done) break;
    keptChars -= keptWindows.get(oldest.value)?.length ?? 0;
    keptWindows.delete(oldest.value);
  }
}

/**
 * readJsonlLineWindow, served from the kept windows when this exact window of
 * this file incarnation (`file`: host, path and epoch) was read complete before.
 * Without an epoch a file cannot be told from its replacement, so nothing is kept.
 */
export async function readKeptJsonlLineWindow(
  reader: JsonlRangeReader, path: string, file: string | undefined, start: number, stop: number, limit: number,
): Promise<string | null> {
  const key = file === undefined ? undefined : `${file}\u0000${start}\u0000${stop}`;
  if (key !== undefined) {
    const kept = keptWindows.get(key);
    if (kept !== undefined) {
      if (kept.length > limit) return null;
      keptWindows.delete(key);
      keptWindows.set(key, kept);
      return kept;
    }
  }
  const got = await readJsonlLineWindow(reader, path, start, stop, limit);
  if (!got) return null;
  if (key !== undefined && got.complete) keepWindow(key, got.text);
  return got.text;
}

/** Whether this window's text is kept: read complete, so its bytes no longer change. */
export function isKeptJsonlLineWindow(file: string, start: number, stop: number): boolean {
  return keptWindows.has(`${file}\u0000${start}\u0000${stop}`);
}

/** Test seam: forget every kept window. */
export function _resetKeptWindowsForTests(): void {
  keptWindows.clear();
  keptChars = 0;
}
