/**
 * Outside-activity store — which Mac app (and for a browser, which site) the
 * user was actually in. Same discipline as store.ts, separate files: this data
 * is sampled by a helper process at a fixed cadence, so it is far chattier than
 * the human/agent lanes and must not share their day files.
 *
 * Layout: WALNUT_HOME/time-tracking/outside/<local-date>.jsonl, one JSON record
 * per banked sample window. A day past COMPACT_ABOVE_BYTES is folded in place to
 * per-bucket INTERVALS (see compactRecords), so a 12-hour day at one sample per
 * 5s stays bounded while keeping its time-of-day shape.
 *
 * ALL fs is async — the web server shares one event loop and a sync read here
 * would freeze every route. Writes are fire-and-forget (telemetry must never
 * fail what produced it); the in-memory rollup is authoritative for reads within
 * a process and is lazily rehydrated from disk on first use.
 *
 * EXACTLY-ONCE: every record is counted once — either by the hydration read or
 * by the live fold, never both. Hydration therefore always runs FIRST and parks
 * records handed over while it reads (see hydrateOutside / drainPending).
 *
 * WALNUT_HOME is re-resolved per call so tests that swap it via mocked constants
 * get isolation without a special hook.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { localDateKey, recentDateKeys } from './rollup.js';

/** One banked sample window. `ts` is the START of the counted window. */
export interface OutsideRecord {
  /** Local YYYY-MM-DD of `ts`. */
  date: string;
  ts: string;
  durationMs: number;
  /** Display name as macOS reports it; can change with locale or an update. */
  app: string;
  bundleId?: string;
  /** Host only, never a full URL. Present only for a scriptable browser. */
  host?: string;
}

/** Per (date, bundleId, host) accumulated ms, plus the last-seen display name. */
export type OutsideIndex = Map<string, { app: string; ms: number }>;

/** One bucket of a single day, as the read side consumes it. */
export interface OutsideRow {
  app: string;
  bundleId: string;
  host: string;
  ms: number;
}

/** How many days back the lazy rehydrate reads. Bounds boot cost forever. */
const HYDRATE_DAYS = 30;
/** A day file this large is never parsed whole — only its tail is read. */
export const MAX_DAY_FILE_BYTES = 8 * 1024 * 1024;
/** How much of an over-cap day file to read, from the END (newest records). */
const TAIL_READ_BYTES = 2 * 1024 * 1024;
/** Once an append pushes a day past this, the file is folded per bucket. */
export const COMPACT_ABOVE_BYTES = 1024 * 1024;
/** Ceiling on the one full read a fold needs. Above it, only the tail is trusted. */
const MAX_COMPACT_READ_BYTES = 64 * 1024 * 1024;
/** Ceiling on records parked while hydration reads, so a wedged fs cannot OOM us. */
const MAX_PENDING_RECORDS = 10_000;
/**
 * Ceiling on ONE stored line. A live sample is clamped far lower by the
 * collector (MAX_BANK_MS); this is only a sanity bound on a hand-edited or torn
 * file, and it has to allow a whole day because a COMPACTED line is one bucket's
 * entire day. Clamping it to a sample-sized value made compaction split every
 * bucket into hundreds of lines, which grew the file back to the threshold and
 * re-compacted it on the next append.
 */
const MAX_RECORD_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD_LEN = 256;

// NUL cannot appear in a bundle id, a host, or a date, so the composite key
// never collides. The app NAME is deliberately not part of the key: it is a
// display label that changes with locale, while the bundle id is the identity.
const SEP = '\u0000';

export function outsideBucketKey(date: string, bundleId: string, host: string): string {
  return `${date}${SEP}${bundleId}${SEP}${host}`;
}

export function parseOutsideBucketKey(key: string): { date: string; bundleId: string; host: string } {
  const parts = key.split(SEP);
  return { date: parts[0] ?? '', bundleId: parts[1] ?? '', host: parts[2] ?? '' };
}

/** Add one record into an index (mutates and returns it). */
export function addOutsideRecord(index: OutsideIndex, rec: OutsideRecord): OutsideIndex {
  const key = outsideBucketKey(rec.date, rec.bundleId ?? '', rec.host ?? '');
  const prev = index.get(key);
  // Last name wins: a renamed/relocalized app should not keep an old label.
  index.set(key, { app: rec.app || prev?.app || '', ms: (prev?.ms ?? 0) + rec.durationMs });
  return index;
}

