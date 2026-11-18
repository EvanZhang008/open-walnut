/**
 * Older history of a JSONL too large for the full read, in bounded windows.
 *
 * The full read refuses a file past DaemonFileReader's byte ceiling (32 MB) and
 * serves the 4 MB tail instead, so a long session's history began wherever that
 * tail did: a phone paging back with `before=` got an empty page and nothing
 * older could ever be read (measured: a 61 MB session's tail held 95 messages).
 * Here the file is read in 4 MB windows aligned to absolute byte offsets, so
 * window k is the same bytes however much the file grows after it, and each
 * window's first timestamp is remembered: the next page jumps straight to the
 * window it needs.
 */
import { readSessionHistoryRange, type HistoryWindowStart, type SessionHistoryMessage } from './session-history.js';

const WINDOW_BYTES = 4 * 1024 * 1024;
/** Most windows one page reads, so a tap costs at most this many bounded reads. */
const MAX_WINDOWS_PER_PAGE = 4;
/**
 * A page that holds a row reads no window expected to end past this: under the
 * transcript route's 5 s deadline with room for a window slower than the last.
 * 2026-11-16: with the check made only after each read, a `visible=200` page of a
 * 49 MB session went on into another window over the tunnel and missed the deadline.
 */
const PAGE_READ_BUDGET_MS = 3_000;
/** What a window's first timestamp is read from: a head, far less than the window. */
const HEAD_BYTES = 64 * 1024;
const MAX_INDEXED_SESSIONS = 50;
/** Largest file on another host an older page reads whole: about 3 s over the tunnel. */
const REMOTE_FULL_READ_MAX_BYTES = 8 * 1024 * 1024;

interface WindowIndex {
  /** File incarnation the offsets belong to; a different one starts over. */
  epoch?: string;
  /** Window number → earliest timestamp of a message starting in it (null = none). */
  firstTs: Map<number, string | null>;
}

const indexes = new Map<string, WindowIndex>();

function indexFor(key: string, epoch: string | undefined): WindowIndex {
  let idx = indexes.get(key);
  if (!idx || idx.epoch !== epoch) {
    idx = { epoch, firstTs: new Map() };
    indexes.set(key, idx);
    if (indexes.size > MAX_INDEXED_SESSIONS) {
      const oldest = indexes.keys().next().value;
      if (oldest !== undefined) indexes.delete(oldest);
    }
  }
  return idx;
}

/**
 * How an older page of this session's file is read: 'full' (one full read, kept
 * by the parse cache), 'windows' (bounded windows, the full read as a fallback),
 * or 'windows-only' (past DaemonFileReader's byte ceiling, the full read would
 * only serve the tail again). 'full' when it cannot tell.
 *
 * A file on another host past REMOTE_FULL_READ_MAX_BYTES pages in windows too:
 * the full read is the whole file over the tunnel, about 10 s for the 25 MB one
 * of 2026-11-16, so its first page missed the route's 5 s deadline every time.
 */
export async function olderPageRead(
  sessionId: string, cwd: string | undefined, host: string | undefined,
): Promise<'full' | 'windows' | 'windows-only'> {
  const probe = await readSessionHistoryRange(sessionId, cwd, host, 0, 0).catch(() => null);
  if (!probe) return 'full';
  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  return olderPageReadFor(probe.fileSize, host, DaemonFileReader.maxReadBytes());
}

/** olderPageRead's choice for a file of this size on this host, under this byte ceiling. */
export function olderPageReadFor(
  fileSize: number, host: string | undefined, ceiling: number,
): 'full' | 'windows' | 'windows-only' {
  if (fileSize > ceiling) return 'windows-only';
  // The same test as hosts/remote-read-bound.ts isRemoteHost, without its imports.
  const remote = host !== undefined && host !== '' && host !== '__local__';
  return remote && fileSize > REMOTE_FULL_READ_MAX_BYTES ? 'windows' : 'full';
}

