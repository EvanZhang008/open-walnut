/**
 * Routine progress goes to a thread, never an inbox letter (2026-11-20, the user: "we prefer the
 * thread instead of inbox. Inbox for the important message need my attention right away, but
 * thread is for all regular thing related to this thread, easier to track").
 *
 * A session of a task that keeps Threads (org/keeps-threads.ts) that sends a letter which only
 * informs (LETTER_TYPE_ROUTES) has it filed as an update of that task's thread instead: the open
 * thread it names (`thread`), else the open thread whose title reads like its subject (the same
 * similarity duplicate-letter.ts uses for subjects), else a new thread the task opens. The thread
 * shows as answered (news for him; one still waiting on his decision stays in needs). No letter is
 * written and nothing buzzes: thread pushes keep their own rules (push/thread-push.ts).
 *
 * It stays a letter when it is what the inbox is for: a decision or a review (by type), a letter
 * the user asked for (`user_asked`), a pinned standing report, mail items, a credential renewal, a
 * rich html document, a routine run's report (a task a routine made), an Inbox Triage run's. Only
 * a session's send through the route or the replica's relay comes here; Walnut's own letters, the
 * morning report, a plugin's and a host's journal op never do.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import type { OrgThread, ThreadState } from '../org/threads-model.js';
import type { LetterSender, LetterType, NewLetter } from './types.js';

type SendInput = Omit<NewLetter, 'sender'>;

/** Where a letter type goes under the experiment letters_as_threads (letter-threads.ts). */
export interface LettersAsThreadsRoute {
  /** `thread`: filed as an update, as without it; `needs_thread`: a letter that also waits on him as a thread of its task, the one place it shows; `letter`: a letter only. */
  to: 'thread' | 'needs_thread' | 'letter';
  why: string;
}

/**
 * Where each letter type goes when a task that keeps Threads sends it, and under the experiment
 * letters_as_threads. A new type must be listed here (tests/core/human-inbox/letter-to-thread-ratchet.test.ts).
 */
export const LETTER_TYPE_ROUTES: Readonly<Record<LetterType, { to: 'thread' | 'letter'; why: string; lettersAsThreads: LettersAsThreadsRoute }>> = {
  info: {
    to: 'thread', why: 'it only informs: routine progress on a subject, which its thread tracks',
    lettersAsThreads: { to: 'thread', why: 'an update stays an update of its thread, as without the experiment' },
  },
  completion: {
    to: 'thread', why: 'a finished step or result is news on its subject, not a call on him',
    lettersAsThreads: { to: 'thread', why: 'a result stays an update of its thread, as without the experiment' },
  },
  action_required: {
    to: 'letter', why: 'a decision only he can take: its buttons answer it in one tap, and every surface shows it as an ask',
    lettersAsThreads: { to: 'needs_thread', why: 'a decision waits on him as a thread of the task that asks it, with the letter\'s buttons; the letter stays its record and its answer path' },
  },
  review: {
    to: 'letter', why: 'something that must have his review needs him right away',
    lettersAsThreads: { to: 'letter', why: 'it carries no options to answer on a card: he reads a result or a document, which the inbox reader shows whole' },
  },
};

export interface FiledUpdate {
  taskId: string;
  threadId: string;
  title: string;
  /** No open thread matched: the task opened this one for it. */
  created: boolean;
  state: ThreadState;
  /** Longer than a thread's summary holds: the summary was cut. */
  clipped?: true;
  /** The thread the letter named was not one of the task's open threads: filed by its subject instead. */
  ignoredThread?: string;
}

/** Why this letter stays a letter whoever sends it, or null when it may go to a thread. */
export function letterOnlyReason(input: SendInput): string | null {
  const route = LETTER_TYPE_ROUTES[input.type as LetterType];
  if (!route || route.to === 'letter') return 'type';
  if (input.userAsked === true || input.user_asked === true) return 'user_asked';
  if (input.pin === true) return 'pinned';
  if (Array.isArray(input.items) && input.items.length > 0) return 'items';
  if (input.credentialAsk || input.credential_ask) return 'credential';
  if (input.html || input.htmlRef || input.html_ref) return 'document';
  return null;
}

/** Whether this sending task's routine updates go to its threads. */
export function filesUpdatesAsThreads(
  task: Pick<Task, 'org_role' | 'threads_on' | 'routine_start'>,
  isTriage: boolean,
  keeps: (t: Pick<Task, 'org_role' | 'threads_on'>) => boolean,
): boolean {
  // A routine run's letter is the report the routine exists for; a triage run's summarizes mail.
  return keeps(task) && !task.routine_start && !isTriage;
}

/**
 * The open thread an update belongs to: the one it names, else the open thread whose title (or
 * ask) reads most like its subject, at the similarity two letter subjects ask the same thing.
 */
