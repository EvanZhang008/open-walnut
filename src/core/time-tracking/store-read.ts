/**
 * Time tracking store: the READ side of the day files (store.ts owns the state,
 * the writes and the exactly-once rule; this file only turns files into records).
 *
 * All fs is async, for the reason store.ts gives.
 */

import fsp from 'node:fs/promises';
import { normalizeSource } from './rollup.js';
import { TIME_MODES, TIME_VIEWS, type TimeRecord } from './types.js';

/** A day file this large is never parsed whole — only its tail is read. */
export const MAX_DAY_FILE_BYTES = 8 * 1024 * 1024;
/** How much of an over-cap day file to read, from the END (newest records). */
const TAIL_READ_BYTES = 2 * 1024 * 1024;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The dates of every day file in `dir`, oldest first ([] when there is no store yet). */
export async function listDayDates(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => DAY_FILE_RE.exec(name)?.[1])
    .filter((date): date is string => !!date)
    .sort();
}

/** Parse one JSONL line into a record, or null when it is not one. */
export function parseLine(line: string, fallbackDate: string): TimeRecord | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Partial<TimeRecord>;
    if (typeof obj.durationMs !== 'number' || !Number.isFinite(obj.durationMs) || obj.durationMs <= 0) return null;
    if (typeof obj.kind !== 'string') return null;
    // Absent source (every line written before the field existed) = web. An
    // unknown value is dropped rather than trusted, so a hand-edited line cannot
    // mint a lane; the record itself still counts.
    const source = normalizeSource(obj.source);
    return {
      date: typeof obj.date === 'string' && obj.date ? obj.date : fallbackDate,
      ts: typeof obj.ts === 'string' ? obj.ts : '',
      durationMs: obj.durationMs,
      kind: obj.kind,
      ...(obj.taskId ? { taskId: obj.taskId } : {}),
      ...(obj.sessionId ? { sessionId: obj.sessionId } : {}),
      ...(source ? { source } : {}),
      ...(typeof obj.view === 'string' && (TIME_VIEWS as readonly string[]).includes(obj.view) ? { view: obj.view } : {}),
      ...(typeof obj.app === 'string' && obj.app.length <= 32 ? { app: obj.app } : {}),
      ...(typeof obj.mode === 'string' && (TIME_MODES as readonly string[]).includes(obj.mode) ? { mode: obj.mode } : {}),
    };
  } catch {
    return null; // a torn tail line is expected; skip it
  }
}

/**
 * The last TAIL_READ_BYTES of a file, with the (probably torn) first line
 * dropped. Used instead of giving up on an over-cap day: a partial day is a
 * smaller lie than a day that silently reads as zero.
 */
async function readTail(file: string, size: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(Math.min(TAIL_READ_BYTES, size));
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : '';
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** One day file's text, or '' when there is none. Applies the read cap. */
export async function readDayFileText(
  file: string,
  onOversize?: (data: { file: string; size: number; tailBytes: number }) => void,
): Promise<string> {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return ''; // no data that day
  }
  if (!stat.isFile()) return '';
  if (stat.size > MAX_DAY_FILE_BYTES) {
    // Compaction keeps this from happening going forward; a file written by an
    // older build can still land here.
    onOversize?.({ file, size: stat.size, tailBytes: TAIL_READ_BYTES });
    return readTail(file, stat.size);
  }
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return '';
  }
}
