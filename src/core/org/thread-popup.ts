/**
 * A task's thread pops up (experiment `threads_pop_up`; 2026-11-20, the user: "the thread can pop
 * up like the leader's thread can go up ... if we reply I think it should go directly to that
 * thread"). A thread is stored once, on the Threads of the task doing the work (its owner). The
 * leaders above it, its VP and Main read it as a VIEW: while it waits on him (needs), or while his
 * reply on it is still on its way, it is listed after their own threads, the same record with the
 * same id, carrying `owner` and `can_answer_now`; once it is neither it leaves every list above at
 * once. A result of it for him is listed only on a node whose own thread names that task on that
 * subject (`carries`, thread-subject-pairs.ts; carriedRows), in that thread's place, never on every
 * level: two nodes that both name it there (its VP and Main) both list the same record, and his
 * Acknowledge on either closes it for both. His reply on it at any level is written into that one
 * record and goes to the owner's session (thread-reply.ts).
 *
 * Who sees a task's thread (viewersOf): every task above it in its parent chain, and the Org
 * nodes it reports up through (thread-follow.ts orgNodesAbove: its lead, that lead's VP, Main).
 * Only the owner reads Needs you for it: a viewer counts it in `shown` and `below`, never in
 * `needs` (thread-view.ts threadCounts; user-status.ts taskThreadNeeds reads `needs`).
 *
 * An older phone that does not know `owner` lists such a thread as one of the node's own: its
 * Follow up (through the node's chat) and its snooze reach the owner's record all the same
 * (thread-capture.ts, the PATCH route), so its list, its count and its buttons agree.
 */
import type { SessionRecord, Task } from '../types.js';
import { keepsThreads } from './keeps-threads.js';
import { orgNodesAbove, orgPlaces, type OrgPlaces } from './thread-follow.js';
import { orgDisplayTitle } from './org-tree.js';
import { deliveryOpen, movedAway, type OrgThread } from './threads-model.js';
import { listedAbove, sharedAnswers } from './thread-view.js';

export { setThreadsPopUp, stampAskIds, threadsPopUpNow, threadsPopUpOn } from './thread-popup-rules.js';

/** A thread as a node above its owner reads it. */
export type PoppedThread = OrgThread & {
  owner: { task_id: string; title: string };
  /** A result of its owner on the subject of the listing node's own thread of this id (thread-subject-pairs.ts). */
  carries?: string;
  /** Its owner can take his reply now (a session, its host reachable); else it is kept and sent when it is back. */
  can_answer_now?: boolean;
  /** The decision it asks him (OrgThread.askId): a reply names it, so a reply to an older ask is marked. */
  ask_id?: string;
};

export const openTask = (t: Pick<Task, 'phase' | 'status'>): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';

/** The tasks that read `owner`'s threads above it. Pure. */
export function viewersOf(owner: Task, byId: ReadonlyMap<string, Task>, places: OrgPlaces | null): Set<string> {
  const out = new Set<string>();
  const seen = new Set([owner.id]);
  for (let id = owner.parent_task_id; id && !seen.has(id) && byId.has(id); id = byId.get(id)!.parent_task_id) {
    seen.add(id);
    out.add(id);
  }
  if (places) for (const n of orgNodesAbove(owner, places)) out.add(n);
  out.delete(owner.id);
  return out;
}

/** The open tasks that keep Threads and whose threads `viewerId` reads; `among`: only these ids (the ones holding threads). Pure. */
export function ownersBelow(viewerId: string, all: readonly Task[], places: OrgPlaces | null, among?: ReadonlySet<string>): Task[] {
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const pool = among ? [...among].map((id) => byId.get(id)).filter((t): t is Task => !!t) : all;
  return pool.filter((t) => t.id !== viewerId && keepsThreads(t) && openTask(t) && viewersOf(t, byId, places).has(viewerId));
}

/**
 * The open tasks that keep Threads around `taskId`: those that read its threads (viewersOf, nearest
 * first), then those whose threads it reads (ownersBelow). The tree a merge_into reaches
 * (thread-tree-merge.ts); `among`: only these ids (the ones holding threads).
 */
