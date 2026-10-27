/**
 * When a question's answer landed, as this tab saw it (the transcript's own
 * times are read elsewhere): the unread mark compares it with when the
 * question was last viewed, and a fresh send waits until it.
 *
 * A question is dated once it stops being live (queued or answering), at the
 * time its newest words came in: a card closed after the last words but before
 * the turn's end line leaves its answer read, and a fast turn that never showed
 * as streaming is dated by its words. Without words it is dated when a stream
 * it was live for has stopped (a turn that said nothing), never in the gap
 * between its send's delivery and its turn's start: its mark keeps waiting
 * there. Pure state stepping, one call per change (SessionChatHistory).
 */
import { ROOT_THREAD_KEY } from '@/utils/thread-tree';

export interface AnswerDating {
  /** Live questions, and ones not dated yet; whether a stream ran meanwhile. */
  live: Map<string, { streamed: boolean }>;
  /** When each of those last got new words. */
  wordsAt: Map<string, number>;
  /** The newest words seen per question (any signature that changes with them). */
  sigs: Map<string, string>;
}

export function newAnswerDating(): AnswerDating {
  return { live: new Map(), wordsAt: new Map(), sigs: new Map() };
}

export interface AnswerDatingStep {
  /** Questions queued or answering now. */
  live: ReadonlySet<string>;
  /** Question key to a signature of its newest words: `b…` from a live text
   *  block, `h…` from the transcript. */
  words: ReadonlyMap<string, string>;
  /** Questions whose own turn is streaming now. */
  streaming: ReadonlySet<string>;
  now: number;
}

/** Advance the tracker; returns the questions dated by this step and when. */
export function stepAnswerDating(d: AnswerDating, step: AnswerDatingStep): Map<string, number> {
  for (const k of step.live) {
    if (!d.live.has(k)) { d.live.set(k, { streamed: false }); d.wordsAt.delete(k); }
  }
  // Only its own turn counts: another question's stream ending is not this one's.
  for (const k of step.streaming) {
    const entry = d.live.get(k);
    if (entry) entry.streamed = true;
  }
  for (const [k, sig] of step.words) {
    const prev = d.sigs.get(k);
    if (prev === sig) continue;
    d.sigs.set(k, sig);
    // The transcript taking over words a live block already showed is no news.
    if (prev?.startsWith('b') && sig.startsWith('h')) continue;
    if (d.live.has(k)) d.wordsAt.set(k, step.now);
  }
  const dated = new Map<string, number>();
  for (const [k, entry] of d.live) {
    if (step.live.has(k)) continue;
    const words = d.wordsAt.get(k);
    if (words === undefined && !(entry.streamed && !step.streaming.has(k))) continue;
    dated.set(k, words ?? step.now);
    d.live.delete(k);
    d.wordsAt.delete(k);
  }
  dated.delete(ROOT_THREAD_KEY);
  return dated;
}
