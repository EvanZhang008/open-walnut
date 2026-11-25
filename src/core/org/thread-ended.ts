/**
 * A thread out of his sight whose work ended closes (2026-11-24, the threads inspection, item 3: on
 * his VP 79 of 92 open threads were pending, 26 of them naming only completed tasks, some for three
 * weeks; every closer needed him or a line, so they never closed, and every check that reads the
 * open threads read them all. The user, 2026-11-23: empty threads close).
 *
 * Walnut's six-hourly sweep (thread-answers.ts) closes a thread that is pending (the node's "nothing
 * new for him"), not watched, snoozed or in Acknowledged while the AI places it, holds nothing (HOLDS:
 * a decision letter, a Board choice, a task's ask), has no reply of his on its way and no word of his
 * the node has not answered (a status line's summary is no answer: review 2026-11-24), when
 *   work   every task it names is complete, the last for ENDED_MS, and none still shows him a
 *          thread of its own (a decision or a result there); or
 *   quiet  it names no task, the node did not open it (a thread it keeps for him to follow), and
 *          nothing was written on it for QUIET_MS.
 *   replaced  (answered or pending) its summary only points at another card, and an open decision
 *          card of the same node names one of its tasks or is named by it: the decision is asked
 *          there, so this one holds nothing (the threads inspection, item 9: Main's old card said
 *          "replaced by the new card, pick there" in Done beside the new card asking it).
 * Closed, it is in his Done for its week like any other, and a word of his on the subject opens a
 * new one. Needs, new and working threads are never closed here, nor an answered one but a pointer:
 * they hold something for him or are the node's move. Pure, but for closeEndedThreads.
 */
import type { Task } from '../types.js';
import { deliveryOpen, isPlainReaction, type OrgThread, type ThreadsFile } from './threads-model.js';
import { changedForHimAt, shownToHim, snoozedNow, watchedNow } from './thread-view.js';
import { inAcknowledged } from './thread-known.js';
import { summaryPointsElsewhere } from './thread-summary-content.js';

/** A task's work counts as ended this long after it completed. */
export const ENDED_MS = 3 * 24 * 3600_000;
/** A thread naming no task counts as ended after this long with nothing written on it. */
export const QUIET_MS = 14 * 24 * 3600_000;

export type EndedTask = Pick<Task, 'id' | 'phase'> & Partial<Pick<Task, 'completed_at' | 'updated_at'>>;
export type EndedWhy = 'work' | 'quiet' | 'replaced';

/**
 * A word of his after the node's last answer on `t`, other than a bare ok or thanks. An answer is
 * one the node gave him (its chat reply on his message, a summary it wrote itself), never a status
 * line's routine summary (`lineReplyAt` equal to `replyAt`), which rewrites the card each turn
 * whatever he asked.
 */
export function hisWordOpen(t: OrgThread): boolean {
  const own = t.replyAt && t.lineReplyAt !== t.replyAt ? t.replyAt : undefined;
  const answered = [own, ...t.messages.map((m) => m.answer?.at)].filter((v): v is string => !!v).sort().pop() ?? '';
  return t.messages.some((m) => m.at > answered && !isPlainReaction(m.text));
}

/**
 * What a thread can hold that keeps it open, one per kind of item a thread holds for him
 * (thread-holds.ts HELD_BY_THREAD; tests/core/org/thread-ended.test.ts fails on a kind missing here).
 */
export const HOLDS: Record<'letter' | 'ask' | 'choice', (t: OrgThread) => boolean> = {
  letter: (t) => !!t.letter || (t.opener?.from === 'letter' && !!t.opener.ref),
  ask: (t) => !!t.reportAsk || !!t.askOwner || !!(t as { heldAsk?: unknown }).heldAsk,
  choice: (t) => !!t.choice,
};

/** The threads of a linked task, to see whether one still shows him something there. */
export type ThreadsOf = (taskId: string) => readonly OrgThread[] | undefined;

/**
 * Something on `t` is still his, so nothing closes it for him: he watches or snoozed it, it is in
 * Acknowledged while the AI places it (its first minutes: the ack settle's), it holds an item
 * (HOLDS), a reply of his is on its way, or a word of his is unanswered. `except`: a hold the caller
 * itself just settled (a replaced card's own letter). Pure.
 */
