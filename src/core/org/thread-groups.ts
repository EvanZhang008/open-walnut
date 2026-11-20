/**
 * The state groups of a node's Threads (experiment brief_off, org/brief-off.ts): his Threads by
 * state take the Brief's place, and a Board card's status reads its task's threads the same way.
 * One rule for the server (GET /api/v1/thread-states) and the web (@open-walnut/thread-groups). Pure.
 */
import { listedForHim, orderedForHim, snoozedNow, type ViewThread } from './thread-view.js';
import { USER_STATE_LABELS } from '../user-status.js';

/**
 * The state group a thread is drawn in once the Brief is off (experiment brief_off): his Threads
 * by state take the Brief's place, and a Board card's status reads its task's threads the same way.
 *   needs    waits on him (a decision, his pick); a thread of a task below listed above it
 *   read     answered, with words he has not read (listed for him)
 *   working  the node's move (new, working)
 *   waiting  pending, asked in a task, snoozed, or answered and already read
 *   done     closed (acknowledged, dropped, moved on)
 * `listed`: his view lists it now (listedForHim). Pure.
 */
export type ThreadGroup = 'needs' | 'read' | 'working' | 'waiting' | 'done';
export const THREAD_GROUPS: readonly ThreadGroup[] = ['needs', 'read', 'working', 'waiting', 'done'];
/** The state names a person reads everywhere (USER_STATE_LABELS); Done is a thread's own word for one he closed. */
export const THREAD_GROUP_LABELS: Record<ThreadGroup, string> = {
  needs: USER_STATE_LABELS.needs, read: USER_STATE_LABELS.read, working: USER_STATE_LABELS.working,
  waiting: USER_STATE_LABELS.waiting, done: 'Done',
};

export function threadGroupOf(t: ViewThread & { state: string }, listed: boolean, now: number = Date.now()): ThreadGroup {
  if (t.closed) return 'done';
  if (t.owner) return listed ? 'needs' : 'waiting';
  if (snoozedNow(t, now)) return 'waiting';
  // Its decision is asked in a task: he answers it there, so it waits here (thread-task-ask.ts).
  if (t.askedIn && !t.askedIn.answered) return 'waiting';
  if (t.state === 'needs') return 'needs';
  if (t.state === 'answered') return listed ? 'read' : 'waiting';
  if (t.state === 'pending') return 'waiting';
  return 'working';
}

/** Every thread in its group, each group in his Threads' order (pinned first, newest change first). Pure. */
export function groupThreads<T extends ViewThread & { id: string; state: string; updatedAt: string }>(threads: readonly T[], now: number = Date.now()): Record<ThreadGroup, T[]> {
  const listed = new Set(listedForHim(threads, now));
  const out: Record<ThreadGroup, T[]> = { needs: [], read: [], working: [], waiting: [], done: [] };
  for (const t of orderedForHim(threads)) out[threadGroupOf(t, listed.has(t), now)].push(t);
  return out;
}

/** What a task's own threads say: the group and its newest thread (a Board card's chip reads it). */
export interface TaskThreadState { state: ThreadGroup; id: string; title: string }

/**
 * The state a task's own open threads give it, the first group that holds one (needs > read >
 * working > waiting), with that group's newest thread; null with none open. A pointer a moved thread
 * left behind is the other node's, never this one's. Pure.
 */
export function threadStateOf<T extends ViewThread & { id: string; state: string; updatedAt: string; title: string; movedTo?: unknown }>(threads: readonly T[], now: number = Date.now()): TaskThreadState | null {
  const groups = groupThreads(threads.filter((t) => !t.movedTo && !t.owner), now);
  // Only open threads say where the task stands: a closed one is history, never its status now.
  for (const g of THREAD_GROUPS.filter((x) => x !== 'done')) {
    const t = groups[g][0];
    if (t) return { state: g, id: t.id, title: t.title };
  }
  return null;
}
