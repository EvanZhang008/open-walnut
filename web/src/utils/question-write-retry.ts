import type { SessionThreadAnchor, SessionThreadMetaPatch } from '@/types/session';

/**
 * A question's anchor + meta write must not be lost (2026-10-27 live run in
 * WebKit: a 3 s server stall made the PATCH fail with "Load failed", the client
 * rolled the anchor back while the message itself went out, the card fell back
 * to the main conversation and the next follow-up typed in it went there as a
 * plain message). The write is an idempotent upsert, so it is retried; a write
 * that still fails keeps the question on screen as UNSAVED and is written again
 * on the next save, a reconnect, a page load or a slow timer.
 */

/** Waits before the 2nd and 3rd try (3 tries in all). */
export const QUESTION_WRITE_RETRY_MS: readonly number[] = [1000, 3000];
/** While a question is unsaved, write it again this often. */
export const QUESTION_WRITE_LATER_MS = 30_000;

export interface UnsavedQuestion {
  anchor: SessionThreadAnchor;
  meta: SessionThreadMetaPatch[];
  /** ms epoch the question was asked. */
  at: number;
}

export function unsavedQuestionsKey(sessionId: string): string {
  return `walnut:thread-question-unsaved.v1:${sessionId}`;
}

/** Older than this, an unsaved question is dropped rather than written (its
 *  message most likely never reached the session). */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function readUnsavedQuestions(sessionId: string, now = Date.now()): UnsavedQuestion[] {
  try {
    const raw = localStorage.getItem(unsavedQuestionsKey(sessionId));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((q): q is UnsavedQuestion => !!q && typeof q === 'object'
      && typeof (q as UnsavedQuestion).anchor?.msgId === 'string'
      && Array.isArray((q as UnsavedQuestion).meta)
      && typeof (q as UnsavedQuestion).at === 'number'
      && now - (q as UnsavedQuestion).at < MAX_AGE_MS);
  } catch { return []; }
}

export function writeUnsavedQuestions(sessionId: string, list: readonly UnsavedQuestion[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(unsavedQuestionsKey(sessionId));
    else localStorage.setItem(unsavedQuestionsKey(sessionId), JSON.stringify(list));
  } catch { /* private browsing / quota: the in-memory copy still retries */ }
}

/** The list with `q` recorded (one entry per question head). */
export function withUnsaved(list: readonly UnsavedQuestion[], q: UnsavedQuestion): UnsavedQuestion[] {
  return [...list.filter((x) => x.anchor.msgId !== q.anchor.msgId), q];
}

/** Entries the stored record now holds an anchor for are saved. */
export function withoutSaved(list: readonly UnsavedQuestion[], stored: readonly { msgId: string }[] | undefined): UnsavedQuestion[] {
  if (!stored || stored.length === 0) return list.slice();
  const have = new Set(stored.map((a) => a.msgId));
  return list.filter((q) => !have.has(q.anchor.msgId));
}

/** Every unsaved question's meta, to ride along in the next write. */
export function unsavedMeta(list: readonly UnsavedQuestion[]): SessionThreadMetaPatch[] {
  return list.flatMap((q) => q.meta);
}

/** `write` until it resolves, waiting `delays[i]` before try i + 2; throws the
 *  last error. `stop()` true ends early (the panel moved to another session). */
export async function retryWrite<T>(
  write: () => Promise<T>,
  opts: { delays?: readonly number[]; stop?: () => boolean; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const delays = opts.delays ?? QUESTION_WRITE_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) {
      opts.onRetry?.(i + 1, last);
      await sleep(delays[i - 1]);
      if (opts.stop?.()) break;
    }
    try { return await write(); } catch (err) { last = err; }
  }
  throw last;
}
