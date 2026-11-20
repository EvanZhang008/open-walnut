/**
 * The inbox as the threads that need him (experiment `inbox_needs_threads`; 2026-11-20, the user's
 * "Only Threads" design: the inbox is every thread that needs him, the most urgent first, and the
 * phone rings only for those).
 * Pure and browser-safe: the server's list (needs-threads.ts), the web's inbox and its counts read
 * these same functions, so the order and the numbers agree everywhere.
 *
 * Which thread needs him (needsHim): one of a node's own threads his Threads view lists, waiting on
 * him (state needs), whose decision is not asked in a task already (`askedIn`: its card points
 * there) and that is not the task's own ask placed on it (`heldAsk`: that task's status counts it,
 * as thread-view.ts threadCounts leaves it out of `needs`).
 *
 * How urgent (needsUrgency), most urgent first:
 *   1. pinned: he (or the node) pinned the thread, or he pinned the decision letter it holds;
 *   2. due: its node or a task it names is due within DUE_SOON_MS (or already overdue), or is
 *      marked priority `immediate`;
 *   3. waiting: everything else.
 * Inside a rank the one that has waited on him longest comes first (it has held its work up
 * longest); the thread id breaks a tie, so the order never flickers between two reads.
 */
import { listedForHim, pinnedNow, type ViewThread } from '../org/thread-view.js';

/** A task due this soon (or overdue) makes what waits on him for it urgent. */
export const DUE_SOON_MS = 24 * 3600_000;

export type NeedsUrgencyWhy = 'pinned' | 'due' | 'immediate' | 'waiting';

export interface NeedsUrgency {
  /** 0 most urgent: 0 pinned, 1 due or immediate, 2 the rest. */
  rank: 0 | 1 | 2;
  why: NeedsUrgencyWhy;
  /** Since when it has waited on him (ISO): the order inside a rank, oldest first. */
  since: string;
  /** The due date that made it urgent (ISO), for the card's line. */
  due?: string;
}

/** What urgency reads of a thread (the server's OrgThread or the web's copy). */
export interface UrgencyThread {
  id: string;
  updatedAt: string;
  createdAt?: string;
  tasks?: readonly string[];
  pinned?: { at: string; by?: string };
  closed?: { by: string };
  opener?: { at: string; from?: string };
  letter?: { id: string; done?: true; off?: true };
}

/** What urgency reads of a task (its node, or one the thread names). */
export interface UrgencyTask { id: string; due_date?: string; priority?: string; phase?: string; status?: string }

/** A thread his view lists that waits on him for his answer, as the inbox lists it. */
export function needsHim<T extends ViewThread & { id: string; state: string; askedIn?: unknown; heldAsk?: unknown; owner?: unknown }>(t: T, listed: ReadonlySet<T>): boolean {
  return listed.has(t) && !t.owner && t.state === 'needs' && !t.askedIn && !t.heldAsk;
}

/** One node's threads that need him, in the file's order. Pure. */
export function needsThreadsOf<T extends ViewThread & { id: string; state: string; askedIn?: unknown; heldAsk?: unknown; owner?: unknown }>(threads: readonly T[], now: number = Date.now()): T[] {
  const own = threads.filter((t) => !t.owner);
  const listed = new Set(listedForHim(own, now));
  return own.filter((t) => needsHim(t, listed));
}

const open = (t: UrgencyTask): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';

/**
 * How urgent one thread that needs him is (see the header). `node`: the task that holds it;
 * `tasks`: the tasks it may name (any list holding them); `letterPinned`: he pinned the decision
 * letter it holds. Pure.
 */
export function needsUrgency(
  t: UrgencyThread,
  ctx: { node?: UrgencyTask; tasks?: readonly UrgencyTask[]; letterPinned?: boolean; now?: number },
): NeedsUrgency {
  const now = ctx.now ?? Date.now();
  // A letter's thread waited from the letter's own time; any other from its first post, else its last change.
  const since = t.opener?.at || t.createdAt || t.updatedAt;
  if (pinnedNow(t) || ctx.letterPinned) return { rank: 0, why: 'pinned', since };
  const named = new Set(t.tasks ?? []);
  const mine = [...(ctx.node ? [ctx.node] : []), ...(ctx.tasks ?? []).filter((x) => named.has(x.id) && x.id !== ctx.node?.id)].filter(open);
  let due = Infinity;
  for (const x of mine) {
    const at = Date.parse(x.due_date ?? '');
    if (Number.isFinite(at) && at - now <= DUE_SOON_MS && at < due) due = at;
  }
  if (Number.isFinite(due)) return { rank: 1, why: 'due', since, due: new Date(due).toISOString() };
  if (mine.some((x) => x.priority === 'immediate')) return { rank: 1, why: 'immediate', since };
  return { rank: 2, why: 'waiting', since };
}

/** The inbox order: the more urgent rank first, then the one that waited longest, then by id. */
export function byUrgency(a: { id: string; urgency: NeedsUrgency }, b: { id: string; urgency: NeedsUrgency }): number {
  return a.urgency.rank - b.urgency.rank
    || a.urgency.since.localeCompare(b.urgency.since)
    || a.id.localeCompare(b.id);
}

/** The letter a needs thread still stands for (letter-thread-model.ts liveLetter), or undefined. */
export function heldLetterOf(t: Pick<UrgencyThread, 'letter'>): string | undefined {
  return t.letter && !t.letter.done && !t.letter.off ? t.letter.id : undefined;
}

/**
 * What the inbox counts with the experiment on: every thread that needs him, plus every unread
 * letter in the inbox (not archived) that no such thread already holds. A decision letter waiting on
 * its thread is one thing, counted once, as the thread. Pure.
 */
export function inboxNeedsCount(
  threads: readonly Pick<UrgencyThread, 'letter'>[],
  letters: readonly { id: string; read: boolean; archived?: boolean }[],
): { threads: number; letters: number; total: number } {
  const held = new Set(threads.map(heldLetterOf).filter((id): id is string => !!id));
  const unread = letters.filter((l) => !l.read && !l.archived && !held.has(l.id)).length;
  return { threads: threads.length, letters: unread, total: threads.length + unread };
}
