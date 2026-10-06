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

  constructor(private reader: JsonlRangeReader, private path: string, private pos: number) {
    this.bufStart = pos;
  }

  /** The next line (without its newline) and where it starts; null at EOF. */
  async next(): Promise<{ text: string; start: number } | null | 'unreadable'> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a, this.pos - this.bufStart);
      if (nl >= 0 || (this.eof && this.pos - this.bufStart < this.buf.length)) {
        const endIdx = nl >= 0 ? nl : this.buf.length;
        const start = this.pos;
        const text = this.buf.subarray(this.pos - this.bufStart, endIdx).toString('utf-8');
        this.pos = this.bufStart + endIdx + 1;
        return { text, start };
      }
      if (this.eof) return null;
      const res = await this.reader.readRangeBytes(this.path, this.bufStart + this.buf.length, CHUNK);
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
 */
export async function readJsonlLineWindow(
  reader: JsonlRangeReader, path: string, start: number, stop: number, limit: number,
): Promise<string | null> {
  // From one byte early: the first "line" is then the rest of the line holding
  // byte start-1, which the window before owns (empty when `start` is a line start).
  const cursor = new LineCursor(reader, path, start > 0 ? start - 1 : 0);
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
  return out.join('\n');
}
