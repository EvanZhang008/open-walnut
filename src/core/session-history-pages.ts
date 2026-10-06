/**
 * Older history of a JSONL too large for the full read, in bounded windows.
 *
 * The full read refuses a file past DaemonFileReader's byte ceiling (32 MB) and
 * serves the 4 MB tail instead, so a long session's history began wherever that
 * tail did: a phone paging back with `before=` got an empty page and nothing
 * older could ever be read (measured: a 61 MB session's tail held 95 messages).
 * Here the file is read in 4 MB windows aligned to absolute byte offsets, so
 * window k is the same bytes however much the file grows after it, and each
 * window's earliest timestamp is remembered: the next page jumps straight to the
 * window it needs instead of reading back from the end again.
 */
import { readSessionHistoryRange, type SessionHistoryMessage } from './session-history.js';

const WINDOW_BYTES = 4 * 1024 * 1024;
/** Most windows one page reads, so a tap costs at most this many bounded reads. */
const MAX_WINDOWS_PER_PAGE = 4;
const MAX_INDEXED_SESSIONS = 50;

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
 * Is this session's file too large for the full read (DaemonFileReader's byte
 * ceiling)? false when it cannot tell, so the caller keeps the full read.
 */
export async function isPastFullReadCeiling(
  sessionId: string, cwd: string | undefined, host: string | undefined,
): Promise<boolean> {
  const probe = await readSessionHistoryRange(sessionId, cwd, host, 0, 0).catch(() => null);
  if (!probe) return false;
  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  return probe.fileSize > DaemonFileReader.maxReadBytes();
}

/** Test seam: forget every window index. */
export function _resetHistoryPagesForTests(): void {
  indexes.clear();
}

/**
 * History messages strictly older than `before`, oldest first, enough for one
 * page: at least `minMessages` of them and `minText` a reader sees as text, or
 * everything back to the start of the file, or what MAX_WINDOWS_PER_PAGE
 * windows hold. `reachedStart` says the first window was read. null = this
 * session cannot be read in windows (see readSessionHistoryRange).
 */
export async function readSessionHistoryBefore(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  before: string,
  want: { minMessages: number; minText: number; isText: (m: SessionHistoryMessage) => boolean },
): Promise<{ messages: SessionHistoryMessage[]; reachedStart: boolean } | null> {
  const key = `${sessionId}@${host ?? '__local__'}`;
  // A zero-length read answers the file's size (and whether it is readable).
  const probe = await readSessionHistoryRange(sessionId, cwd, host, 0, 0);
  if (!probe) return null;
  const idx = indexFor(key, probe.epoch);
  let last: { n: number; messages: SessionHistoryMessage[] } | null = null;
  const read = async (n: number): Promise<SessionHistoryMessage[] | null> => {
    if (last?.n === n) return last.messages;
    const got = await readSessionHistoryRange(sessionId, cwd, host, n * WINDOW_BYTES, (n + 1) * WINDOW_BYTES);
    if (!got || got.epoch !== idx.epoch) return null; // unreadable, or replaced mid-page
    idx.firstTs.set(n, got.messages[0]?.timestamp ?? null);
    last = { n, messages: got.messages };
    return got.messages;
  };
  // The newest window holding something older than `before`. Time grows with
  // the offset, so a window known to start at or after `before` rules out every
  // window above it too.
  let k = Math.max(0, Math.floor((probe.fileSize - 1) / WINDOW_BYTES));
  for (const [n, ts] of idx.firstTs) {
    if (typeof ts === 'string' && ts >= before && n <= k) k = Math.max(0, n - 1);
  }
  while (k > 0) {
    const messages = await read(k);
    if (!messages) return null;
    if (messages.length > 0 && messages[0].timestamp < before) break;
    k--;
  }
  let collected: SessionHistoryMessage[] = [];
  let windows = 0;
  let reachedStart = false;
  for (; k >= 0 && windows < MAX_WINDOWS_PER_PAGE; k--) {
    const messages = await read(k);
    if (!messages) return null;
    windows++;
    collected = messages.filter((m) => m.timestamp < before).concat(collected);
    if (k === 0) reachedStart = true;
    if (collected.length >= want.minMessages && collected.filter(want.isText).length >= want.minText) break;
  }
  return { messages: collected, reachedStart };
}