export function holdsHim(t: OrgThread, now: number = Date.now(), except?: keyof typeof HOLDS): boolean {
  return heldWhy(t, now, except) !== null;
}

/** What on a thread is still his (holdsHim), named: the first that holds, or null. */
export type HeldWhy = 'watch' | 'acknowledged' | keyof typeof HOLDS | 'delivery' | 'word';

/**
 * holdsHim with its reason, for a refusal that must say why (thread-supersede.ts). `except`: one
 * hold, or several reasons, the caller has dealt with itself. Pure.
 */
export function heldWhy(t: OrgThread, now: number = Date.now(), except?: keyof typeof HOLDS | ReadonlySet<HeldWhy>): HeldWhy | null {
  const skip: ReadonlySet<HeldWhy> = except instanceof Set ? except : new Set(except ? [except as HeldWhy] : []);
  if (!skip.has('watch') && (watchedNow(t) || snoozedNow(t, now))) return 'watch';
  if (!skip.has('acknowledged') && inAcknowledged(t)) return 'acknowledged';
  for (const kind of Object.keys(HOLDS) as Array<keyof typeof HOLDS>) if (!skip.has(kind) && HOLDS[kind](t)) return kind;
  if (!skip.has('delivery') && t.messages.some(deliveryOpen)) return 'delivery';
  return !skip.has('word') && hisWordOpen(t) ? 'word' : null;
}

/** Why `t` on node `node` closes now, or null. Pure. */
export function endedWhy(t: OrgThread, node: string, tasks: ReadonlyMap<string, EndedTask>, now: number = Date.now(), threadsOf?: ThreadsOf): EndedWhy | null {
  if (t.closed || t.movedTo || t.state !== 'pending') return null;
  if (holdsHim(t, now)) return null;
  const ids = (t.tasks ?? []).filter((id) => id !== node);
  if (ids.length) {
    for (const id of ids) {
      const task = tasks.get(id);
      // A task not in the store (another box's, a test run's) is not known to have ended.
      if (!task || task.phase !== 'COMPLETE') return null;
      const at = Date.parse(task.completed_at ?? task.updated_at ?? '');
      if (!Number.isFinite(at) || now - at < ENDED_MS) return null;
      // A decision or a result on the task's own Threads is still his to read there.
      if (threadsOf?.(id)?.some((x) => !x.movedTo && shownToHim(x, undefined, now))) return null;
    }
    return 'work';
  }
  if (t.opener) return null;
  const last = Date.parse([t.updatedAt, changedForHimAt(t)].sort().pop()!);
  return Number.isFinite(last) && now - last >= QUIET_MS ? 'quiet' : null;
}

/** An answer on `t` he has not read yet (its message's readAt before it): still his to read there. Pure. */
export function answerUnread(t: Pick<OrgThread, 'messages'>): boolean {
  return t.messages.some((m) => !!m.answer && !(m.readAt && m.readAt >= m.answer.at));
}

/**
 * The open decision card of the same node that replaced `t`, or null (review 2026-11-24: never a
 * result card beside an unrelated decision on the same task). `t` is answered or pending, holds
 * nothing of his (holdsHim, and no answer he has not read), its summary only points elsewhere
 * (summaryPointsElsewhere), and a needs thread other than it is named by that summary (its id or
 * title), or, when `t` itself once waited on him (a decision card), names one of its tasks (the
 * node aside). Pure.
 */
export function replacedBy(t: OrgThread, file: ThreadsFile, now: number = Date.now()): string | null {
  if (t.closed || t.movedTo || (t.state !== 'answered' && t.state !== 'pending')) return null;
  // Its summary only points elsewhere: a node's words, or the line a replaced card was given (supersedes).
  if (!t.reply || !(summaryPointsElsewhere(t.reply) || REPLACED_LINE_RE.test(t.reply.trim())) || holdsHim(t, now) || answerUnread(t)) return null;
  const reply = t.reply;
  const own = new Set((t.tasks ?? []).filter((id) => id !== file.taskId));
  const decided = !!t.needsAt;
  const named = (n: OrgThread) => reply.includes(n.id) || (n.title.trim().length >= TITLE_NAMED_MIN && reply.includes(n.title.trim()));
  const by = file.threads.find((n) => n.id !== t.id && !n.closed && !n.movedTo && n.state === 'needs'
    && (named(n) || (decided && (n.tasks ?? []).some((id) => own.has(id)))));
  return by?.id ?? null;
}

