/**
 * One stored copy of each reply in the Threads database (2026-11-21, the user: "如果说他是回复我了，
 * 那这段回复难道不能用到这个 thread 上面吗 ... To save token, be efficient"). Two messages he sent
 * before the node spoke share that one answer (thread-answers.ts), and the store kept it under each:
 * 1.73 copies a reply on the Walnut VP, one reply 7 times. Now a message row whose answer is the same
 * as an earlier message's in its thread stores only `{ same: <that message's id> }`, and the load puts
 * the answer back, so every reader, the routes the web console and the phone read included, sees the
 * threads as before.
 *
 * Only the database's rows (threads-db.ts, schema 2, which an older build refuses): the JSON files,
 * which an older build and the JSON mode read, keep every reply whole. The first message keeps the
 * whole answer, so its words are never only a reference.
 *
 * Ratchet: tests/core/org/thread-answer-refs.test.ts.
 */
import type { ThreadAnswer, ThreadMessage } from './threads-model.js';

/** An answer as stored in place of a copy: the earlier message of the same thread that holds it. */
export interface StoredAnswerRef { same: string }

const isRef = (a: unknown): a is StoredAnswerRef =>
  !!a && typeof a === 'object' && typeof (a as StoredAnswerRef).same === 'string' && typeof (a as { text?: unknown }).text !== 'string';

/** Messages as stored: an answer identical to an earlier message's becomes a reference to it. Pure. */
export function storedMessages(messages: readonly ThreadMessage[]): ThreadMessage[] {
  const first = new Map<string, string>();
  let changed = false;
  const out = messages.map((m) => {
    if (!m.answer || typeof m.answer.text !== 'string') return m;
    const key = JSON.stringify(m.answer);
    const holder = first.get(key);
    if (holder === undefined) { first.set(key, m.id); return m; }
    changed = true;
    return { ...m, answer: { same: holder } as unknown as ThreadAnswer };
  });
  return changed ? out : (messages as ThreadMessage[]);
}

/**
 * Stored messages read back: each reference becomes a copy of the answer it names (an earlier
 * message of this thread); a reference to nothing there is dropped, and the node's chat is read for
 * it again (resolveThreadAnswers). Unchecked input (a row's JSON). Pure.
 */
export function expandAnswerRefs<T>(messages: readonly T[]): T[] {
  if (!messages.some((m) => isRef((m as { answer?: unknown } | null)?.answer))) return messages as T[];
  const held = new Map<string, unknown>();
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const x = m as { id?: unknown; answer?: unknown };
    if (isRef(x.answer)) {
      const answer = held.get(x.answer.same);
      // In its own place, so the message reads back as the same JSON it was before it was stored.
      return Object.fromEntries(Object.entries(x).flatMap(([k, v]) => (k !== 'answer' ? [[k, v]] : answer ? [[k, structuredClone(answer)]] : []))) as T;
    }
    if (typeof x.id === 'string' && x.answer && typeof x.answer === 'object' && !held.has(x.id)) held.set(x.id, x.answer);
    return m;
  });
}