export async function threadTreeOf(taskId: string, among?: ReadonlySet<string>): Promise<Task[]> {
  const c = await context();
  const self = c.byId.get(taskId);
  if (!self) return [];
  const above = [...viewersOf(self, c.byId, c.places)].map((id) => c.byId.get(id))
    .filter((t): t is Task => !!t && (!among || among.has(t.id)) && keepsThreads(t) && openTask(t));
  const seen = new Set(above.map((t) => t.id));
  return [...above, ...ownersBelow(taskId, c.all, c.places, among).filter((t) => !seen.has(t.id))];
}

async function context(all?: readonly Task[]): Promise<{ all: readonly Task[]; byId: Map<string, Task>; places: OrgPlaces | null }> {
  const tasks = all ?? await (await import('./org-store.js')).orgTasks();
  const { isOrgEnabled } = await import('./org-enabled.js');
  return { all: tasks, byId: new Map(tasks.map((t) => [t.id, t] as const)), places: (await isOrgEnabled()) ? orgPlaces(tasks) : null };
}

/** The tasks that read `ownerId`'s threads above it (a change of them changes their lists and counts). */
export async function viewerIdsOf(ownerId: string, all?: readonly Task[]): Promise<string[]> {
  const c = await context(all);
  const owner = c.byId.get(ownerId);
  return owner ? [...viewersOf(owner, c.byId, c.places)] : [];
}

export interface PoppedIndex {
  /** Viewer id → the threads of tasks below it, newest change first. */
  byViewer: Map<string, PoppedThread[]>;
  /** Every owner read (a change of one of them changes its viewers). */
  owners: string[];
}

/**
 * One read of every task that holds threads (each owner's file once, however many viewers): the
 * threads listed above each viewer. `onlyViewer`: the owners below that one alone are read.
 * `answerable`: each says whether its owner takes a reply now (one session read per owner listed).
 */
