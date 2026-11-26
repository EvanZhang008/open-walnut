/**
 * His answer from a card goes to the thread that asked (2026-11-25, the user, of two cards for one
 * matter: "the thread is completely duplicated ... I already gave it the new update, and the old
 * thread did not go away"). A task asked one decision three ways: its report's ask, a decision
 * letter, and the letter's thread. He tapped an option on the report's ask; that answer reaches the
 * session as a chat message (`Answer to "<ask>": <words>`, user-status.ts askAnswerText) naming no
 * thread, so it was filed as a new thread beside the one that asked, and the letter stayed open.
 *
 * Here the answer finds its thread, by what it says alone:
 *  - the same ask: the thread asks the quoted question in the same content words (sameAskText);
 *  - the same pick: his words are one of the thread's own options (its letter's or its needs
 *    choices), a label with words of its own; a bare yes or no counts only when the thread asks the
 *    quoted question reworded (sameDecisionWords).
 * A thread still waiting on him comes first; one already answered takes a resend of the same answer.
 * Two threads that fit are no answer (null): the message is filed as any other.
 *
 * Readers: thread-capture.ts (the message is filed under it, never a new thread) and the send routes
 * (cardAnswerLetter: a live decision letter that thread holds is answered with his words, once,
 * through letter-follow-up.ts). Pure but for cardAnswerLetter's read.
 */
import { parseCardAnswer } from '../user-status.js';
import { sameAskText } from '../same-ask.js';
import { answersOnly, sameDecisionWords } from '../ask-decision.js';
import { threadAskText } from './thread-task-ask.js';
import { liveLetter } from './letter-thread-model.js';
import type { OrgThread } from './threads-model.js';

type AskingThread = Pick<OrgThread, 'id' | 'state' | 'closed' | 'movedTo' | 'ask' | 'reply' | 'title' | 'options' | 'letter' | 'reportAsk' | 'updatedAt'>;

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** What the thread asks him, in each place it keeps it: its ask or summary, its report's ask, its letter's subject (the title). */
function asksOf(t: AskingThread): string[] {
  return [threadAskText(t), t.reportAsk?.ask, t.letter ? t.title : undefined].filter((a): a is string => !!a?.trim());
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

/** The thread asks what the card answer answers. */
function fits(t: AskingThread, ask: string, words: string): 'ask' | 'pick' | null {
  const asks = asksOf(t);
  if (asks.some((a) => sameAskText(a, ask))) return 'ask';
  const label = pickedLabel(words, labelsOf(t));
  if (!label) return null;
  return !answersOnly(label) || asks.some((a) => sameDecisionWords(a, ask)) ? 'pick' : null;
}

/**
 * The thread a card answer goes to, or null (not a card answer, no thread asks it, or two do). Pure.
 */
export function cardAnswerThread<T extends AskingThread>(threads: readonly T[], text: string): T | null {
  const card = parseCardAnswer(text);
  if (!card) return null;
  const open = threads.filter((t) => !t.closed && !t.movedTo);
  const one = (list: T[]): T | null => (list.length === 1 ? list[0] : null);
  for (const group of [open.filter((t) => t.state === 'needs' || liveLetter(t)), open]) {
    const same = group.filter((t) => fits(t, card.ask, card.words) === 'ask');
    if (same.length) return one(same);
    const picked = group.filter((t) => fits(t, card.ask, card.words) === 'pick');
    if (picked.length) return one(picked);
  }
  return null;
}

/**
 * For a send that names no thread: the thread holding a decision letter that this card answer
 * answers, and his words for it (the letter's answer is what he said, never the quoted ask). Null
 * when the send is no card answer or its thread holds no letter. Never throws.
 */
export async function cardAnswerLetter(taskId: string, text: string): Promise<{ threadId: string; words: string } | null> {
  const card = parseCardAnswer(text);
  if (!card) return null;
  try {
    const { readThreads } = await import('./threads-store.js');
    const t = cardAnswerThread((await readThreads(taskId)).threads, text);
    return t?.letter && !t.letter.off ? { threadId: t.id, words: card.words } : null;
  } catch {
    return null;
  }
}