function storeDir(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'outside');
}

function dayFile(date: string): string {
  return path.join(storeDir(), `${date}.jsonl`);
}

interface StoreState {
  dir: string;
  index: OutsideIndex;
  /**
   * Oldest date the in-memory rollup can answer for. Everything from here on is
   * either hydrated or was written by this process, so `date >= from` is served
   * from memory and anything older takes the disk path.
   *
   * It is a BOUND, not the frozen set of hydrated days: with a literal set, a
   * server that ran past midnight answered every request for the new "today"
   * from disk forever, because that date was not in the set the boot read built.
   */
  from: string;
  /** Local day the window was last computed for; a roll advances `from`. */
  day: string;
  hydrated: Promise<void> | null;
  /** Non-null ONLY while hydration reads; see the EXACTLY-ONCE note above. */
  pending: OutsideRecord[] | null;
  /** Every disk write for this store runs in order (append vs compaction vs read). */
  tail: Promise<void>;
  /**
   * Per-date byte threshold the NEXT compaction waits for. Without it, a day
   * whose compaction cannot shrink (many buckets rotating faster than the merge
   * gap) sits just above COMPACT_ABOVE_BYTES and is rewritten wholesale on EVERY
   * append — ~2MB of disk churn plus a full-day parse per 5s sample.
   */
  nextCompactAt: Map<string, number>;
  /** Last parsed day file, keyed by its stat, so a timeline that polls one day
   *  re-parses only when the file actually changed. Callers must not mutate it. */
  recordsCache: { date: string; mtimeMs: number; size: number; records: OutsideRecord[] } | null;
}

let state: StoreState | null = null;

function current(): StoreState {
  const dir = storeDir();
  if (!state || state.dir !== dir) {
    state = {
      dir, index: new Map(), from: '9999-12-31', day: '', hydrated: null, pending: null,
      tail: Promise.resolve(), nextCompactAt: new Map(), recordsCache: null,
    };
  }
  return state;
}

/**
 * Follow the local day forward: advance the window's lower bound and drop the
 * buckets that fell out of it. Without the prune, a server running for months
 * would keep every day it ever saw in the rollup; with it, memory is bounded by
 * HYDRATE_DAYS and an older day is answered from its file instead.
 */
function advanceWindow(st: StoreState, today: string): void {
  if (!st.day || today <= st.day) return;
  st.day = today;
  const oldest = recentDateKeys(today, HYDRATE_DAYS)[0]!;
  if (oldest <= st.from) return;
  st.from = oldest;
  for (const key of [...st.index.keys()]) {
    if (parseOutsideBucketKey(key).date < oldest) st.index.delete(key);
  }
}

/** Drop all in-memory state (tests, and server teardown). */
export function resetOutsideStore(): void {
  state = null;
  warnedOnce.clear();
}

/** One log line per distinct condition per process — never one per sample. */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log.web.warn(message, data);
}

function cleanField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > MAX_FIELD_LEN) return undefined;
  // A control character in a bundle id or host would inject a second key field.
  if (/[\u0000-\u001f\u007f]/.test(t)) return undefined;
  return t;
}

/** Hosts are compared against a fixed list (localhost, the companion hostname),
 *  so a hand-edited or older file must not create a second bucket for `GitHub.com`. */
function cleanHost(raw: unknown): string | undefined {
  return cleanField(raw)?.toLowerCase();
}

/** Parse one JSONL line into a record, or null when it is not one. */
export function parseOutsideLine(line: string, fallbackDate: string): OutsideRecord | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Partial<OutsideRecord>;
    const ms = typeof obj.durationMs === 'number' && Number.isFinite(obj.durationMs) ? Math.round(obj.durationMs) : 0;
    if (ms <= 0) return null;
    const app = cleanField(obj.app);
    if (!app) return null;
    const bundleId = cleanField(obj.bundleId);
    const host = cleanHost(obj.host);
    return {
      date: typeof obj.date === 'string' && obj.date ? obj.date : fallbackDate,
      ts: typeof obj.ts === 'string' ? obj.ts : '',
      durationMs: Math.min(ms, MAX_RECORD_MS),
      app,
      ...(bundleId ? { bundleId } : {}),
      ...(host ? { host } : {}),
    };
  } catch {
    return null; // a torn tail line is expected; skip it
  }
}