export function threadForUpdate(
  threads: readonly OrgThread[],
  subject: string,
  named: string | undefined,
  similarity: (a: string, b: string) => number,
  min: number,
): OrgThread | null {
  const open = threads.filter((t) => !t.closed && !t.movedTo);
  const hit = named ? open.find((t) => t.id === named) : undefined;
  if (hit) return hit;
  let best: OrgThread | null = null;
  let score = 0;
  for (const t of open) {
    const s = Math.max(similarity(subject, t.title), t.ask ? similarity(subject, t.ask) : 0);
    if (s < min) continue;
    if (s > score || (s === score && best && t.updatedAt > best.updatedAt)) { best = t; score = s; }
  }
  return best;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The update as a thread's summary: its subject, then its words. */
export function updateSummary(input: Pick<SendInput, 'subject' | 'markdown' | 'text'>): string {
  const subject = str(input.subject);
  const body = str(input.markdown) || str(input.text);
  return body && body !== subject ? `**${subject}**\n\n${body}` : subject;
}

/**
 * File `input` as a thread update when its sender keeps Threads; null = send it as a letter. Runs
 * the reply-instead refusal first (letter-ops.ts), so a task answering another task's request
 * hears to answer that task, whichever way its letter would have gone.
 */
export async function fileLetterAsThreadUpdate(input: SendInput, callerSid: string | undefined): Promise<FiledUpdate | null> {
  if (letterOnlyReason(input)) return null;
  const { isFollower } = await import('../server-role.js');
  // Threads live on the leader; a replica sends the letter path as before.
  if (isFollower()) return null;
  const store = await import('./store.js');
  // A letter the store would refuse is refused the same way, never filed half-checked.
  if (!store.checkLetterShape(input as unknown as Record<string, unknown>).ok) return null;
  const { resolveLetterSender, refuseReplyInstead } = await import('./letter-ops.js');
  const sender: LetterSender = await resolveLetterSender(callerSid);
  const taskId = sender.taskId;
  if (!taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([taskId]).catch(() => []);
  const { keepsThreads } = await import('../org/keeps-threads.js');
  const { isTriageLetterSender } = await import('./letter-origin.js');
  if (!task || !filesUpdatesAsThreads(task, isTriageLetterSender(sender), keepsThreads)) return null;
  await refuseReplyInstead(input, sender);
  const subject = str(input.subject);
  const named = str(input.thread) || undefined;
  const tasks = [...(input.taskRefs ?? input.task_refs ?? [])].filter((t): t is string => typeof t === 'string');
  const { oneSendPerNode } = await import('./away-thread.js');
  const threads = await import('../org/threads-store.js');
  const { ThreadError, THREAD_REPLY_MAX } = await import('../org/threads-model.js');
  const { textSimilarity, SIMILAR_SUBJECT_MIN } = await import('./duplicate-letter.js');
  const { resolveThreadCaller } = await import('../org/thread-caller.js');
  // One update at a time per task: two at once with one subject must not open two threads.
  return oneSendPerNode(taskId, async () => {
    const { by, source } = await resolveThreadCaller(sender.sessionId);
    const hit = threadForUpdate((await threads.readThreads(taskId)).threads, subject, named, textSimilarity, SIMILAR_SUBJECT_MIN);
    const ignored = named && hit?.id !== named ? { ignoredThread: named } : {};
    const done = (thread: OrgThread, reply: string): FiledUpdate => {
      log.notif.info('human-inbox: a routine update filed to its thread, not a letter', { taskId, threadId: thread.id, created: !hit, type: input.type, senderSessionId: sender.sessionId });
      return {
        taskId, threadId: thread.id, title: thread.title, created: !hit, state: thread.state, ...ignored,
        ...(reply.length > THREAD_REPLY_MAX ? { clipped: true as const } : {}),
      };
    };
    let opened: OrgThread;
    try {
      if (hit) {
        // A new summary is news: the store shows a thread out of his sight as answered, and one
        // waiting on his decision keeps waiting (threads-model.ts updateThread).
        const reply = updateSummary(input);
        return done(await threads.patchThread(taskId, hit.id, { reply, ...(tasks.length ? { add_tasks: tasks } : {}) }, by, source), reply);
      }
      opened = await threads.openNodeThread(taskId, {
        title: subject, text: str(input.markdown) || str(input.text) || subject, from: 'node', state: 'answered',
        ...(tasks.length ? { tasks } : {}),
      }, by, source);
    } catch (err) {
      // A thread write the store refused (the thread gone under it): the letter goes as before.
      if (!(err instanceof ThreadError)) throw err;
      log.notif.warn('human-inbox: update not filed to a thread, sent as a letter', { taskId, error: err.message });
      return null;
    }
    // The new thread holds the whole update as its first post; its summary is the short line.
    const reply = str(input.text) || subject;
    const summarized = await threads.patchThread(taskId, opened.id, { reply }, by, source).catch((err: unknown) => {
      log.notif.warn('human-inbox: a filed update\'s thread kept no summary', { taskId, threadId: opened.id, error: err instanceof Error ? err.message : String(err) });
      return opened;
    });
    return done(summarized, reply);
  });
}

/**
 * The send route's answer for a filed update. No `id`: there is no letter, and a thread id read as
 * a letter's would only meet a 404 (human_inbox_reply, a mark); the op names the thread instead.
 */
export function filedAnswer(f: FiledUpdate): { threadId: string; filedToThread: FiledUpdate } {
  return { threadId: f.threadId, filedToThread: f };
}