export async function poppedIndex(opts: { all?: readonly Task[]; onlyViewer?: string; answerable?: boolean; now?: number } = {}): Promise<PoppedIndex> {
  const c = await context(opts.all);
  const store = await import('./threads-store.js');
  const held = new Set(await store.threadTaskIds());
  const owners = opts.onlyViewer
    ? ownersBelow(opts.onlyViewer, c.all, c.places, held)
    : [...held].map((id) => c.byId.get(id)).filter((t): t is Task => !!t && keepsThreads(t) && openTask(t));
  const now = opts.now ?? Date.now();
  const byViewer = new Map<string, PoppedThread[]>();
  for (const owner of owners) {
    const file = await store.readThreads(owner.id);
    if (!file.threads.some((t) => !t.closed && (t.state === 'needs' || t.messages.some(deliveryOpen)))) continue;
    const read = await store.withTaskAsks(owner.id, file.threads, c.all as Task[], { carry: false });
    const shared = sharedAnswers(read);
    const listed = read.filter((t) => listedAbove(t, shared, now));
    if (!listed.length) continue;
    const answerable = opts.answerable ? await canAnswerNow(owner) : undefined;
    const viewers = opts.onlyViewer ? [opts.onlyViewer] : [...viewersOf(owner, c.byId, c.places)];
    for (const v of viewers) {
      const list = byViewer.get(v) ?? [];
      for (const t of listed) list.push(popped(t, owner, answerable));
      byViewer.set(v, list);
    }
  }
  for (const list of byViewer.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { byViewer, owners: owners.map((o) => o.id) };
}

/**
 * The results of tasks below that answer the subjects of a node's own threads (threads-store.ts
 * nodeView `carried`), as that node lists them: each with its owner and the thread it `carries`,
 * leaving out one `below` already lists. `answerable`: whether each owner takes a reply now.
 */
export async function carriedRows(carried: ReadonlyArray<{ thread: OrgThread; task: Task; carries: string }>, below: readonly PoppedThread[] = [], opts: { answerable?: boolean } = {}): Promise<PoppedThread[]> {
  const listed = new Set(below.map((t) => t.id));
  const out: PoppedThread[] = [];
  const can = new Map<string, boolean>();
  for (const c of carried) {
    if (listed.has(c.thread.id)) continue;
    listed.add(c.thread.id);
    if (opts.answerable && !can.has(c.task.id)) can.set(c.task.id, await canAnswerNow(c.task));
    out.push({ ...popped(c.thread, c.task, opts.answerable ? can.get(c.task.id) : undefined), carries: c.carries });
  }
  return out;
}

/** The threads listed above `viewerId` (the route's read). */
export async function poppedThreadsFor(viewerId: string, opts: { answerable?: boolean } = {}): Promise<PoppedThread[]> {
  return (await poppedIndex({ onlyViewer: viewerId, ...opts })).byViewer.get(viewerId) ?? [];
}

function popped(t: OrgThread, owner: Task, answerable: boolean | undefined): PoppedThread {
  return {
    ...t, owner: { task_id: owner.id, title: orgDisplayTitle(owner) },
    ...(answerable !== undefined ? { can_answer_now: answerable } : {}),
    ...(t.askId ? { ask_id: t.askId } : {}),
  };
}

/**
 * The owner's session a reply goes to, or null: none, or its host out of reach. A completed task
 * still takes it (his message reopens it, as any of his messages does).
 */
export async function ownerSession(owner: Task): Promise<SessionRecord | null> {
  if (owner.user_status?.state === 'waiting' && owner.user_status.kind === 'machine') return null;
  const { leadSession } = await import('./org-store.js');
  return leadSession(owner.id).catch(() => null);
}

export async function canAnswerNow(owner: Task): Promise<boolean> {
  return !!(await ownerSession(owner));
}

/**
 * Where a thread `viewerId` names lives when it is not on its own Threads: a task below it that
 * owns it (any state: a card opened before it left needs still answers), else wherever it is now.
 */
export async function findThreadOwner(viewerId: string, threadId: string): Promise<{ node: string; task?: Task; thread: OrgThread } | null> {
  const c = await context();
  const store = await import('./threads-store.js');
  const holders = new Set(await store.threadTaskIds());
  const tried = new Set<string>();
  for (const owner of ownersBelow(viewerId, c.all, c.places, holders)) {
    tried.add(owner.id);
    const t = (await store.readThreads(owner.id)).threads.find((x) => x.id === threadId && !movedAway(x));
    if (t) return { node: owner.id, task: owner, thread: t };
  }
  // A result it carries (thread-subject-pairs.ts) lives on a task its own open threads name, often a
  // completed one ownersBelow leaves out: those few files before a read of every node.
  const named = new Set((await store.readThreads(viewerId)).threads.flatMap((x) => (x.closed ? [] : x.tasks ?? [])));
  for (const id of named) {
    if (tried.has(id) || id === viewerId || !holders.has(id)) continue;
    const t = (await store.readThreads(id)).threads.find((x) => x.id === threadId && !movedAway(x));
    if (t) return { node: id, task: c.byId.get(id), thread: t };
  }
  const found = await locateThread(threadId, viewerId);
  return found ? { ...found, task: c.byId.get(found.node) } : null;
}

/** The one live record of a thread, on any node (a read of every node: only for a link to a thread no longer below or where it was). */
export async function locateThread(threadId: string, skip?: string): Promise<{ node: string; thread: OrgThread } | null> {
  const store = await import('./threads-store.js');
  for (const node of await store.threadTaskIds()) {
    if (node === skip) continue;
    const t = (await store.readThreads(node)).threads.find((x) => x.id === threadId && !movedAway(x));
    if (t) return { node, thread: t };
  }
  return null;
}

/** One thread as a viewer above its owner reads it: its owner, whether it takes a reply now, its ask id. */
export async function poppedOne(found: { node: string; task?: Task; thread: OrgThread }): Promise<PoppedThread> {
  const owner = found.task ?? (await (await import('../task-manager.js')).listTasksByIds([found.node]))[0];
  if (!owner) return { ...found.thread, owner: { task_id: found.node, title: found.node } };
  return popped(found.thread, owner, await canAnswerNow(owner));
}

/**
 * A thread `viewerId` names that is not on its own Threads (a moved thread's pointer there is
 * followed: threads-store.ts threadHolder), under the experiment only: where it lives.
 */
export async function elsewhereThread(viewerId: string, threadId: string): Promise<{ node: string; task?: Task; thread: OrgThread } | null> {
  const { threadsPopUpOn } = await import('./thread-popup-rules.js');
  if (!(await threadsPopUpOn())) return null;
  const store = await import('./threads-store.js');
  const here = (await store.readThreads(viewerId)).threads.find((t) => t.id === threadId);
  if (here && !movedAway(here)) return null;
  if (here) {
    const holder = await store.threadHolder(here.movedTo!.task, threadId).catch(() => null);
    if (holder && !movedAway(holder.thread)) return { node: holder.node, thread: holder.thread };
  }
  return findThreadOwner(viewerId, threadId);
}
