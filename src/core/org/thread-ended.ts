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
 * Closed, it is in his Done for its week like any other, and a word of his on the subject opens a
 * new one. Answered, needs, new and working threads are never closed here: they hold something for
 * him or are the node's move. Pure, but for closeEndedThreads.
 */
import type { Task } from '../types.js';
import { deliveryOpen, isPlainReaction, type OrgThread, type ThreadsFile } from './threads-model.js';
import { changedForHimAt, shownToHim, snoozedNow, watchedNow } from './thread-view.js';
import { inAcknowledged } from './thread-known.js';

/** A task's work counts as ended this long after it completed. */
export const ENDED_MS = 3 * 24 * 3600_000;
/** A thread naming no task counts as ended after this long with nothing written on it. */
export const QUIET_MS = 14 * 24 * 3600_000;

export type EndedTask = Pick<Task, 'id' | 'phase'> & Partial<Pick<Task, 'completed_at' | 'updated_at'>>;
export type EndedWhy = 'work' | 'quiet';

/**
 * A word of his after the node's last answer on `t`, other than a bare ok or thanks. An answer is
 * one the node gave him (its chat reply on his message, a summary it wrote itself), never a status
 * line's routine summary (`lineReplyAt` equal to `replyAt`), which rewrites the card each turn
 * whatever he asked.
 */
function hisWordOpen(t: OrgThread): boolean {
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

/** Why `t` on node `node` closes now, or null. Pure. */
export function endedWhy(t: OrgThread, node: string, tasks: ReadonlyMap<string, EndedTask>, now: number = Date.now(), threadsOf?: ThreadsOf): EndedWhy | null {
  if (t.closed || t.movedTo || t.state !== 'pending') return null;
  // Acknowledged and still being placed (its first minutes): the ack settle's. Placed, it is any other thread.
  if (watchedNow(t) || snoozedNow(t, now) || inAcknowledged(t)) return null;
  if (Object.values(HOLDS).some((holds) => holds(t))) return null;
  if (t.messages.some(deliveryOpen) || hisWordOpen(t)) return null;
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

/** The file with every ended thread closed by Walnut, and what closed. Pure. */
export function closeEnded(file: ThreadsFile, tasks: ReadonlyMap<string, EndedTask>, now: number = Date.now(), threadsOf?: ThreadsOf): { file: ThreadsFile; closed: Array<{ id: string; why: EndedWhy }> } {
  const at = new Date(now).toISOString();
  const closed: Array<{ id: string; why: EndedWhy }> = [];
  const threads = file.threads.map((t) => {
    const why = endedWhy(t, file.taskId, tasks, now, threadsOf);
    if (!why) return t;
    closed.push({ id: t.id, why });
    const { snoozed: _s, options: _o, ...rest } = t;
    return { ...rest, closed: { how: 'dropped' as const, at, by: 'agent' as const } };
  });
  return closed.length ? { file: { ...file, threads }, closed } : { file, closed };
}

/** The sweep: every node's ended threads closed (thread-answers.ts sweepAll). Returns how many. */
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
    const candidates = file.threads.filter((t) => endedWhy(t, node, tasks, now));
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