/** The line a replaced card says, in the language the cards are written in (the new card's title). Pure. */
export function replacedLine(now: { id: string; title: string }): string {
  return /[\u4e00-\u9fff]/.test(now.title) ? `\u73b0\u5728\u6539\u5728\u201c${now.title}\u201d\u91cc\u95ee\uff08${now.id}\uff09\u3002` : `Asked now in "${now.title}" (${now.id}).`;
}
/** replacedLine's words, in either language. */
const REPLACED_LINE_RE = /^(?:\u73b0\u5728\u6539\u5728\u201c[\s\S]*\u201d\u91cc\u95ee\uff08th-[\w-]+\uff09\u3002|Asked now in "[\s\S]*" \(th-[\w-]+\)\.)$/;

/** A title this long, found in a summary, names that card (a short one could be any words). */
const TITLE_NAMED_MIN = 8;

/** Why `t` closes now (replaced first, then ended), or null. Pure. */
export function closeWhy(t: OrgThread, file: ThreadsFile, tasks: ReadonlyMap<string, EndedTask>, now: number = Date.now(), threadsOf?: ThreadsOf): EndedWhy | null {
  return replacedBy(t, file, now) ? 'replaced' : endedWhy(t, file.taskId, tasks, now, threadsOf);
}

/** The file with every ended or replaced thread closed by Walnut, and what closed. Pure. */
export function closeEnded(file: ThreadsFile, tasks: ReadonlyMap<string, EndedTask>, now: number = Date.now(), threadsOf?: ThreadsOf): { file: ThreadsFile; closed: Array<{ id: string; why: EndedWhy }> } {
  const at = new Date(now).toISOString();
  const closed: Array<{ id: string; why: EndedWhy }> = [];
  const threads = file.threads.map((t) => {
    const why = closeWhy(t, file, tasks, now, threadsOf);
    if (!why) return t;
    closed.push({ id: t.id, why });
    const { snoozed: _s, options: _o, ...rest } = t;
    return { ...rest, closed: { how: 'dropped' as const, at, by: 'agent' as const } };
  });
  return closed.length ? { file: { ...file, threads }, closed } : { file, closed };
}

/** The sweep: every node's ended and replaced threads closed (thread-answers.ts sweepAll). Returns how many. */
export async function closeEndedThreads(now: number = Date.now()): Promise<number> {
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return 0;
  const store = await import('./threads-store.js');
  const { listTasks } = await import('../task-manager.js');
  const tasks = new Map((await listTasks()).map((t) => [t.id, t] as const));
  let n = 0;
  // The linked tasks' own Threads, read once each for the whole sweep.
  const own = new Map<string, readonly OrgThread[]>();
  for (const node of await store.threadTaskIds()) {
    const file = await store.readThreads(node).catch(() => null);
    if (!file) continue;
    const candidates = file.threads.filter((t) => closeWhy(t, file, tasks, now));
    if (!candidates.length) continue;
    for (const id of new Set(candidates.flatMap((t) => t.tasks ?? []))) {
      if (!own.has(id)) own.set(id, (await store.readThreads(id).catch(() => null))?.threads ?? []);
    }
    const threadsOf: ThreadsOf = (id) => own.get(id);
    const closed = await store.writeThreadsFor(node, (cur) => {
      const r = closeEnded(cur, tasks, now, threadsOf);
      return { file: r.file, out: r.closed, ...(r.closed.length ? { changed: { kind: 'swept' as const } } : {}) };
    });
    if (closed.length) {
      n += closed.length;
      const { log } = await import('../../logging/index.js');
      log.task.info('org threads: ended threads closed', { taskId: node, closed: closed.map((c) => `${c.id}:${c.why}`) });
    }
  }
  return n;
}