/** Test seam: forget every window index. */
export function _resetHistoryPagesForTests(): void {
  indexes.clear();
}

/**
 * History messages strictly older than `before`, oldest first, enough for one
 * page: at least `minMessages` of them and `minText` a reader sees as text, or
 * everything back to the start of the file, or what MAX_WINDOWS_PER_PAGE
 * windows hold, or what fits in PAGE_READ_BUDGET_MS. `reachedStart` says the
 * first window was read. null = this session cannot be read in windows (see
 * readSessionHistoryRange).
 *
 * What one page may cost is bounded, because the route answering it gives up at
 * 5 s and a remote window costs about 1.5 s over the tunnel. It used to find its
 * window by reading every window back from the end, so a page deep in a 45 MB
 * file read ten windows before its first row (2026-11-16: 503 on every retry for
 * twenty minutes). Now it binary-searches the windows by their first timestamp,
 * read from a head of each window, and stops adding windows past the budget once
 * it holds a row; a short page is still a page, and the next one goes on from it.
 *
 * Which rows are "older" is decided by their place in the file whenever the caller knows it,
 * never by their timestamps: file order is not time order (2026-11-18: a compaction's boundary
 * line stamped 06:39:03 sits before a summary stamped 06:39:00, so a page cut at that summary's
 * timestamp dropped the boundary, and a refresh took it off the reader's screen). `held` (a tail
 * window's start) cuts at its byte; `want.beforeId` (the msgId of the held row stamped `before`)
 * cuts at that row. Only a caller with neither falls back to the timestamp.
 */
