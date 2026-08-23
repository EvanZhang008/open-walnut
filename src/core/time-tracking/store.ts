/**
 * Time tracking store — appended daily JSONL + an in-memory rollup.
 *
 * Appends are the only write on the hot path; a day file that grows past
 * COMPACT_ABOVE_BYTES is folded in place into per-bucket totals (compactDay), so
 * neither the file nor the read cost of a heavy day can run away.
 *
 * Layout: WALNUT_HOME/time-tracking/<local-date>.jsonl, one JSON record per
 * banked lease window (human) or per completed turn (agent). JSONL rather than
 * SQLite on purpose: `*.sqlite` is gitignored inside WALNUT_HOME, so a SQLite
 * store would be Mac-local, while these files ride the data-hub git sync and
 * show up on the cloud replica.
 *
 * ALL fs is async — the web server shares one event loop and a sync read here
 * would freeze every route. Writes are fire-and-forget (telemetry must never
 * fail the request that produced it); the in-memory rollup is authoritative for
 * reads within a process and is lazily rehydrated from disk on first use.
 *
 * WALNUT_HOME is re-resolved per call so tests that swap it via mocked
 * constants get isolation without any special hook.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { addRecord, localDateKey, parseBucketKey, recentDateKeys } from './rollup.js';
import type { RollupIndex, TimeRecord } from './types.js';

/** How many days back the lazy rehydrate reads. Bounds boot cost forever. */
export const HYDRATE_DAYS = 90;
/** A day file this large is never parsed whole — only its tail is read. */
export const MAX_DAY_FILE_BYTES = 8 * 1024 * 1024;
/** How much of an over-cap day file to read, from the END (newest records). */
export const TAIL_READ_BYTES = 2 * 1024 * 1024;
/**
 * Once an append pushes a day past this, the file is folded into one line per
 * (task, kind) bucket. This is what makes the day file bounded: the old code
 * appended forever and readDay gave up above the cap, so a whale day vanished
 * from the panel while its file kept growing (and kept riding the data git sync).
 */
export const COMPACT_ABOVE_BYTES = 1024 * 1024;
/** Ceiling on the one full read a fold needs. Above it, only the tail is trusted. */
const MAX_COMPACT_READ_BYTES = 64 * 1024 * 1024;

function storeDir(): string {
  return path.join(WALNUT_HOME, 'time-tracking');
}

function dayFile(date: string): string {
  return path.join(storeDir(), `${date}.jsonl`);
}

interface StoreState {
  dir: string;
  index: RollupIndex;
  hydrated: Promise<void> | null;
  /**
   * Every disk write for this store runs in order. An append and a compaction of
   * the same day must never interleave — compaction rewrites the file it just
   * read, so a concurrent append would be dropped by the rename.
   */
  tail: Promise<void>;
}

let state: StoreState | null = null;

function current(): StoreState {
  const dir = storeDir();
  if (!state || state.dir !== dir) {
    state = { dir, index: new Map(), hydrated: null, tail: Promise.resolve() };
  }
  return state;
}

/** Drop all in-memory state (tests, and server teardown). */
export function resetTimeStore(): void {
  state = null;
  warnedOnce.clear();
}

/** One log line per distinct condition per process — never one per tick. */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log.web.warn(message, data);
}

/** Parse one JSONL line into a record, or null when it is not one. */
function parseLine(line: string, fallbackDate: string): TimeRecord | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Partial<TimeRecord>;
    if (typeof obj.durationMs !== 'number' || !Number.isFinite(obj.durationMs) || obj.durationMs <= 0) return null;
    if (typeof obj.kind !== 'string') return null;
    return {
      date: typeof obj.date === 'string' && obj.date ? obj.date : fallbackDate,
      ts: typeof obj.ts === 'string' ? obj.ts : '',
      durationMs: obj.durationMs,
      kind: obj.kind,
      ...(obj.taskId ? { taskId: obj.taskId } : {}),
      ...(obj.sessionId ? { sessionId: obj.sessionId } : {}),
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

async function readDay(date: string, index: RollupIndex): Promise<void> {
  const file = dayFile(date);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return; // no data that day
  }
  if (!stat.isFile()) return;
  let text: string;
  if (stat.size > MAX_DAY_FILE_BYTES) {
    // Compaction keeps this from happening going forward; a file written by an
    // older build can still land here.
    warnOnce(
      `oversize:${file}`,
      'time-tracking day file over the read cap — reading its tail only',
      { file, size: stat.size, tailBytes: TAIL_READ_BYTES },
    );
    text = await readTail(file, stat.size);
  } else {
    try {
      text = await fsp.readFile(file, 'utf-8');
    } catch {
      return;
    }
  }
  for (const line of text.split('\n')) {
    const rec = parseLine(line, date);
    if (rec) addRecord(index, rec);
  }
}

