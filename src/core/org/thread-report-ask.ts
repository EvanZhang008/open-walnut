/**
 * A task's own ask lives on its thread (2026-11-20, the user, on a task that keeps Threads: its one
 * thread read "Done" in the Threads pane while the chat above held the task's ask card waiting for
 * his answer, "the same thing shows twice, one says Done and the other waits for him"). For a task
 * the status question asks about its threads (status-threads.ts asksThreads), what the task asks
 * him IS that thread's needs state: one card, one decision.
 *
 * The place is stored, the state is read. When a report asks him something (a real FOR_USER_ASK,
 * with its decision id), Walnut puts that decision on one open thread (`reportAsk` on it): the one
 * the status answer names (FOR_USER_ASK_THREAD), else the thread his newest message was filed to,
 * else the only open thread, else none (the ask stays a plain ask, as before). On every read
 * (threads-store.ts withTaskAsks) that thread reads `needs`, with `askId` = the decision id, its
 * summary leading with the question, and `heldAsk` beside it, while the task's own Action needed
 * item still asks that decision; the moment it asks no more (his answer, a newer report, a snooze,
 * another decision) the thread reads its stored state again, which its FOR_USER_THREAD lines kept
 * current meanwhile. Nothing is stored as needs, so no phone buzz of its own (the task's ask has
 * its own), no overdue clock of its own (thread-view.ts threadOverdue), and its `needs` count
 * leaves it out (thread-view.ts threadCounts): the task's status already counts it once.
 *
 * Data an older build wrote: a task whose current report asks and whose threads hold no place for
 * that decision gets one at its next status derive (keepAskOnThread, user-status-sync.ts), once. A
 * report that asks nothing any more takes the places off (here at its answer, or at that derive).
 */
import type { AskOption, StatusReport, UserStatus } from '../user-status.js';
import type { Task } from '../types.js';
import { openNotWaiting, snoozedNow, type ThreadHeldAsk } from './thread-view.js';
import type { OrgThread, ThreadsFile } from './threads-model.js';
import { reportDecision } from '../ask-decision.js';
import { ownItemOf } from '../action-needed.js';
import { asksThreads } from '../sessions/status-threads.js';

/** The question kept on the place, for the record. */
const ASK_KEPT_MAX = 400;

export interface TaskAsk { id: string; ask: string; options?: AskOption[] }

type AskingTask = Pick<Task, 'id' | 'phase' | 'status' | 'user_status' | 'org_role' | 'threads_on'> & Partial<Pick<Task, 'status_report'>>;

/**
 * The ask the task shows him now, as its Action needed item (action-needed.ts): its id (the
 * decision id) and words; null when it asks nothing of its own, or the ask sleeps (snoozed), went
 * to another task asking the same (sameAsk) or was answered for him. Pure.
 */
export function taskAskNow(t: Pick<Task, 'phase' | 'status' | 'user_status'> | null | undefined): TaskAsk | null {
  if (!t || t.phase === 'COMPLETE' || t.status === 'done') return null;
  const s: UserStatus | undefined = t.user_status ?? undefined;
  if (!s || s.sameAsk || s.answeredFor || s.snoozed) return null;
  const item = (s.actions ?? []).find((i) => i.kind === 'ask') ?? (s.state === 'needs' && s.source === 'session' ? ownItemOf(s) : null);
  if (!item || item.snoozedUntil) return null;
  // Its choices are the thread's (ask-options.ts: one shape wherever a choice is shown).
  const options = item.options ?? item.form?.options;
  return { id: item.id, ask: item.summary, ...(options?.length ? { options } : {}) };
}

/** The decision a stored report asks him: its id and words; null for none, or one another task holds. Pure. */
export function reportAskOf(r: StatusReport | null | undefined): TaskAsk | null {
  const d = reportDecision(r);
  if (!d || !r?.ask?.trim() || r.same_as || r.decision_owner || r.kindless_ask) return null;
  return { id: d.id, ask: r.ask.trim() };
}

/**
 * The thread an ask goes on, or null: the one named (if it can take it), else the open thread his
 * newest message was filed to, else the only open thread. Pure.
 */
