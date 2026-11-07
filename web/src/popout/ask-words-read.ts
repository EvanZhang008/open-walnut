/**
 * Where the extension's surfaces read what an ask (or any task) last said in its conversation:
 * the drawer and Continue rows, the Tasks view's rows and its open row all read it here, and
 * nowhere else (tests/web/ext-ask-words-surfaces.test.ts).
 *
 * A conversation's newest replies are its session's transcript tail. A phone chat opened again is
 * a lane session that never ran a turn of its own: its transcript is empty and the whole chat is in
 * chat history, which the server serves as the part of the chat older than the session
 * (GET /api/v1/sessions/:id/chat-earlier, the rows ChatEarlierBlock draws). Review 2026-11-06 round
 * 4: such an ask read "Take a look" while its chat held 30 answers.
 */
import { apiGet } from '@/api/client';
import { fetchSessionHistory } from '@/api/sessions';
import type { ChatEarlierMessage } from '@/components/sessions/chat-earlier-parts';

export type ReplyRow = { role: string; text?: string };

const hasReply = (rows: readonly ReplyRow[]): boolean => rows.some((m) => m.role === 'assistant' && (m.text ?? '').trim() !== '');

/** The earlier part's text rows (its tool, thinking and notice rows are no reply). Pure. */
export function earlierReplyRows(rows: readonly ChatEarlierMessage[]): ReplyRow[] {
  return rows.filter((m) => !m.kind).map((m) => ({ role: m.role, text: m.text }));
}

export interface ReplySources {
  history: (sessionId: string, tail: number, signal?: AbortSignal) => Promise<readonly ReplyRow[]>;
  /** The chat's earlier part, its last `tail` text rows (an older server sends the whole part). */
  earlier: (sessionId: string, tail: number, signal?: AbortSignal) => Promise<{ messages?: ChatEarlierMessage[]; degraded?: boolean }>;
}

const liveSources: ReplySources = {
  history: async (sessionId, tail, signal) => (await fetchSessionHistory(sessionId, { tail, turns: 1, ...(signal ? { signal } : {}) })).messages,
  earlier: (sessionId, tail, signal) => apiGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/chat-earlier?tail=${tail}`, undefined, { priority: 'low', ...(signal ? { signal } : {}) }),
};

/**
 * How long this frame keeps what a chat's earlier part said. That part is what the chat said before
 * its session started, so a new answer never changes it; the server assembles it from the whole
 * chat, its slowest read, and a frame reading it again at every change of its rows ran that read
 * again while the server was slowest (review round 4, M3). A server out of time (or a failed read)
 * is kept too, 30 s the first time (a cold chat's first read can take the whole budget, the next
 * one a second) and twice as long each time after, up to EARLIER_KEEP_MS.
 */
export const EARLIER_KEEP_MS = 5 * 60_000;
const EARLIER_UNKNOWN_MS = 30_000;
/** The earlier part's rows asked for, whatever a caller's tail: one kept answer serves them all. */
const EARLIER_TAIL = 8;

type Earlier = { rows: readonly ReplyRow[] } | null;
interface Memo {
  earlier: Map<string, { at: number; value: Earlier; holdMs: number }>;
  reads: Map<string, Promise<readonly ReplyRow[] | null>>;
}
const memos = new WeakMap<ReplySources, Memo>();
function memoOf(src: ReplySources): Memo {
  let m = memos.get(src);
  if (!m) { m = { earlier: new Map(), reads: new Map() }; memos.set(src, m); }
  return m;
}

const abortError = (signal: AbortSignal): unknown => signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
/** `p`, or the caller's abort first: a read shared by several rows goes on for the others. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * The conversation's newest rows with a reply among them: the transcript's tail, else the chat's
 * earlier part when the transcript has no reply. `null` when neither could say now (a server out
 * of time, a failed read): the caller reads again next time rather than keep "nothing". An abort
 * is thrown, as fetch throws it. Rows of this frame reading one conversation at once share one
 * read, and the earlier part is kept EARLIER_KEEP_MS.
 */
export function latestReplies(
  sessionId: string,
  opts: { tail: number; signal?: AbortSignal },
  src: ReplySources = liveSources,
  now: () => number = Date.now,
): Promise<readonly ReplyRow[] | null> {
  const memo = memoOf(src);
  const key = `${sessionId}|${opts.tail}`;
  let read = memo.reads.get(key);
  if (!read) {
    read = readReplies(sessionId, opts.tail, src, memo, now).finally(() => { memo.reads.delete(key); });
    memo.reads.set(key, read);
  }
  return untilAborted(read, opts.signal);
}

async function readReplies(sessionId: string, tail: number, src: ReplySources, memo: Memo, now: () => number): Promise<readonly ReplyRow[] | null> {
  let own: readonly ReplyRow[] = [];
  let ownRead = true;
  try {
    own = await src.history(sessionId, tail);
  } catch (err) {
    // No transcript at all (404: a session that never ran here) says nothing; anything else is unknown.
    ownRead = (err as { status?: unknown } | null)?.status === 404;
  }
  if (hasReply(own)) return own;
  const kept = memo.earlier.get(sessionId);
  let earlier: Earlier;
  if (kept && now() - kept.at < kept.holdMs) {
    earlier = kept.value;
  } else {
    try {
      const e = await src.earlier(sessionId, EARLIER_TAIL);
      earlier = e.degraded ? null : { rows: earlierReplyRows(Array.isArray(e.messages) ? e.messages : []) };
    } catch {
      earlier = null;
    }
    const holdMs = earlier ? EARLIER_KEEP_MS : Math.min(EARLIER_KEEP_MS, kept && !kept.value ? kept.holdMs * 2 : EARLIER_UNKNOWN_MS);
    memo.earlier.delete(sessionId);
    memo.earlier.set(sessionId, { at: now(), value: earlier, holdMs });
    if (memo.earlier.size > 200) memo.earlier.delete(memo.earlier.keys().next().value as string);
  }
  if (!earlier) return null;
  if (hasReply(earlier.rows)) return earlier.rows.slice(-tail);
  return ownRead ? own : null;
}
