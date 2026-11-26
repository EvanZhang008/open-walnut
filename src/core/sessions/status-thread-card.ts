/**
 * A status line rewrites no card that still holds (2026-11-23, the user: "每次它结束聊天之后，我会看到
 * 屏幕闪一下，会显示好多好多不同的 thread"). The turn-end status question is a side question that never
 * sees its own last answer: his VP wrote every card it was asked about anew each turn (12 of 12, the
 * same state in new words), so the cards in Done changed their words and height and re-sorted under
 * his eyes, every turn. On a card in his sight (answered), one rule: the same result again is no news.
 *
 *   the question   quotes the card his Done shows, and asks for a line there only when the result
 *                  changed or it is done (real news on a result has no other way)
 *   a line         working or waiting on a result he has not read (Walnut keeps it answered) writes
 *                  no progress over that result (status-threads.ts patchForLine)
 *
 *   an answer      puts new words on at most CARDS_RESTATED_MAX answered cards that still hold:
 *                  more at once is the list said again, and none of those words is written
 *
 * Working and waiting threads are hidden from him: their lines go on as before, words included
 * (2026-11-22: "its words still go on, quietly"), and the task's own state is read from them.
 *
 * A card holds while it is the node's summary and answers his newest word there: none while a word
 * of his waits (a message joined only by timing included) or a summary is owed (thread-view.ts).
 */
import { cardView, sharedAnswers, summaryOwed, uncheckedJoin } from '../org/thread-view.js';
import type { OrgThread, ThreadPatch } from '../org/threads-model.js';
import { cutEnd } from '../text-cut.js';

/** How much of a card the question quotes: enough to tell whether it still holds. */
export const CARD_SHOWN_MAX = 80;

/** The rule beside the line format (2026-11-24, Opus on his VP's question: worded as a leave-out alone, it left out the working and waiting lines too). */
export const CARD_KEEPS_LINE = 'One exception to a line per thread: an answered thread whose card (quoted above) still holds takes no line while it stays answered; a changed state or result takes one (a corrected result: answered with the new result), and so does done. Every working and waiting thread still takes its line.';

const NONE: ReadonlySet<string> = new Set();

/** His card holds the node's summary, answering his newest word there (no word of his waits, none owed). Pure. */
export function cardHolds(t: OrgThread): boolean {
  return !!t.reply?.trim() && !t.messages.some(uncheckedJoin) && !summaryOwed(t);
}

/**
 * The words the question quotes for `t`: an answered thread's card as his Done shows it (the web's
 * own cardView, with the replies shared between threads as the list reads them), while it holds. Pure.
 */
export function cardWords(t: OrgThread, shared: ReadonlySet<string> = NONE): string | undefined {
  if (t.state !== 'answered' || !cardHolds(t)) return undefined;
  const v = cardView(t, shared);
  return v.summary.by === 'node' && !v.summary.stale && !v.waiting.length ? v.summary.text : undefined;
}

/** The card as the question lists it beside the thread's state ('' for none). Pure. */
export function cardPart(card: string | undefined): string {
  if (!card) return '';
  const t = card.replace(/\s+/g, ' ').trim();
  return `; card: "${t.slice(0, cutEnd(t, CARD_SHOWN_MAX))}"`;
}

/**
 * A line Walnut kept from hiding a result he has not read (`named`, the state it said, is not
 * answered; `state`, the one it writes, is): its words are progress, never written over that result
 * while the card holds. Pure.
 */
export function keepsCardWords(t: OrgThread, state: OrgThread['state'], named: OrgThread['state']): boolean {
  return state === 'answered' && t.state === 'answered' && named !== 'answered' && cardHolds(t);
}

/**
 * One status answer puts new words on at most this many answered cards that still hold. The rule
 * beside the line format is the model's to follow, not a brake (2026-11-26, the thread monitor: one
 * answer wrote all 6 answered cards it was asked about anew, 5 of them quoted to it as holding, and
 * his cards lost their detail and two the links of their result). Measured on the saved versions of
 * every node's threads, 2,049 status answers since the 11-23 fix: 239 put new words on one such
 * card, 26 on two, 3 on three (the ones read were results that had moved on), and that one on six.
 * More than three at once is the list said again, never that many results changed in a turn whose
 * reply spoke of none of them.
 */
export const CARDS_RESTATED_MAX = 3;

/**
 * A write that only puts new words on a card the question quoted as holding (cardWords, so the
 * count is of the very cards the rule named): no state moves, nothing closes. Pure.
 */
export function restatesCard(t: OrgThread, patch: Pick<ThreadPatch, 'state' | 'reply' | 'close'>, shared: ReadonlySet<string> = NONE): boolean {
  return !patch.close && !!patch.reply && (patch.state ?? 'answered') === 'answered' && cardWords(t, shared) !== undefined;
}

/**
 * The writes of one status answer without the list said again: when it restates more than
 * CARDS_RESTATED_MAX cards (counted by thread, a close's fallback included: refused, it writes the
 * same words), none of those words is written (`restated`: their threads), and his cards keep what
 * they said. Every other write of the answer stays: a state that moves, a close (without that
 * fallback), a title, a card that did not hold. Pure.
 */
export function withoutRestated<W extends { id: string; patch: ThreadPatch; fallback?: ThreadPatch }>(threads: readonly OrgThread[], writes: readonly W[]): { writes: W[]; restated: string[] } {
  const by = new Map(threads.map((t) => [t.id, t]));
  const shared = sharedAnswers(threads);
  const says = (w: W, patch: ThreadPatch | undefined) => { const t = by.get(w.id); return !!t && !!patch && restatesCard(t, patch, shared); };
  const restated = [...new Set(writes.filter((w) => says(w, w.patch) || says(w, w.fallback)).map((w) => w.id))];
  if (restated.length <= CARDS_RESTATED_MAX) return { writes: [...writes], restated: [] };
  const kept = writes.filter((w) => !says(w, w.patch)).map((w) => {
    if (!says(w, w.fallback)) return w;
    const { fallback: _f, ...rest } = w;
    return rest as W;
  });
  return { writes: kept, restated };
}
