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
 * An ask that holds `": ` itself reads more than one way (user-status.ts cardAnswerReadings): each
 * reading is tried, and his words are what follows the ask the thread asks (readingFor).
 *
 * Readers: thread-capture.ts (the message is filed under it, never a new thread) and the send routes
 * (cardAnswerLetter: a live decision letter that thread holds is answered with his words, once,
 * through letter-follow-up.ts; only for a task that keeps Threads). Pure but for cardAnswerLetter's reads.
 */
import { cardAnswerReadings, type CardAnswer } from '../user-status.js';
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
 * The reading of the message that thread `t` asks in this `kind`, or null; `own` when its ask is the
 * thread's own words. An ask that holds `": ` itself reads several ways (cardAnswerReadings): the
 * reading whose ask is the thread's own words wins. Failing that, by kind:
 *  - 'ask': the longest ask that still fits. The writer quotes the ask whole, so a shorter one that
 *    fits too is a piece of it, with the rest of the ask read as his words.
 *  - 'pick': the shortest. His pick leads his words (askAnswerText), so a piece of the ask never fits
 *    here (its words open with the rest of the ask, not a label), and a longer one that fits has taken
 *    words of his that quote a label (review 2026-11-26: `Ops said "<label>": <label>` lost his words).
 */
function readingFor(t: AskingThread, readings: readonly CardAnswer[], kind: 'ask' | 'pick'): { card: CardAnswer; own: boolean } | null {
  const fitting = readings.filter((r) => fits(t, r.ask, r.words) === kind);
  if (!fitting.length) return null;
  const mine = new Set(asksOf(t).map(flat));
  const own = fitting.find((r) => mine.has(flat(r.ask)));
  return own ? { card: own, own: true } : { card: kind === 'ask' ? fitting[fitting.length - 1] : fitting[0], own: false };
}

/**
 * The thread a card answer goes to with the reading of the message it asks (the ask he answered and
 * his words), or null (not a card answer, no thread asks it, or two do). Among several that fit
 * alike, the one alone in asking it in the quoted words wins, and among those the one alone with the
 * longest quoted ask (one thread's ask can be the piece of another's before its inner `": `). Pure.
 */
export function cardAnswerFit<T extends AskingThread>(threads: readonly T[], text: string): { thread: T; card: CardAnswer } | null {
  const readings = cardAnswerReadings(text);
  if (!readings.length) return null;
  const open = threads.filter((t) => !t.closed && !t.movedTo);
  for (const kind of ['ask', 'pick'] as const) {
    const hits = open.flatMap((thread) => { const r = readingFor(thread, readings, kind); return r ? [{ thread, ...r }] : []; });
    if (!hits.length) continue;
    const waiting = hits.filter((h) => h.thread.state === 'needs' || liveLetter(h.thread));
    const pool = waiting.length ? waiting : hits;
    const one = pool.length === 1 ? pool[0] : onlyOwn(pool);
    return one ? { thread: one.thread, card: one.card } : null;
  }
  return null;
}

/** Among threads that fit alike: the one alone in asking it in the quoted words, else the one of those alone with the longest quoted ask. */
function onlyOwn<H extends { card: CardAnswer; own: boolean }>(pool: readonly H[]): H | null {
  const own = pool.filter((h) => h.own);
  if (own.length <= 1) return own[0] ?? null;
  const longest = Math.max(...own.map((h) => h.card.ask.length));
  const top = own.filter((h) => h.card.ask.length === longest);
  return top.length === 1 ? top[0] : null;
}

/** The thread a card answer goes to, or null (cardAnswerFit). Pure. */
export function cardAnswerThread<T extends AskingThread>(threads: readonly T[], text: string): T | null {
  return cardAnswerFit(threads, text)?.thread ?? null;
}

/**
 * For a send that names no thread: the thread holding a decision letter that this card answer
 * answers, and his words for it (the letter's answer is what he said, never the quoted ask). Null
 * when the send is no card answer, the task keeps no Threads or its thread holds no letter. Never throws.
 */
export async function cardAnswerLetter(taskId: string, text: string): Promise<{ threadId: string; words: string } | null> {
  if (!cardAnswerReadings(text).length) return null;
  try {
    // A task with Threads turned off keeps its file: nothing in it takes his answer.
    const [{ getTask }, { keepsThreads }, { readThreads }] = await Promise.all([import('../task-manager.js'), import('./keeps-threads.js'), import('./threads-store.js')]);
    if (!keepsThreads(await getTask(taskId).catch(() => null))) return null;
    const fit = cardAnswerFit((await readThreads(taskId)).threads, text);
    return fit?.thread.letter && !fit.thread.letter.off ? { threadId: fit.thread.id, words: fit.card.words } : null;
  } catch {
    return null;
  }
}
