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
import crypto from 'node:crypto';
import type { OrgThread, ThreadsFile, ThreadWriter } from './threads-model.js';

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
  options: Array<{ id: string; label: string; description?: string }>;
  /** Closed by Walnut because the experiment went off: opened again when it comes back on. */
  off?: true;
  /** The letter ended (answered, settled, archived): the thread no longer holds it, whatever it asks later. */
  done?: true;
}

/** The one thread id of a letter's thread. */
export function letterThreadId(letterId: string): string {
  return `th-${crypto.createHash('sha256').update(`letter:${letterId}`).digest('hex').slice(0, 24)}`;
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
    .map((o) => ({ id: o.id, label: o.label, ...(isStr(o.description) && o.description ? { description: o.description } : {}) }));
  return { id: x.id, task: x.task, options, ...(x.off === true ? { off: true as const } : {}), ...(x.done === true ? { done: true as const } : {}) };
}

/** A letter the thread still stands for: not ended, not set aside by the experiment going off. */
export function liveLetter(t: Pick<OrgThread, 'letter'>): boolean {
  return !!t.letter && !t.letter.done && !t.letter.off;
}

/** The thread still waits on him for its letter's decision: open, in needs, holding a live letter. */
export function holdsLetter(t: Pick<OrgThread, 'closed' | 'state' | 'letter'>): boolean {
  return liveLetter(t) && !t.closed && t.state === 'needs';
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
  const cur = file.threads.find((t) => t.id === id);
  if (cur) {
    const asideNow = !!cur.letter?.off && !cur.letter.done && !cur.movedTo && (!!cur.closed || cur.state === 'needs');
    if (!asideNow) return { file, thread: cur, changed: null };
    const { closed: _c, ...rest } = cur;
    const { off: _o, ...letter } = cur.letter!;
    const next: OrgThread = { ...rest, state: 'needs', letter, updatedAt: input.at, by: input.by };
    return { file: { ...file, threads: file.threads.map((t) => (t.id === id ? next : t)) }, thread: next, changed: 'reopened' };
  }
  const l = input.letter;
  const sent = new Date(l.createdAt).toISOString();
  const subject = clip(l.subject, LETTER_THREAD_TITLE_MAX) || 'A decision waits for you';
  const detail = l.detail?.trim() ? clip(l.detail, REPLY_MAX) : undefined;
  const thread: OrgThread = {
    id, title: subject, titled: true, ask: clip(l.subject, ASK_MAX) || subject, state: 'needs',
    ...(detail ? { reply: detail, replyAt: sent, reply_by: input.by } : {}),
    messages: [],
    opener: { text: clip(l.preview?.trim() || l.subject, TEXT_MAX), at: sent, from: 'letter', ref: l.id, by: input.by },
    createdAt: sent, updatedAt: input.at, by: input.by,
    letter: { id: l.id, task: l.task, options: l.options.slice(0, OPTIONS_MAX) },
  };
  return { file: { ...file, threads: [...file.threads, thread] }, thread, changed: 'opened' };
}

/** How the letter ended, as its thread says it. */
export type LetterOutcome =
  /** He answered it himself (a pick or his words): nothing new for him, so the thread closes as known. */
  | { kind: 'his'; words: string }
  /** Someone answered it for him (a lead, a VP, Main): news for him, so the thread stays as answered. */
  | { kind: 'for_him'; words: string }
  /** Nobody needs to answer it any more (settled, withdrawn, archived): the thread closes as dropped. */
  | { kind: 'moot'; words: string; byHim?: boolean }
  /** The experiment went off: closed, and opened again when it comes back (ThreadLetter.off). */
  | { kind: 'off' };

/**
 * The letter no longer waits on him: its thread, while it still waits on him for it (holdsLetter),
 * says how it ended. A thread that left needs (his words on it made it working, its node moved it
 * on) is its own conversation now and is left as it is. Null when nothing changed.
 */
export function settleLetterThread(file: ThreadsFile, threadId: string, outcome: LetterOutcome, at: string): { file: ThreadsFile; thread: OrgThread } | null {
  const cur = file.threads.find((t) => t.id === threadId);
  if (!cur || !holdsLetter(cur)) return null;
  let next: OrgThread;
  if (outcome.kind === 'off') {
    next = { ...cur, letter: { ...cur.letter!, off: true }, closed: { how: 'dropped', at, by: 'agent', told: true } };
  } else {
    const reply = clip(outcome.words, REPLY_MAX);
    const by: ThreadWriter = outcome.kind === 'his' || (outcome.kind === 'moot' && outcome.byHim) ? 'human' : 'agent';
    const { pinned: _p, snoozed: _s, ...rest } = cur;
    next = {
      ...(outcome.kind === 'for_him' ? cur : rest), state: 'answered', reply, replyAt: at, reply_by: by, updatedAt: at, by,
      // Ended: a later ask on this thread is the node's own, never this letter's again.
      letter: { ...cur.letter!, done: true },
      ...(outcome.kind === 'his' ? { closed: { how: 'acked' as const, at, by, reacted: true, told: true }, reactedAt: at } : {}),
      ...(outcome.kind === 'moot' ? { closed: { how: 'dropped' as const, at, by, told: true } } : {}),
    };
    // Walnut wrote this summary from the letter: no session's words, so no session to open paths on.
    delete next.reply_sid;
    delete next.reply_host;
  }
  return { file: { ...file, threads: file.threads.map((t) => (t.id === threadId ? next : t)) }, thread: next };
}