/** The last TAIL_READ_BYTES of a file, with the (probably torn) first line dropped. */
async function readTail(file: string, size: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(Math.min(TAIL_READ_BYTES, size));
    // A short read is legal, so decode only what arrived: the zero fill left in
    // the rest of the buffer would otherwise be parsed as NUL characters.
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString('utf-8');
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
async function readDayText(date: string): Promise<string> {
  const file = dayFile(date);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return ''; // no data that day
  }
  if (!stat.isFile()) return '';
  if (stat.size > MAX_DAY_FILE_BYTES) {
    warnOnce(`oversize:${file}`, 'outside-activity day file over the read cap — reading its tail only', {
      file, size: stat.size, tailBytes: TAIL_READ_BYTES,
    });
    return readTail(file, stat.size);
  }
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

async function readDay(date: string, index: OutsideIndex): Promise<void> {
  const text = await readDayText(date);
  for (const line of text.split('\n')) {
    const rec = parseOutsideLine(line, date);
    if (rec) addOutsideRecord(index, rec);
  }
}

/**
 * Ensure the in-memory rollup reflects the last HYDRATE_DAYS of JSONL.
 * Runs at most once per WALNUT_HOME; concurrent callers share the promise.
 */
export function hydrateOutside(now = new Date()): Promise<void> {
  const st = current();
  if (st.hydrated) return st.hydrated;
  const today = localDateKey(now);
  const dates = recentDateKeys(today, HYDRATE_DAYS);
  st.from = dates[0]!;
  st.day = today;
  // Park everything recorded from this instant until the read is done.
  st.pending = [];
  const prior = st.tail;
  const read = (async () => {
    // Read behind any write already queued: compaction renames the very file
    // this loop opens, and a half-renamed read would lose a whole day.
    await prior.catch(() => undefined);
    for (const date of dates) await readDay(date, st.index);
  })().catch((err) => {
    log.web.warn('outside-activity hydrate failed', { error: err instanceof Error ? err.message : String(err) });
  });
  st.tail = read;
  st.hydrated = read.then(() => drainPending(st));
  return st.hydrated;
}

/** Fold and append everything parked during hydration, then reopen the fast path. */
async function drainPending(st: StoreState): Promise<void> {
  for (;;) {
    const batch = st.pending;
    if (!batch || batch.length === 0) break;
    st.pending = [];
    await foldAndAppend(st, batch).catch(() => undefined);
  }
  st.pending = null;
}

/** The live rollup. Call hydrateOutside() first if disk history matters. */
export function getOutsideIndex(): OutsideIndex {
  return current().index;
}

/**
 * Fold records into the live rollup and append them to disk. The in-memory
 * update is synchronous once hydration has settled; the returned promise settles
 * when the append is done and never rejects.
 */
export function recordOutside(records: readonly OutsideRecord[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  const st = current();
  // Hydration must precede this process's FIRST append: an append that lands
  // before the read is counted twice.
  const hydrated = st.hydrated ?? hydrateOutside();
  // Follow the clock here too, so a server nobody queries still bounds its rollup.
  advanceWindow(st, localDateKey(new Date()));
  const pending = st.pending;
  if (pending) {
    for (const rec of records) pending.push(rec);
    if (pending.length > MAX_PENDING_RECORDS) {
      const dropped = pending.length - MAX_PENDING_RECORDS;
      pending.splice(0, dropped); // oldest first
      warnOnce('pending-overflow', 'outside-activity dropped parked records while hydrating', {
        dropped, cap: MAX_PENDING_RECORDS,
      });
    }
    return hydrated;
  }
  return foldAndAppend(st, records);
}

/** Fold into the live rollup now; queue the JSONL append behind the write chain. */
function foldAndAppend(st: StoreState, records: readonly OutsideRecord[]): Promise<void> {
  const byDate = new Map<string, string[]>();
  for (const rec of records) {
    addOutsideRecord(st.index, rec);
    const lines = byDate.get(rec.date) ?? [];
    lines.push(JSON.stringify(rec));
    byDate.set(rec.date, lines);
  }
  st.tail = st.tail.then(() => appendDays(byDate)).catch(() => undefined);
  return st.tail;
}

async function appendDays(byDate: Map<string, string[]>): Promise<void> {
  try {
    const st = current();
    await fsp.mkdir(storeDir(), { recursive: true });
    for (const [date, lines] of byDate) {
      const file = dayFile(date);
      await fsp.appendFile(file, lines.join('\n') + '\n', 'utf-8');
      const stat = await fsp.stat(file).catch(() => null);
      const threshold = st.nextCompactAt.get(date) ?? COMPACT_ABOVE_BYTES;
      if (stat && stat.size > threshold) await compactDay(st, date, stat.size);
    }
  } catch (err) {
    log.web.warn('outside-activity append failed', {
      dates: [...byDate.keys()].join(','),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Adjacent samples of the SAME bucket merge into one interval when the next one
 * starts within this gap of the previous one's end. 15s comfortably swallows the
 * 5s sampling cadence plus scheduling jitter without gluing real absences shut.
 */
export const COMPACT_MERGE_GAP_MS = 15_000;

/**
 * Fold a day's records into per-bucket INTERVALS: consecutive samples of one
 * bucket become one record whose `ts` is the run's start and whose `durationMs`
 * is the run's tracked sum. Totals are preserved exactly, and — unlike the old
 * one-line-per-bucket fold — the day keeps its time-of-day shape, which the
 * timeline view draws. Idempotent: merged intervals re-merge to themselves.
 *
 * A record with no parseable `ts` cannot be placed, so those fold to one TS-LESS
 * line per bucket (`ts: ''`), which readers treat as "counted but not placeable".
 * Never a synthesized timestamp: a fake midnight-UTC `ts` draws as a real bar at
 * the wrong local hour, which is exactly the lie this store exists to avoid.
 */
export function compactRecords(records: readonly OutsideRecord[], date: string): OutsideRecord[] {
  interface Open { startMs: number; endMs: number; ms: number; app: string; labelMs: number }
  const placed: Array<{ rec: OutsideRecord; startMs: number }> = [];
  const unplaced: OutsideIndex = new Map();
  for (const rec of records) {
    if (rec.durationMs <= 0) continue;
    const startMs = Date.parse(rec.ts);
    if (Number.isFinite(startMs)) placed.push({ rec, startMs });
    else addOutsideRecord(unplaced, rec);
  }
  placed.sort((a, b) => a.startMs - b.startMs);

  const open = new Map<string, Open>();
  const out: OutsideRecord[] = [];
  const close = (key: string, o: Open): void => {
    // The bucket's OWN date, not the file's: a record that claimed another date
    // keeps its claim through compaction instead of being silently reassigned.
    const { date: recDate, bundleId, host } = parseOutsideBucketKey(key);
    out.push({
      date: recDate || date,
      ts: new Date(o.startMs).toISOString(),
      durationMs: Math.min(o.ms, MAX_RECORD_MS),
      app: o.app,
      ...(bundleId ? { bundleId } : {}),
      ...(host ? { host } : {}),
    });
  };
  for (const { rec, startMs } of placed) {
    const key = outsideBucketKey(rec.date, rec.bundleId ?? '', rec.host ?? '');
    const o = open.get(key);
    if (o && startMs <= o.endMs + COMPACT_MERGE_GAP_MS) {
      o.endMs = Math.max(o.endMs, startMs + rec.durationMs);
      o.ms += rec.durationMs;
      if (rec.durationMs > o.labelMs) { o.app = rec.app; o.labelMs = rec.durationMs; }
      continue;
    }
    if (o) close(key, o);
    open.set(key, {
      startMs, endMs: startMs + rec.durationMs, ms: rec.durationMs, app: rec.app, labelMs: rec.durationMs,
    });
  }
  for (const [key, o] of open) close(key, o);

  for (const [key, bucket] of unplaced) {
    if (bucket.ms <= 0) continue;
    const { date: recDate, bundleId, host } = parseOutsideBucketKey(key);
    out.push({
      date: recDate || date,
      // Stays ts-less: the samples' time of day was never known, and inventing
      // one would draw the whole bucket as a solid bar at a fictional hour.
      ts: '',
      durationMs: Math.min(bucket.ms, MAX_RECORD_MS),
      app: bucket.app,
      ...(bundleId ? { bundleId } : {}),
      ...(host ? { host } : {}),
    });
  }
  // Chronological on disk (ts-less lines first), matching how samples arrive, so
  // the over-cap tail read keeps the day's newest intervals.
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Rewrite a day file as merged intervals (see compactRecords). Reads the FILE
 * rather than the in-memory rollup on purpose: the rollup holds only what this
 * process hydrated plus what it wrote, so rewriting from it could delete a day
 * this process never read.
 */
async function compactDay(st: StoreState, date: string, sizeBefore: number): Promise<void> {
  const file = dayFile(date);
  if (sizeBefore > MAX_COMPACT_READ_BYTES) {
    warnOnce(`toobig:${file}`, 'outside-activity day file too large to compact', { file, size: sizeBefore });
    return;
  }
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf-8');
  } catch {
    return;
  }
  const records: OutsideRecord[] = [];
  for (const line of text.split('\n')) {
    const rec = parseOutsideLine(line, date);
    if (rec) records.push(rec);
  }
  const lines = compactRecords(records, date).map((rec) => JSON.stringify(rec));
  const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  // Same directory, so the rename is atomic and never crosses a device (EXDEV).
  const tmp = `${file}.compact-${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, body, 'utf-8');
    await fsp.rename(tmp, file);
    // The next compaction waits for another COMPACT_ABOVE_BYTES of growth past
    // what THIS one produced. Rearming at the fixed threshold instead turns a
    // day that cannot shrink (buckets rotating faster than the merge gap) into
    // a full-file rewrite on every append.
    st.nextCompactAt.set(date, Buffer.byteLength(body, 'utf-8') + COMPACT_ABOVE_BYTES);
    log.web.info('outside-activity day file compacted', { date, sizeBefore, lines: lines.length });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    warnOnce(`compact:${file}`, 'outside-activity compaction failed', {
      file, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The byte size the next compaction of `date` waits for (tests). */
export function peekNextCompactAt(date: string): number | undefined {
  return state?.nextCompactAt.get(date);
}

/**
 * Every bucket of ONE local day. Answered from the live rollup when the day is
 * inside the hydrated window (the common case: today), otherwise by one bounded
 * file read that is deliberately NOT folded into the index — see EXACTLY-ONCE.
 * The read joins the write chain for the same reason hydration does.
 */
export async function outsideDayRows(date: string, now = new Date()): Promise<OutsideRow[]> {
  const st = current();
  await hydrateOutside(now);
  advanceWindow(st, localDateKey(now));
  // `>=` rather than a membership test: a day after the hydration read exists in
  // memory too, because this process wrote every record it holds.
  if (date >= st.from) return rowsFromIndex(st.index, date);
  const read = st.tail.catch(() => undefined).then(async () => {
    const day: OutsideIndex = new Map();
    await readDay(date, day);
    return rowsFromIndex(day, date);
  });
  // Later writes queue behind this read, but must never inherit its value.
  st.tail = read.then(() => undefined, () => undefined);
  return read;
}

/**
 * Every RECORD of one local day, `ts` and all — the timeline's read. Always a
 * file read (the in-memory rollup keeps only bucket sums), joined onto the write
 * chain so it can never race a compaction rename mid-read. Bounded by the same
 * read cap as every other day read.
 */
export async function outsideDayRecords(date: string): Promise<OutsideRecord[]> {
  const st = current();
  const read = st.tail.catch(() => undefined).then(async () => {
    const stat = await fsp.stat(dayFile(date)).catch(() => null);
    if (!stat || !stat.isFile()) return [];
    // A timeline polls the SAME day repeatedly; re-parse only a changed file.
    const c = st.recordsCache;
    if (c && c.date === date && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.records;
    const text = await readDayText(date);
    const out: OutsideRecord[] = [];
    for (const line of text.split('\n')) {
      const rec = parseOutsideLine(line, date);
      if (rec && rec.date === date) out.push(rec);
    }
    st.recordsCache = { date, mtimeMs: stat.mtimeMs, size: stat.size, records: out };
    return out;
  });
  // Later writes queue behind this read, but must never inherit its value.
  st.tail = read.then(() => undefined, () => undefined);
  return read;
}

function rowsFromIndex(index: OutsideIndex, date: string): OutsideRow[] {
  const out: OutsideRow[] = [];
  for (const [key, bucket] of index) {
    if (bucket.ms <= 0) continue;
    const parsed = parseOutsideBucketKey(key);
    if (parsed.date !== date) continue;
    out.push({ app: bucket.app, bundleId: parsed.bundleId, host: parsed.host, ms: bucket.ms });
  }
  return out;
}
