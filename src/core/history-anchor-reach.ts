/**
 * Reach back past a whale transcript's 4 MB tail to the row a delta is anchored on.
 *
 * A JSONL past the full read's byte ceiling is only ever served as its newest 4 MB
 * (`windowed`). A turn-end delta names the newest row the client holds
 * (`anchorMsgId`), and a turn of screenshots appends more than 4 MB, so that row is
 * no longer in the tail. Declining the delta then hands the client a window that
 * shares no row with what it holds, and the client can only replace its history
 * with those few rows: every AI reply vanishes and the user's messages pile up at
 * the bottom until a reload (2026-10-05, a 352 MB session; measured per-turn
 * growth there: p90 5.6 MB, p99 31 MB).
 *
 * Here the file is read backward, in raw bytes, until the anchor id appears; one
 * contiguous run from a little before that line to the end is then parsed as a
 * single unit (the parser's cross-line passes need that, so the run is never
 * stitched from separately parsed windows). Bounded by the reader's byte ceiling:
 * past it the caller rebuilds as before, which is lossless. That ceiling is also
 * the most the full read of a smaller file parses in one go, so this costs no more
 * event-loop time than a full read already may (measured: 40-100 ms for 5-7 MB).
 */
import type { SessionHistoryMessage } from './session-history.js';

/** Bytes kept before the anchor's line, so cross-line passes see what precedes it. */
const LOOKBEHIND_BYTES = 1024 * 1024;
/** Bytes per backward read (the reader's per-call chunk). */
const READ_CHUNK_BYTES = 1024 * 1024;
/** First run tried; it doubles up to the ceiling. */
const FIRST_RUN_BYTES = 8 * 1024 * 1024;
/** Parses one reach may spend on occurrences of the id that are not its row. */
const MAX_PARSE_ATTEMPTS = 3;

export interface AnchorReach {
  messages: SessionHistoryMessage[];
  /** Bytes from the run's start to the end of the file. */
  bytes: number;
}

interface RangeReader {
  stat(path: string): Promise<{ size: number } | null>;
  readRangeBytes(path: string, start: number, length: number): Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null>;
  findSessionPath(sessionId: string): Promise<string | null>;
}

const inflight = new Map<string, Promise<AnchorReach | null>>();

/**
 * The session's history from just before the row whose msgId is `anchorMsgId` to
 * the end of the file, or null when the id is not within the reader's ceiling of
 * the end (or the file cannot be read this way).
 */
export function readHistoryReachingAnchor(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  anchorMsgId: string,
): Promise<AnchorReach | null> {
  const key = `${sessionId}@${host ?? '__local__'}|${anchorMsgId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = reach(sessionId, cwd, host, anchorMsgId);
  inflight.set(key, run);
  void run.finally(() => { if (inflight.get(key) === run) inflight.delete(key); }).catch(() => {});
  return run;
}

async function reach(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  anchorMsgId: string,
): Promise<AnchorReach | null> {
  const history = await import('./session-history.js');
  // Rewind cuts resolve against the whole file; no window can apply them.
  if (await history.hasInPlaceRewinds(sessionId)) return null;
  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  const daemonHost = host ?? '__local__';
  const reader: RangeReader = new DaemonFileReader(daemonHost);
  const path = await history.resolveHistoryWindowPath(sessionId, cwd, daemonHost, reader);
  if (!path) return null;
  const st = await reader.stat(path);
  if (!st) return null;
  const size = st.size;
  const ceiling = Math.min(DaemonFileReader.maxReadBytes(), size);
  // Quoted, so `msg_1` never matches inside `msg_12`.
  const needle = Buffer.from(JSON.stringify(anchorMsgId));

  // `run` holds bytes [base, size) of the file, grown backward.
  let run = Buffer.alloc(0);
  let base = size;
  let parses = 0;
  // Occurrences at or past this offset in `run` were already tried.
  let triedBelow = Number.POSITIVE_INFINITY;
  for (let want = Math.min(FIRST_RUN_BYTES, ceiling); ; want = Math.min(want * 2, ceiling)) {
    if (want > size - base) {
      const grown = await readBackward(reader, path, base, size - want);
      if (!grown) return null;
      run = Buffer.concat([grown, run]);
      base = size - want;
      if (triedBelow !== Number.POSITIVE_INFINITY) triedBelow += grown.length;
    }
    // Newest occurrence first. A negative offset would search from the END of the
    // buffer (Buffer.lastIndexOf semantics), so the walk stops before index 0 is passed.
    for (let p = lastBefore(run, needle, triedBelow); p >= 0; p = lastBefore(run, needle, p)) {
      const lineStart = run.lastIndexOf(0x0a, p) + 1;
      // The line began before what is held: grow, then retry this occurrence.
      if (lineStart === 0 && base > 0) { triedBelow = p + 1; break; }
      triedBelow = p;
      const from = runStart(run, base, lineStart);
      if (parses++ >= MAX_PARSE_ATTEMPTS) return null;
      const messages = await history.parseHistoryWindowText(sessionId, run.subarray(from).toString('utf-8'));
      if (messages.some((m) => m.msgId === anchorMsgId)) return { messages, bytes: run.length - from };
      // A later mention (a tool result quoting the id, a child's parentUuid): look further back.
    }
    if (want >= ceiling) return null;
  }
}

/** Start of the last occurrence of `needle` that begins before `limit`, or -1. */
function lastBefore(run: Buffer, needle: Buffer, limit: number): number {
  const at = Math.min(limit, run.length) - 1;
  return at < 0 ? -1 : run.lastIndexOf(needle, at);
}

/** Where the parsed run starts: a whole line about LOOKBEHIND_BYTES before `lineStart`. */
function runStart(run: Buffer, base: number, lineStart: number): number {
  const target = lineStart - LOOKBEHIND_BYTES;
  if (target <= 0) {
    // Not that much held: from the first whole line (the file start when base is 0).
    return base === 0 ? 0 : run.indexOf(0x0a) + 1;
  }
  return run.indexOf(0x0a, target - 1) + 1;
}

/** Bytes [from, to) of the file, read in reader-sized chunks. */
async function readBackward(reader: RangeReader, path: string, to: number, from: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  // Advance by what came back: a short read must not leave a hole in the run.
  for (let at = from; at < to;) {
    const res = await reader.readRangeBytes(path, at, Math.min(READ_CHUNK_BYTES, to - at));
    if (!res || res.buf.length === 0) return null;
    parts.push(res.buf);
    at += res.buf.length;
  }
  return Buffer.concat(parts);
}