export function askThreadFor(threads: readonly OrgThread[], named?: string): string | null {
  const open = threads.filter(openNotWaiting);
  if (named && open.some((t) => t.id === named)) return named;
  let newest: { id: string; at: string } | null = null;
  for (const t of threads) {
    if (t.movedTo) continue;
    for (const m of t.messages) if (!newest || m.at > newest.at) newest = { id: t.id, at: m.at };
  }
  if (newest && open.some((t) => t.id === newest!.id)) return newest.id;
  return open.length === 1 ? open[0].id : null;
}

/**
 * The file with `ask` placed on its thread: once per decision (a thread that already holds it keeps
 * it, unless the task now names another), and one decision per task (an older one's place goes).
 * `ask` null: the report asks nothing now, so every place goes (asked again later, it is placed
 * again by the rule). The same file when nothing changes. The place moves no clock: nothing he
 * reads changed yet. Pure.
 */
export function placeAsk(file: ThreadsFile, ask: TaskAsk | null, at: string, named?: string): ThreadsFile {
  const held = ask ? file.threads.find((t) => t.reportAsk?.id === ask.id) : undefined;
  const namedOk = !!ask && !!named && file.threads.some((t) => t.id === named && openNotWaiting(t));
  const target = !ask ? null : namedOk ? named! : held ? held.id : askThreadFor(file.threads);
  const stale = file.threads.some((t) => t.reportAsk && t.reportAsk.id !== ask?.id);
  if (!stale && (!target || held?.id === target)) return file;
  if (!ask) return { ...file, threads: file.threads.map(withoutPlace) };
  const words = ask.ask.replace(/\s+/g, ' ').trim().slice(0, ASK_KEPT_MAX);
  return {
    ...file,
    threads: file.threads.map((t) => {
      if (t.id === target) return held?.id === target ? t : { ...t, reportAsk: { id: ask.id, at, ...(words ? { ask: words } : {}) } };
      // A thread that holds it and cannot be moved from (no other one takes it) keeps it.
      if (!target && t.reportAsk?.id === ask.id) return t;
      return withoutPlace(t);
    }),
  };
}

function withoutPlace(t: OrgThread): OrgThread {
  if (!t.reportAsk) return t;
  const { reportAsk: _gone, ...rest } = t;
  return rest as OrgThread;
}

/**
 * The threads as he reads them: the one holding the task's ask now reads needs, with that ask's id,
 * its summary leading with the question, and `heldAsk`; every other thread as stored. Pure.
 */
export function withHeldAsk<T extends OrgThread>(task: AskingTask | null | undefined, threads: readonly T[]): Array<T & { heldAsk?: ThreadHeldAsk }> {
  const ask = asksThreads(task) ? taskAskNow(task) : null;
  if (!ask) return [...threads];
  return threads.map((t) => {
    // Put aside by him (its Snoozed section), it reads as stored: the task's own ask still shows where it lives.
    if (!openNotWaiting(t) || t.reportAsk?.id !== ask.id || snoozedNow(t)) return t;
    const reply = t.reply?.trim() ? t.reply : undefined;
    const heldAsk: ThreadHeldAsk = { id: ask.id, ask: ask.ask, ...(reply ? { reply } : {}), was: t.state };
    return { ...t, state: 'needs' as const, askId: ask.id, reply: reply ? `${ask.ask}\n\n${reply}` : ask.ask, heldAsk, ...(ask.options ? { options: ask.options } : {}) };
  });
}

/**
 * Today's data brought in line (at boot, and when its status is next derived): a task whose shown
 * ask is its current report's, and whose threads hold no place for it, gets the place by the same
 * rule, once per decision; a task whose report asks nothing any more loses its places. Idempotent.
 * Never throws; true when it wrote.
 */
export async function keepAskOnThread(task: AskingTask, threads?: readonly OrgThread[]): Promise<boolean> {
  if (!asksThreads(task)) return false;
  const now = taskAskNow(task);
  const reported = reportAskOf(task.status_report);
  // A status a step behind its report never places an older decision; none at all clears the places.
  const ask = !reported ? null : now?.id === reported.id ? now : undefined;
  if (ask === undefined) return false;
  try {
    const store = await import('./threads-store.js');
    const list = threads ?? (await store.readThreads(task.id)).threads;
    if (ask ? list.some((t) => t.reportAsk?.id === ask.id) || !askThreadFor(list) : !list.some((t) => t.reportAsk)) return false;
    return await store.placeTaskAsk(task.id, ask);
  } catch {
    return false;
  }
}