/**
 * Ensure the in-memory rollup reflects the last HYDRATE_DAYS of JSONL.
 * Runs at most once per WALNUT_HOME; concurrent callers share the promise.
 */
export function hydrate(now = new Date()): Promise<void> {
  const st = current();
  if (st.hydrated) return st.hydrated;
  const dates = recentDateKeys(localDateKey(now), HYDRATE_DAYS);
  st.hydrated = (async () => {
    for (const date of dates) await readDay(date, st.index);
  })().catch((err) => {
    log.web.warn('time-tracking hydrate failed', { error: err instanceof Error ? err.message : String(err) });
  });
  return st.hydrated;
}

/** The live rollup. Call hydrate() first if disk history matters. */
export function getIndex(): RollupIndex {
  return current().index;
}

/**
 * Fold records into the live rollup immediately and append them to disk.
 * The in-memory update is synchronous, so the caller can answer a read in the
 * same request; the returned promise settles when the append is done and never
 * rejects (telemetry must never fail the operation it records).
 */
export function recordTime(records: readonly TimeRecord[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  const st = current();
  const byDate = new Map<string, string[]>();
  for (const rec of records) {
    addRecord(st.index, rec);
    const lines = byDate.get(rec.date) ?? [];
    lines.push(JSON.stringify(rec));
    byDate.set(rec.date, lines);
  }
  // Queued behind any write already in flight, so an append can never land
  // between a compaction's read and its rename.
  st.tail = st.tail.then(() => appendDays(byDate)).catch(() => undefined);
  return st.tail;
}

async function appendDays(byDate: Map<string, string[]>): Promise<void> {
  try {
    await fsp.mkdir(storeDir(), { recursive: true });
    for (const [date, lines] of byDate) {
      const file = dayFile(date);
      await fsp.appendFile(file, lines.join('\n') + '\n', 'utf-8');
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && stat.size > COMPACT_ABOVE_BYTES) await compactDay(date, stat.size);
    }
  } catch (err) {
    log.web.warn('time-tracking append failed', {
      dates: [...byDate.keys()].join(','),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fold a day file down to one line per (task, kind) bucket. Totals are preserved
 * exactly — only the per-record detail (each window's `ts` / `sessionId`) is lost,
 * which nothing reads: the panel only ever asks for sums.
 *
 * The fold reads the FILE rather than the in-memory rollup on purpose. The rollup
 * only contains what this process hydrated plus what it wrote, so rewriting from
 * it could delete a day this process never read.
 */
async function compactDay(date: string, sizeBefore: number): Promise<void> {
  const file = dayFile(date);
  if (sizeBefore > MAX_COMPACT_READ_BYTES) {
    // Folding needs the WHOLE file (a tail fold would silently drop the head), and
    // one multi-hundred-MB string on the server's single heap is the worse failure.
    // Only a file written before compaction existed can get here; readDay still
    // answers from its tail.
    warnOnce(`toobig:${file}`, 'time-tracking day file too large to compact', { file, size: sizeBefore });
    return;
  }
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf-8');
  } catch {
    return;
  }
  const folded: RollupIndex = new Map();
  for (const line of text.split('\n')) {
    const rec = parseLine(line, date);
    if (rec) addRecord(folded, rec);
  }
  const lines: string[] = [];
  for (const [key, durationMs] of folded) {
    if (durationMs <= 0) continue;
    const { taskId, kind } = parseBucketKey(key);
    const rec: TimeRecord = {
      date,
      ts: `${date}T00:00:00.000Z`,
      durationMs,
      kind,
      ...(taskId ? { taskId } : {}),
    };
    lines.push(JSON.stringify(rec));
  }
  // Same directory, so the rename is atomic and never crosses a device (EXDEV).
  const tmp = `${file}.compact-${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8');
    await fsp.rename(tmp, file);
    log.web.info('time-tracking day file compacted', {
      date, sizeBefore, buckets: lines.length,
    });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    warnOnce(`compact:${file}`, 'time-tracking compaction failed', {
      file, error: err instanceof Error ? err.message : String(err),
    });
  }
}