export async function readSessionHistoryBefore(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  before: string,
  want: {
    minMessages: number; minText: number; isText: (m: SessionHistoryMessage) => boolean;
    /** Fewer windows than MAX_WINDOWS_PER_PAGE for this page (a byte budget). */
    maxWindows?: number;
    /** The msgId of the row the caller holds first (stamped `before`): the page ends at its
     *  place in the file, so a row before it with a later stamp is still older. */
    beforeId?: string;
  },
  /** Lines starting from here on are already in hand (a tail window's start, `before` its
   *  first row's time): read only before it, starting with the window that ends there.
   *  Ignored when the file is no longer the one that window was read from. */
  held?: HistoryWindowStart,
  budgetMs = PAGE_READ_BUDGET_MS,
): Promise<{ messages: SessionHistoryMessage[]; reachedStart: boolean; windowsRead: number } | null> {
  const startedAt = Date.now();
  const key = `${sessionId}@${host ?? '__local__'}`;
  // A zero-length read answers the file's size (and whether it is readable).
  const probe = await readSessionHistoryRange(sessionId, cwd, host, 0, 0);
  if (!probe) return null;
  const idx = indexFor(key, probe.epoch);
  let last: { n: number; messages: SessionHistoryMessage[] } | null = null;
  const sameFile = held?.epoch === undefined || probe.epoch === undefined || held.epoch === probe.epoch;
  const cutAt = held && sameFile && held.byte > 0 && held.byte < probe.fileSize ? held.byte : undefined;
  const stopAt = cutAt ?? probe.fileSize;
  let windowsRead = 0;
  const read = async (n: number): Promise<SessionHistoryMessage[] | null> => {
    if (last?.n === n) return last.messages;
    // The window still starts at n * WINDOW_BYTES, so its firstTs keeps its meaning;
    // only its end is cut where the caller's bytes begin.
    const end = cutAt === undefined ? (n + 1) * WINDOW_BYTES : Math.min((n + 1) * WINDOW_BYTES, cutAt);
    const got = await readSessionHistoryRange(sessionId, cwd, host, n * WINDOW_BYTES, end);
    if (!got || got.epoch !== idx.epoch) return null; // unreadable, or replaced mid-page
    windowsRead++;
    // "No timestamp" says nothing about a window cut short, nor about the last
    // window, which may still gain lines; only below both it is final.
    if (got.firstTimestamp || (end === (n + 1) * WINDOW_BYTES && end < got.fileSize)) {
      idx.firstTs.set(n, got.firstTimestamp ?? null);
    }
    last = { n, messages: got.messages };
    return got.messages;
  };
  /** Window n's first timestamp, from its head when not known yet; null = none in it. */
  const head = async (n: number): Promise<string | null | 'unreadable'> => {
    const known = idx.firstTs.get(n);
    if (known !== undefined) return known;
    const got = await readSessionHistoryRange(sessionId, cwd, host, n * WINDOW_BYTES, Math.min(n * WINDOW_BYTES + HEAD_BYTES, stopAt));
    if (!got || got.epoch !== idx.epoch) return 'unreadable';
    // A head with no timestamp says nothing about the window: read it whole.
    if (got.firstTimestamp) {
      idx.firstTs.set(n, got.firstTimestamp);
      return got.firstTimestamp;
    }
    const whole = await read(n);
    return whole === null ? 'unreadable' : idx.firstTs.get(n) ?? whole[0]?.timestamp ?? null;
  };
  // The newest window holding something older than `before`: the last one whose
  // first timestamp is older. Time grows with the offset, so that holds for every
  // window up to it and none after. A window without timestamps counts as older,
  // which can only start the page a window too new (it holds no rows), never
  // skip one. Window 0 always holds the start of the file.
  //
  // With the caller's tail in hand that window is the one ending where the tail begins:
  // every byte before it is older than the tail's first row. No search, so no head reads
  // over the tunnel (2026-11-17: a 119 MB session on a slow host link spent 65 s of a 60 s
  // full read in this backfill, a head without a timestamp read whole on the way).
  let hi = Math.max(0, Math.floor((stopAt - 1) / WINDOW_BYTES));
  let lo = cutAt !== undefined ? hi : 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const ts = await head(mid);
    if (ts === 'unreadable') return null;
    // With the held row's id, a window that starts AT its stamp may start with that row: the
    // page begins there, so the lines just before it (the previous window's end) are read whole.
    if (ts === null || ts < before || (want.beforeId !== undefined && ts === before)) lo = mid;
    else hi = mid - 1;
  }
  let k = lo;
  let collected: SessionHistoryMessage[] = [];
  let windows = 0;
  let reachedStart = false;
  const windowCap = Math.max(1, Math.min(want.maxWindows ?? MAX_WINDOWS_PER_PAGE, MAX_WINDOWS_PER_PAGE));
  // Where the page ends: at the cut byte (every row read is older), at the held first row once a
  // window holds it (the rows read from windows after it are newer: dropped), else by stamp.
  let placed = cutAt !== undefined;
  const older = (messages: SessionHistoryMessage[]): SessionHistoryMessage[] => {
    if (placed) return messages;
    const at = want.beforeId ? messages.findIndex((m) => m.msgId === want.beforeId && m.timestamp === before) : -1;
    if (at < 0) return messages.filter((m) => m.timestamp < before);
    placed = true;
    collected = [];
    return messages.slice(0, at);
  };
  /** The slowest window read of this page: what the next one may cost too. */
  let slowest = 0;
  for (; k >= 0 && windows < windowCap; k--) {
    const readAt = Date.now();
    const messages = await read(k);
    if (!messages) return null;
    slowest = Math.max(slowest, Date.now() - readAt);
    windows++;
    collected = older(messages).concat(collected);
    if (k === 0) reachedStart = true;
    if (collected.length >= want.minMessages && collected.filter(want.isText).length >= want.minText) break;
    // A page that holds a row starts no window that would end past the budget:
    // kept windows cost nothing and go on, one more read over the tunnel may not.
    if (collected.length > 0 && Date.now() - startedAt + slowest >= budgetMs) break;
  }
  return { messages: collected, reachedStart, windowsRead };
}
