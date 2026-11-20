/**
 * The groups of a node's Threads (experiment brief_off, org/brief-off.ts): his Threads by group
 * take the Brief's place, and a Board card's status reads its task's threads the same way. One rule
 * for the server (GET /api/v1/thread-states), the web (@open-walnut/thread-groups) and the phone's
 * port (ios-native OrgThreadModel). Pure.
 */
import { listedForHim, orderedForHim, snoozedNow, type ViewThread } from './thread-view.js';
import { USER_STATE_LABELS } from '../user-status.js';
import { isKnown } from './thread-known.js';

// The web reads a thread he acknowledged at work (isKnown) through this module (@open-walnut/thread-groups), the one it groups by.
export { backFromKnown, isKnown, type AckWaits } from './thread-known.js';

/**
 * The group a thread is drawn in, in his own words (2026-11-20, the user: "No Need you, Done,
 * waiting / snoozed, Acknowlegde, closed, archived", then of Acknowledge: "if I ack and ai should
 * determine if it should go to closed or wait or wip"). Every thread is in exactly one:
 *   needs     Needs you: a question or a decision for him, a thread of a task below included (one
 *             listed above only because his reply is on its way there reads by its state)
 *   read      Done: the agent finished and the result waits on the card for him (listed for him)
 *   working   Working: the node's move (new, working), or work on it still runs since his Acknowledge
 *   waiting   Waiting / Snoozed: on someone or something or a time (pending, asked in a task, a
 *             result he already read, or held since his Acknowledge), or he snoozed it
 *   done      Closed: really over (acknowledged, dropped, moved on)
 *   archived  Archived: closed ARCHIVE_AFTER_MS ago or more, shown only on its own chip
 * Acknowledge is an action, not a group: the card goes where thread-ack-outcome.ts ackOutcome says
 * (closed, working or waiting), and one acknowledged before is drawn where the read projects it
 * (`ackGroup`, thread-ack.ts withAwaits; until its follow pass closes it, waiting). The ids are the
 * wire's (GET /api/v1/thread-states, kept view choices), so older clients read them;
 * THREAD_GROUP_LABELS are the words he reads. `listed`: his view lists it now (listedForHim). Pure.
 */
export type ThreadGroup = 'needs' | 'read' | 'working' | 'waiting' | 'done' | 'archived';
export const THREAD_GROUPS: readonly ThreadGroup[] = ['needs', 'read', 'working', 'waiting', 'done', 'archived'];
export const THREAD_GROUP_LABELS: Record<ThreadGroup, string> = {
  needs: USER_STATE_LABELS.needs, read: 'Done', working: USER_STATE_LABELS.working, waiting: 'Waiting / Snoozed', done: 'Closed', archived: 'Archived',
};
/** The groups All shows: Archived only when its own chip is picked. */
export const ALL_SHOWS: readonly ThreadGroup[] = THREAD_GROUPS.filter((g) => g !== 'archived');

/**
 * A closed thread is Archived a day after it closed (the server deletes it a week after,
 * threads-model.ts CLOSED_KEEP_MS): Closed keeps what he closed today at hand.
 */
export const ARCHIVE_AFTER_MS = 24 * 3600_000;

/** Closed ARCHIVE_AFTER_MS ago or more. Pure. */
export function archivedNow(t: { closed?: { at?: string } }, now: number): boolean {
  const at = t.closed?.at ? Date.parse(t.closed.at) : NaN;
  return Number.isFinite(at) && now - at >= ARCHIVE_AFTER_MS;
}

/** A thread as the groups read it: `ackGroup` is the read's projection on one he acknowledged at work. */
export type GroupedThread = ViewThread & { state: string; closed?: { at?: string }; ackGroup?: string };

export function threadGroupOf(t: GroupedThread, listed: boolean, now: number = Date.now()): ThreadGroup {
  if (archivedNow(t, now)) return 'archived';
  if (t.closed) return 'done';
  // A thread of a task below is listed while it waits on him or while his reply is on its way
  // there: only the first is his to answer; the second is the task's move (2026-11-20, the user:
  // a card he had replied on stayed in Needs you).
  if (t.owner && !listed) return 'waiting';
  if (snoozedNow(t, now)) return 'waiting';
  // Its decision is asked in a task: he answers it there, so it waits here (thread-task-ask.ts).
  if (t.askedIn && !t.askedIn.answered) return 'waiting';
  if (t.state === 'needs') return 'needs';
  if (t.state === 'answered') return listed ? 'read' : 'waiting';
  if (isKnown(t)) return t.ackGroup === 'working' ? 'working' : 'waiting';
  if (t.state === 'pending') return 'waiting';
  return 'working';
}

/** Every thread in its group, each group in his Threads' order (pinned first, newest change first). Pure. */
export function groupThreads<T extends GroupedThread & { id: string; updatedAt: string }>(threads: readonly T[], now: number = Date.now()): Record<ThreadGroup, T[]> {
  const listed = new Set(listedForHim(threads, now));
  const out: Record<ThreadGroup, T[]> = { needs: [], read: [], working: [], waiting: [], done: [], archived: [] };
  for (const t of orderedForHim(threads)) out[threadGroupOf(t, listed.has(t), now)].push(t);
  return out;
}

/** What a task's own threads say: the group and its newest thread (a Board card's chip reads it). */
export interface TaskThreadState { state: 'needs' | 'read' | 'working' | 'waiting'; id: string; title: string }

/**
 * The state a task's own open threads give it, the first group that holds one (needs > read >
 * working > waiting), with that group's newest thread; null with none open. A pointer a moved
 * thread left behind is the other node's, never this one's. Pure.
 */
export function threadStateOf<T extends GroupedThread & { id: string; updatedAt: string; title: string; movedTo?: unknown }>(threads: readonly T[], now: number = Date.now()): TaskThreadState | null {
  const groups = groupThreads(threads.filter((t) => !t.movedTo && !t.owner), now);
  // Only open threads say where the task stands: a closed one is history, never its status now.
  for (const g of ['needs', 'read', 'working', 'waiting'] as const) {
    const t = groups[g][0];
    if (t) return { state: g, id: t.id, title: t.title };
  }
  return null;
}
