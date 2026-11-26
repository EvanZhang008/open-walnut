/**
 * His answer from a card goes to the thread that asked (2026-11-25, the user, of two cards for one
 * matter: "the thread is completely duplicated ... I already gave it the new update, and the old
 * thread did not go away"). A task asked one decision three ways: its report's ask, a decision
 * letter, and the letter's thread. He tapped an option on the report's ask; that answer reaches the
 * session as a chat message (`Answer to "<ask>": <words>`, user-status.ts askAnswerText) naming no
 * thread, so it was filed as a new thread beside the one that asked, and the letter stayed open.
 *
 * Here the answer finds its thread, by what it says alone. A thread fits when it asks the quoted
 * question, never for an option alone ("Approve" or "Yes" is on many cards; review 2026-11-26: a
 * pick alone answered the letter of another decision of the same task):
 *  - the same ask: the thread asks the quoted question in the same content words (sameAskText),
 *    whatever he answered;
 *  - the same ask in other words, with his pick: one asks only what the other asks, detail added or
 *    left out (askIsPartOf or wordsWithin, either way), or it is the same ask reworded
 *    (sameAskReworded), AND his words are one of the thread's own options (its letter's or its
 *    needs choices) with words of its own. A bare yes or no never counts here: it fits the same
 *    content words only.
 * The same content words come first among all open threads, then the reworded ask with his pick;
 * within each, a thread still waiting on him comes first and one already answered takes a resend of
 * the same answer. Two that fit alike are no answer (null): the message is filed as any other.
 *
 * Readers: thread-capture.ts (the message is filed under it, never a new thread) and the send routes
 * (cardAnswerLetter: a live decision letter that thread holds is answered with his words, once,
 * through letter-follow-up.ts; only for a task that keeps Threads). Pure but for cardAnswerLetter's reads.
 */
import { parseCardAnswer } from '../user-status.js';
import { askIsPartOf, askShape, sameAskReworded, sameAskText } from '../same-ask.js';
import { answersOnly } from '../ask-decision.js';
import { threadAskText } from './thread-task-ask.js';
import { liveLetter } from './letter-thread-model.js';
import type { OrgThread } from './threads-model.js';

type AskingThread = Pick<OrgThread, 'id' | 'state' | 'closed' | 'movedTo' | 'ask' | 'reply' | 'title' | 'options' | 'letter' | 'reportAsk' | 'opener' | 'updatedAt'>;

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** What the thread asks him, in each place it keeps it: its ask or summary, its report's ask, the node's first post, its letter's subject (the title). */
function asksOf(t: AskingThread): string[] {
  return [threadAskText(t), t.reportAsk?.ask, t.opener?.text, t.letter ? t.title : undefined].filter((a): a is string => !!a?.trim());
}

/** The labels he could pick on its card: its needs choices and its letter's options. */
function labelsOf(t: AskingThread): string[] {
  return [...(t.options ?? []), ...(t.letter?.options ?? [])].map((o) => o.label).filter((l) => !!l?.trim());
}

/** The label his words pick: the words alone, or the label first and his own words after it (askAnswerText joins them with ". " or ", "). */
function pickedLabel(words: string, labels: readonly string[]): string | null {
  const said = flat(words);
  return labels.find((l) => { const n = flat(l); return said === n || said.startsWith(`${n}. `) || said.startsWith(`${n}, `); }) ?? null;
}

/** A question this short is never "within" another by its words alone. */
const WITHIN_MIN = 4;

/**
 * `part` asks nothing `whole` does not: every content word of it is in `whole`, at least WITHIN_MIN
 * of them, with the same "not". Order aside (askIsPartOf keeps the order where a number is named, and
 * a report's ask that retells its letter's question moves the words): never proof alone, only beside
 * his pick among the thread's own options (fits). Pure.
 */
function wordsWithin(part: string, whole: string): boolean {
  const p = askShape(part);
  const w = askShape(whole);
  if (p.neg !== w.neg || p.words.length < WITHIN_MIN) return false;
  const have = new Set(w.words);
  return p.words.every((x) => have.has(x));
}

/**
 * How the thread asks what the card answer answers: 'ask' the same content words; 'pick' the same
 * ask in other words and his pick among its own options; null neither.
 */
function fits(t: AskingThread, ask: string, words: string): 'ask' | 'pick' | null {
  const asks = asksOf(t);
  if (asks.some((a) => sameAskText(a, ask))) return 'ask';
  const label = pickedLabel(words, labelsOf(t));
  if (!label || answersOnly(label)) return null;
  return asks.some((a) => askIsPartOf(a, ask) || askIsPartOf(ask, a) || wordsWithin(a, ask) || wordsWithin(ask, a) || sameAskReworded(a, ask)) ? 'pick' : null;
}

/**
 * The thread a card answer goes to, or null (not a card answer, no thread asks it, or two do). Pure.
 */
export function cardAnswerThread<T extends AskingThread>(threads: readonly T[], text: string): T | null {
  const card = parseCardAnswer(text);
  if (!card) return null;
  const open = threads.filter((t) => !t.closed && !t.movedTo);
  for (const kind of ['ask', 'pick'] as const) {
    const hits = open.filter((t) => fits(t, card.ask, card.words) === kind);
    if (!hits.length) continue;
    const waiting = hits.filter((t) => t.state === 'needs' || liveLetter(t));
    const pool = waiting.length ? waiting : hits;
    return pool.length === 1 ? pool[0] : null;
  }
  return null;
}

/**
 * For a send that names no thread: the thread holding a decision letter that this card answer
 * answers, and his words for it (the letter's answer is what he said, never the quoted ask). Null
 * when the send is no card answer, the task keeps no Threads or its thread holds no letter. Never throws.
 */
export async function cardAnswerLetter(taskId: string, text: string): Promise<{ threadId: string; words: string } | null> {
  const card = parseCardAnswer(text);
  if (!card) return null;
  try {
    // A task with Threads turned off keeps its file: nothing in it takes his answer.
    const [{ getTask }, { keepsThreads }, { readThreads }] = await Promise.all([import('../task-manager.js'), import('./keeps-threads.js'), import('./threads-store.js')]);
    if (!keepsThreads(await getTask(taskId).catch(() => null))) return null;
    const t = cardAnswerThread((await readThreads(taskId)).threads, text);
    return t?.letter && !t.letter.off ? { threadId: t.id, words: card.words } : null;
  } catch {
    return null;
  }
}
