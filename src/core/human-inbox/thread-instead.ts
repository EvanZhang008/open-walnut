/**
 * A result about one of the user's Threads goes to that thread, never also to his inbox.
 *
 * 2026-11-04, the user, after a VP sent every thread result as a letter too while he was away (the
 * same news in the thread's summary, the chat reply under it and a letter): "Only choose one, put
 * it in thread or inbox, don't cluster and duplicate everything everywhere, inbox leave for
 * something else ... if it is just a thread just put it there without sending it to inbox".
 *
 * So a letter from Main or a lead (a VP is a lead) about one of its open threads is refused, with
 * the thread named and thread_update as the way, away or not. A letter is about an open thread when
 *  - it names a task of that thread (one it went to, or one the node's chat answer in it named;
 *    Main's and the leads' own tasks aside, the sender's included), or
 *  - it is a report (info, completion, review) naming no such task, and the node put a result in
 *    that thread in the last THREAD_JUST_UPDATED_MS (a new summary, or its chat answer filed there):
 *    it wrote the thread's result and then mailed it. A decision naming no task is not judged by
 *    that clock: it may be about anything, and a thread's tidy-up (title, known, snooze) moves no clock.
 * A decision on a thread is the thread's `needs` state (with its user_kind), not a letter. What has
 * no open thread still goes: a decision only he can make, something to review. Never refused: a
 * worker's letter (reply-instead.ts governs those), a plugin's, a pinned one (a standing report he
 * set up), one carrying mail items, one the user asked for as a letter in his own words
 * (`user_asked`), and a host's journal op (written while the server was away). Walnut's own system
 * letters and the report he schedules (org_report, org/morning-report.ts) are written through the
 * store, not this send, so they never meet this check.
 *
 * Pure decision (`threadInsteadOf`) plus one read of the node's threads; never throws, so a threads
 * file that cannot be read costs nothing but the check.
 */
import type { OrgThread } from '../org/threads-model.js';
import type { LetterSender, LetterType } from './types.js';

const REPORT_TYPES: ReadonlySet<LetterType> = new Set(['info', 'completion', 'review']);

/** A thread the node put a result in this recently is what a task-less report right after it is about. */
export const THREAD_JUST_UPDATED_MS = 10 * 60_000;

export interface ThreadHit {
  threadId: string;
  title: string;
  state: string;
  /** Why the letter is about it: a task they share, or the node just wrote the thread. */
  why: 'task' | 'just_updated';
  taskId?: string;
}

/** Both spellings stay as written (a full id or a unique prefix), so a prefix of 6+ characters matches. */
const MIN_PREFIX = 6;
function sameTask(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

/** The tasks a thread is about: the ones it went to, and the ones the node's chat answers in it named. */
export function threadTaskIds(t: OrgThread): string[] {
  return [...new Set([...(t.tasks ?? []), ...t.messages.flatMap((m) => m.answer?.about ?? [])])];
}

/** When the node last put a result in the thread: a new summary of its own, or its chat answer Walnut filed there. */
function lastResultAt(t: OrgThread, nodeTaskId: string): number {
  let last = t.replied && (t.replied.by === `task:${nodeTaskId}` || t.replied.by === 'agent') ? Date.parse(t.replied.at) : NaN;
  for (const m of t.messages) {
    const at = m.answer ? Date.parse(m.answer.at) : NaN;
    if (Number.isFinite(at) && !(at <= last)) last = at;
  }
  return last;
}

/**
 * The open thread this letter belongs to, or null. `isNode` says which ids are Main's or a lead's own
 * tasks: a VP a thread was handed to stands for all its work, so naming it ties no letter to that
 * thread (Main's letters about a VP's other work still go).
 */
export function threadInsteadOf(
  input: { nodeTaskId: string; type: LetterType; taskRefs: readonly string[] },
  threads: readonly OrgThread[],
  nowMs: number,
  isNode: (taskId: string) => boolean = () => false,
): ThreadHit | null {
  const open = threads.filter((t) => !t.closed);
  if (!open.length) return null;
  const refs = [...new Set(input.taskRefs.map((r) => r.trim()).filter((r) => r && !sameTask(r, input.nodeTaskId) && !isNode(r)))];
  if (refs.length) {
    for (const ref of refs) {
      const t = open.find((x) => threadTaskIds(x).some((id) => !isNode(id) && sameTask(id, ref)));
      if (t) return { threadId: t.id, title: t.title, state: t.state, why: 'task', taskId: ref };
    }
    return null;
  }
  if (!REPORT_TYPES.has(input.type)) return null;
  const recent = open
    .map((t) => ({ t, at: lastResultAt(t, input.nodeTaskId) }))
    .filter(({ at }) => Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= THREAD_JUST_UPDATED_MS)
    .sort((a, b) => b.at - a.at);
  const t = recent[0]?.t;
  return t ? { threadId: t.id, title: t.title, state: t.state, why: 'just_updated' } : null;
}

/** The words of the refusal: which thread, and what to do instead. */
export function threadInsteadMessage(hit: ThreadHit): string {
  const why = hit.why === 'task'
    ? `it names ${hit.taskId}, a task of the user's open thread ${hit.threadId} "${hit.title}" (${hit.state})`
    : `it is a report naming no task, and you just put a result in the user's open thread ${hit.threadId} "${hit.title}" (${hit.state})`;
  return `Not sent: ${why}. One place per update: a result, answer or update about a thread goes to that thread only, `
    + `never also a letter, whether he is in your chat or away. Write it there with thread_update {"id":"${hit.threadId}",`
    + '"reply":"<the summary, proof by path>"} (a decision he must make: state "needs" with user_kind and user_kind_why); '
    + 'Walnut files your chat reply under his message by itself. Letter him only for what has no open thread; if this letter '
    + 'is about other work, name that work\'s tasks in task_refs. user_asked:true only when he asked in his own words for this '
    + 'as a letter in his inbox.';
}

/** The open thread of the sending node this letter belongs to, read from its threads. Null when none (or on any error). */
export async function findThreadInstead(
  input: { type: LetterType; taskRefs?: readonly string[]; pinned?: boolean; items?: boolean },
  sender: LetterSender,
  nowMs = Date.now(),
): Promise<ThreadHit | null> {
  if (!sender.taskId || sender.pluginId || input.pinned || input.items) return null;
  try {
    const { listTasksByIds } = await import('../task-manager.js');
    const [task] = await listTasksByIds([sender.taskId]).catch(() => []);
    if (!task || (task.org_role !== 'main' && task.org_role !== 'lead')) return null;
    const { readThreads } = await import('../org/threads-store.js');
    const file = await readThreads(task.id);
    const open = file.threads.filter((t) => !t.closed);
    if (!open.length) return null;
    // Which of the named tasks are Main's or a lead's own (see threadInsteadOf).
    const ids = [...new Set([...(input.taskRefs ?? []), ...open.flatMap(threadTaskIds)])];
    const nodes = new Set((await listTasksByIds(ids).catch(() => []))
      .filter((t) => t.org_role === 'main' || t.org_role === 'lead').map((t) => t.id));
    return threadInsteadOf({ nodeTaskId: task.id, type: input.type, taskRefs: input.taskRefs ?? [] }, open, nowMs, (id) => nodes.has(id));
  } catch {
    return null;
  }
}
