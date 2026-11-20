/**
 * A decision letter held by a thread (experiment `letters_as_threads`; 2026-11-20, the user, on a
 * decision letter he found in his inbox and atop his VP's chat but not in its Threads: "why it exist
 * in both place? is it the same thing"). The thread waits on him (needs) on the Threads of the task
 * that sent the letter, carrying the letter's question, its options and a link to it (`letter`);
 * its card answers through the letter's own answer path, so the letter and the thread are one
 * decision, answered in either place.
 *
 * The thread's id comes from the letter's id (letterThreadId), so one letter has one thread
 * whoever opens it, how often, and wherever the thread moved since (a pointer left behind keeps the
 * same id: threads-store.ts threadHolder follows it).
 *
 * Pure: each function takes the file and returns the next one. letter-threads.ts runs them under
 * the threads file lock.
 */
import type { OrgThread, ThreadsFile, ThreadWriter } from './threads-model.js';
import { heldThreadId, holdsHeld, liveHeld, openHeldThread, settleHeldThread, type HeldOutcome } from './held-thread-model.js';

export const LETTER_THREAD_TITLE_MAX = 120;
const ASK_MAX = 400;
const REPLY_MAX = 2000;
const TEXT_MAX = 16_000;
const OPTIONS_MAX = 8;

/** The letter a thread holds (OrgThread.letter). An older build keeps it unread (normalizeThread spreads unknown fields). */
export interface ThreadLetter {
  /** The letter's id (lt-...). */
  id: string;
  /** The task that sent it: its letter answer is found by it (web: openLetterFor). */
  task: string;
  /** The letter's buttons, as it had them when the thread opened. */
  options: Array<{ id: string; label: string; description?: string; recommended?: true }>;
  /** Closed by Walnut because the experiment went off: opened again when it comes back on. */
  off?: true;
  /** The letter ended (answered, settled, archived): the thread no longer holds it, whatever it asks later. */
  done?: true;
}

/** The one thread id of a letter's thread. */
export function letterThreadId(letterId: string): string {
  return heldThreadId('letter', letterId);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const clip = (s: string, max: number): string => { const t = s.trim(); return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`; };

/** The field as read from disk: kept only whole, else dropped (the thread reads as an ordinary one). */
export function normalizeThreadLetter(v: unknown): ThreadLetter | undefined {
  const x = v as Partial<ThreadLetter> | undefined;
  if (!x || typeof x !== 'object' || !isStr(x.id) || !x.id || !isStr(x.task) || !x.task) return undefined;
  const options = (Array.isArray(x.options) ? x.options : [])
    .filter((o): o is ThreadLetter['options'][number] => !!o && typeof o === 'object' && isStr(o.id) && isStr(o.label))
    .slice(0, OPTIONS_MAX)
    .map((o) => ({ id: o.id, label: o.label, ...(isStr(o.description) && o.description ? { description: o.description } : {}), ...(o.recommended === true ? { recommended: true as const } : {}) }));
  return { id: x.id, task: x.task, options, ...(x.off === true ? { off: true as const } : {}), ...(x.done === true ? { done: true as const } : {}) };
}

/** A letter the thread still stands for: not ended, not set aside by the experiment going off. */
export function liveLetter(t: Pick<OrgThread, 'letter'>): boolean {
  return liveHeld(t, 'letter');
}

/** The thread still waits on him for its letter's decision: open, in needs, holding a live letter. */
export function holdsLetter(t: Pick<OrgThread, 'closed' | 'state' | 'letter'>): boolean {
  return holdsHeld(t, 'letter');
}

export interface LetterThreadInput {
  letter: { id: string; task: string; subject: string; detail?: string; preview?: string; options: ThreadLetter['options']; createdAt: number };
  /** The task that sent it (its session wrote the letter). */
  by: ThreadWriter;
  at: string;
}

/**
 * The letter's thread on `file`: opened in needs when the file has none with its id; one set aside
 * when the experiment went off holds it again (closed: opened again in needs; reopened by him and
 * still in needs: as it is); any other (open, closed by him or by its node, ended, a pointer to
 * where it moved) is left as it is. Never two.
 */
export function openLetterThread(file: ThreadsFile, input: LetterThreadInput): { file: ThreadsFile; thread: OrgThread; changed: 'opened' | 'reopened' | null } {
  const id = letterThreadId(input.letter.id);
  return openHeldThread(file, 'letter', id, () => {
    const l = input.letter;
    const sent = new Date(l.createdAt).toISOString();
    const subject = clip(l.subject, LETTER_THREAD_TITLE_MAX) || 'A decision waits for you';
    const detail = l.detail?.trim() ? clip(l.detail, REPLY_MAX) : undefined;
    return {
      id, title: subject, titled: true, ask: clip(l.subject, ASK_MAX) || subject, state: 'needs',
      ...(detail ? { reply: detail, replyAt: sent, reply_by: input.by } : {}),
      messages: [],
      opener: { text: clip(l.preview?.trim() || l.subject, TEXT_MAX), at: sent, from: 'letter', ref: l.id, by: input.by },
      createdAt: sent, updatedAt: input.at, by: input.by,
      letter: { id: l.id, task: l.task, options: l.options.slice(0, OPTIONS_MAX) },
    };
  }, input.at, input.by);
}

/** How the letter ended, as its thread says it (held-thread-model.ts HeldOutcome): his answer, an
 *  answer for him, nobody needs to answer it (settled, withdrawn, archived), or the experiment off. */
export type LetterOutcome = HeldOutcome;

/** The letter no longer waits on him: its thread says how it ended (held-thread-model.ts settleHeldThread). */
export function settleLetterThread(file: ThreadsFile, threadId: string, outcome: LetterOutcome, at: string): { file: ThreadsFile; thread: OrgThread } | null {
  return settleHeldThread(file, threadId, 'letter', outcome, at);
}
