/**
 * A Board choice held by a thread (experiment `brief_off`, step 5 of "Only Threads": the Board
 * keeps the leader's own overview, and what it asks the user becomes a thread). An unanswered
 * `<walnut-choice>` on a leader's Board waits on him as a needs thread of that leader, carrying
 * the choice's title, its options and its recommended one (`choice`); the card answers through
 * the Board's own choice route, so the Board and the thread are one decision, answered in either
 * place. The same shape a decision letter takes (letter-thread-model.ts).
 *
 * The thread id comes from the Board and the choice id (choiceThreadId), so one choice has one
 * thread however often it is synced and wherever the thread moved since.
 *
 * Pure: each function takes the file and returns the next one. boards/choice-threads.ts runs them
 * under the threads file lock.
 */
import type { OrgThread, ThreadsFile, ThreadWriter } from './threads-model.js';
import { heldThreadId, holdsHeld, openHeldThread, settleHeldThread, type HeldOutcome } from './held-thread-model.js';

const TITLE_MAX = 120;
const OPTIONS_MAX = 8;
const LABEL_MAX = 200;

/** The Board choice a thread holds (OrgThread.choice). An older build keeps it unread (normalizeThread spreads unknown fields). */
export interface ThreadChoice {
  /** The Board's task (its owner): the answer is written there. */
  board: string;
  /** The choice's id on that Board. */
  id: string;
  /** The task the choice is about, when it names one other than the Board's own. */
  task?: string;
  /** The choice's options, as the Board had them when the thread opened. */
  options: Array<{ value: string; label: string }>;
  recommended?: string;
  /** Closed by Walnut because the experiment went off: opened again when it comes back on. */
  off?: true;
  /** The choice ended (answered, removed from the Board): the thread no longer holds it. */
  done?: true;
}

/** The one thread id of a Board choice's thread. */
export function choiceThreadId(board: string, choiceId: string): string {
  return heldThreadId('choice', `${board}/${choiceId}`);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const clip = (s: string, max: number): string => { const t = s.trim(); return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`; };

/** The field as read from disk: kept only whole, else dropped (the thread reads as an ordinary one). */
export function normalizeThreadChoice(v: unknown): ThreadChoice | undefined {
  const x = v as Partial<ThreadChoice> | undefined;
  if (!x || typeof x !== 'object' || !isStr(x.board) || !x.board || !isStr(x.id) || !x.id) return undefined;
  const options = (Array.isArray(x.options) ? x.options : [])
    .filter((o): o is ThreadChoice['options'][number] => !!o && typeof o === 'object' && isStr(o.value) && isStr(o.label))
    .slice(0, OPTIONS_MAX)
    .map((o) => ({ value: o.value, label: clip(o.label, LABEL_MAX) }));
  return {
    board: x.board, id: x.id, options,
    ...(isStr(x.task) && x.task ? { task: x.task } : {}),
    ...(isStr(x.recommended) && options.some((o) => o.value === x.recommended) ? { recommended: x.recommended } : {}),
    ...(x.off === true ? { off: true as const } : {}),
    ...(x.done === true ? { done: true as const } : {}),
  };
}

/** The thread still waits on him for its Board choice: open, in needs, holding a choice not ended or set aside. */
export function holdsChoice(t: Pick<OrgThread, 'closed' | 'state' | 'choice'>): boolean {
  return holdsHeld(t, 'choice');
}

export interface ChoiceThreadInput {
  choice: { board: string; id: string; task?: string; title: string; options: ThreadChoice['options']; recommended?: string };
  /** The Board's task: its session wrote the choice. */
  by: ThreadWriter;
  at: string;
}

/**
 * The choice's thread on `file`: opened in needs when the file has none with its id; one set aside
 * when the experiment went off holds it again; any other (open, closed by him or its node, ended,
 * a pointer to where it moved) is left as it is. Never two.
 */
export function openChoiceThread(file: ThreadsFile, input: ChoiceThreadInput): { file: ThreadsFile; thread: OrgThread; changed: 'opened' | 'reopened' | null } {
  const c = input.choice;
  const id = choiceThreadId(c.board, c.id);
  return openHeldThread(file, 'choice', id, () => {
    const title = clip(c.title, TITLE_MAX) || 'A choice on the Board waits for you';
    return {
      id, title, titled: true, ask: title, state: 'needs',
      messages: [],
      opener: { text: title, at: input.at, from: 'node', ref: 'a choice on its Board', by: input.by },
      ...(c.task && c.task !== c.board ? { tasks: [c.task] } : {}),
      createdAt: input.at, updatedAt: input.at, by: input.by,
      choice: normalizeThreadChoice({ board: c.board, id: c.id, task: c.task, options: c.options, recommended: c.recommended })!,
    };
  }, input.at, input.by);
}

/** How the choice ended, as its thread says it (held-thread-model.ts HeldOutcome). */
export type ChoiceOutcome = HeldOutcome;

/** The Board's answer record, in the words its thread says it with. Pure. */
export function choiceOutcome(answer: { option: string; label?: string; text?: string; by?: string; by_name?: string; text_by?: string; text_by_name?: string }): ChoiceOutcome {
  const said = [answer.option ? (answer.label || answer.option) : '', answer.text?.trim() ? `“${clip(answer.text, 300)}”` : ''].filter(Boolean).join(' ');
  const agent = answer.option ? answer.by : answer.text_by;
  const name = answer.option ? answer.by_name : answer.text_by_name;
  if (agent && agent !== 'human') return { kind: 'for_him', words: `Answered for you by ${name || 'another task'}: ${said || 'an answer'}` };
  return { kind: 'his', words: `You answered: ${said || 'an answer'}` };
}

/** The choice no longer waits on him: its thread says how it ended (held-thread-model.ts settleHeldThread). */
export function settleChoiceThread(file: ThreadsFile, threadId: string, outcome: ChoiceOutcome, at: string): { file: ThreadsFile; thread: OrgThread } | null {
  return settleHeldThread(file, threadId, 'choice', outcome, at);
}
