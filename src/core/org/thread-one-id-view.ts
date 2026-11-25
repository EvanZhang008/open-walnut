/**
 * The reads of the experiment `threads_one_id` (thread-one-id.ts): the threads a node handed to
 * tasks, as that node lists them (the same record, same id, while it has something for him), and
 * where one of them lives now (his reply on its card goes there).
 *
 * One rule for which copy is the thread when both are open (leftoverHere): the one that arrived last.
 * A move writes the copy where it goes first and closes the source after (threads-store.ts
 * moveThread), so a crash between the two, or a read in that moment, finds two open copies: the
 * task's that came from the node is the thread unless the node's came back from the task later (a
 * finished task gave it back, returnFinishedAsks). Every read here hides the node's leftover behind
 * the task's, his reply goes to the task's, and the read that finds it moves it again (healLeftover),
 * which leaves the node a pointer; a move still running then finds its source closed and does nothing.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import type { OrgThread, ThreadsFile } from './threads-model.js';
import { handedFrom, handedPointer, oneIdNow, oneIdOn, openTask } from './thread-one-id.js';
import type { OrgPlaces } from './thread-follow.js';

type Holder = { task: Task; threads: readonly OrgThread[] };

/**
 * Pure: the node's own open copy `mine` is a leftover of the task's open copy `theirs` (handed from
 * the node): it did not come back from that task after `theirs` arrived. 2026-11-25: a status read in
 * the moment a finished task gave a thread back saw both copies and moved it to the task again.
 */
export function leftoverHere(mine: Pick<OrgThread, 'closed' | 'movedFrom'>, theirs: Pick<OrgThread, 'movedFrom'>, holderId: string): boolean {
  if (mine.closed) return false;
  const back = mine.movedFrom?.task === holderId ? mine.movedFrom.at : '';
  return back <= (theirs.movedFrom?.at ?? '');
}

/** Thread id → the task that holds it handed from a node, as the last read saw it (handedHolder's cheap look for a leftover copy). */
const handedSeen = new Map<string, string>();
const healing = new Set<string>();

/**
 * The node's own copy of a thread the task already holds (a move cut off between its writes): moved
 * again, the same move (kind 'hand', its record's why and owners), so the task's copy keeps all it
 * has, gains what the node's had, and the node keeps a pointer. One at a time per thread; never throws.
 */
function healLeftover(viewerId: string, holder: Task, copy: OrgThread): void {
  const m = copy.movedFrom;
  if (!m || healing.has(copy.id)) return;
  healing.add(copy.id);
  void (async () => {
    const { moveThread } = await import('./threads-store.js');
    const { orgDisplayTitle } = await import('./org-tree.js');
    await moveThread({ from: { task: viewerId, title: m.title }, to: { task: holder.id, title: orgDisplayTitle(holder) }, threadId: copy.id, by: m.by, ...(m.why ? { why: m.why } : {}), kind: 'hand', ...(m.owners !== undefined ? { owners: m.owners } : {}) });
    log.task.info('org thread: a leftover copy of a handed thread healed', { threadId: copy.id, node: viewerId, holder: holder.id });
  })().catch(() => {}).finally(() => healing.delete(copy.id));
}

/**
 * Every task (no Org node) holding threads that came by a hand-off, by the node that handed them:
 * one read of each such task's Threads. `onlyViewer`: only tasks below that one (its team and
 * subtasks, done ones too: a result of a finished task still has something for him).
 */
export async function handedIndex(opts: { all?: readonly Task[]; onlyViewer?: string } = {}): Promise<Map<string, Holder[]>> {
  const store = await import('./threads-store.js');
  const all = opts.all ?? await (await import('../task-manager.js')).taskStoreSnapshot();
  const byId = new Map(all.map((t) => [t.id, t] as const));
  let held = (await store.threadTaskIds()).map((id) => byId.get(id)).filter((t): t is Task => !!t && !t.org_role);
  if (opts.onlyViewer) {
    const { viewersOf } = await import('./thread-popup.js');
    const { isOrgEnabled } = await import('./org-enabled.js');
    const { orgPlaces } = await import('./thread-follow.js');
    const places = (await isOrgEnabled()) ? orgPlaces(all) : null;
    held = held.filter((t) => viewersOf(t, byId, places).has(opts.onlyViewer!));
  }
  const out = new Map<string, Holder[]>();
  for (const task of held) {
    const threads = (await store.readThreads(task.id).catch(() => null as ThreadsFile | null))?.threads ?? [];
    const handed = threads.filter((t) => !t.closed && t.movedFrom?.kind === 'hand');
    for (const t of handed) handedSeen.set(t.id, task.id);
    if (handedSeen.size > 5_000) handedSeen.clear();
    const from = new Set(handed.map((t) => t.movedFrom!.task));
    for (const v of from) out.set(v, [...(out.get(v) ?? []), { task, threads }]);
  }
  return out;
}

/** A handed thread as the node that handed it on lists it (thread-popup.ts PoppedThread, `carries` its own id). */
export type HandedRow = import('./thread-popup.js').PoppedThread;

/**
 * The threads `viewerId` handed to tasks under this experiment, each the task's one record, listed
 * while it has something for him (thread-view.ts listedAbove: it waits on him, a result for him, his
 * reply on its way). Found by the task's `movedFrom` (durable) and by the viewer's own pointers
 * (`ownThreads`, which follow a thread handed on again). `holders`: every task read, so a change of
 * one recounts the viewer. `ids`: every thread found handed, listed or not: the viewer's own copy of
 * one (a cut-off move) is never a card or a count of its own, and is healed. Empty with the switch
 * off. `answerable`: whether each owner takes a reply now.
 */
export async function handedRows(viewerId: string, ownThreads: readonly OrgThread[], opts: { index?: Map<string, Holder[]>; all?: readonly Task[]; answerable?: boolean; now?: number } = {}): Promise<{ rows: HandedRow[]; holders: string[]; ids: Set<string> }> {
  if (!oneIdNow()) return { rows: [], holders: [], ids: new Set() };
  const store = await import('./threads-store.js');
  const all = opts.all ?? await (await import('../task-manager.js')).taskStoreSnapshot();
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const index = opts.index ?? await handedIndex({ all, onlyViewer: viewerId });
  const holders = new Map<string, { holder: Holder; ids: Set<string> }>();
  for (const h of index.get(viewerId) ?? []) {
    holders.set(h.task.id, { holder: h, ids: new Set(h.threads.filter((t) => handedFrom(t, viewerId)).map((t) => t.id)) });
  }
  // A pointer here follows the thread wherever it went on (a few hops: threadHolder).
  for (const p of ownThreads.filter(handedPointer)) {
    const found = await store.threadHolder(p.movedTo!.task, p.id).catch(() => null);
    const task = found ? byId.get(found.node) : undefined;
    if (!found || !task || task.org_role || found.thread.closed) continue;
    const cur = holders.get(task.id) ?? { holder: { task, threads: (await store.readThreads(task.id)).threads }, ids: new Set<string>() };
    cur.ids.add(p.id);
    holders.set(task.id, cur);
  }
  const { listedAbove, sharedAnswers } = await import('./thread-view.js');
  const popup = await import('./thread-popup.js');
  const now = opts.now ?? Date.now();
  const rows: HandedRow[] = [];
  const found = new Set<string>();
  const mine = new Map(ownThreads.filter((t) => !t.closed).map((t) => [t.id, t] as const));
  for (const { holder, ids } of holders.values()) {
    if (!ids.size) continue;
    for (const id of [...ids]) {
      const own = mine.get(id);
      const copy = own ? holder.threads.find((t) => t.id === id) : undefined;
      // Back here since: the node's copy is the thread, the task's the leftover of that move.
      if (own && copy && !leftoverHere(own, copy, holder.task.id)) { ids.delete(id); continue; }
      found.add(id);
      if (copy) healLeftover(viewerId, holder.task, copy);
    }
    const read = await store.withTaskAsks(holder.task.id, holder.threads, all as Task[], { carry: false });
    const shared = sharedAnswers(read);
    const listed = read.filter((t) => ids.has(t.id) && listedAbove({ ...t, carries: t.id }, shared, now));
    if (!listed.length) continue;
    const answerable = opts.answerable ? await popup.canAnswerNow(holder.task) : undefined;
    for (const t of listed) rows.push({ ...popup.poppedRow(t, holder.task, answerable), carries: t.id });
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { rows, holders: [...holders.keys()], ids: found };
}

/**
 * Where a thread `viewerId` handed on lives now, with the switch on (thread-popup.ts elsewhereThread
 * reads it with threads_pop_up off): by its pointer here, by the task holding it when the node's own
 * copy was left open (handedSeen, filled by every read of the index), else by a task below that holds
 * it handed from here (the pointer is gone after a week). Null when it is not one of those.
 */
export async function handedHolder(viewerId: string, threadId: string, here: OrgThread | undefined): Promise<{ node: string; task?: Task; thread: OrgThread } | null> {
  if (!(await oneIdOn())) return null;
  const store = await import('./threads-store.js');
  const all = await (await import('../task-manager.js')).taskStoreSnapshot();
  const byId = new Map(all.map((t) => [t.id, t] as const));
  if (here && handedPointer(here)) {
    const found = await store.threadHolder(here.movedTo!.task, threadId).catch(() => null);
    const task = found ? byId.get(found.node) : undefined;
    if (found && task && !task.org_role && !found.thread.closed) return { node: found.node, task, thread: found.thread };
    return null;
  }
  if (here && !here.closed) {
    // The node's own copy left open by a cut-off move: the task's copy is the thread.
    const at = handedSeen.get(threadId);
    const task = at ? byId.get(at) : undefined;
    const t = task ? (await store.readThreads(task.id)).threads.find((x) => x.id === threadId && handedFrom(x, viewerId)) : undefined;
    if (!task || !t || !leftoverHere(here, t, task.id)) return null;
    healLeftover(viewerId, task, t);
    return { node: task.id, task, thread: t };
  }
  if (here) return null;
  for (const h of (await handedIndex({ all, onlyViewer: viewerId })).get(viewerId) ?? []) {
    const t = h.threads.find((x) => x.id === threadId && handedFrom(x, viewerId));
    if (t) return { node: h.task.id, task: h.task, thread: t };
  }
  return null;
}

/** Does `taskId` hold a thread handed to it, as the last read saw it (thread-follow.ts wakes its pass when such a task finishes)? */
export function holdsHanded(taskId: string): boolean {
  for (const holder of handedSeen.values()) if (holder === taskId) return true;
  return false;
}

/** Finished tasks already looked at, by their last change: each is read once per change. */
const finishedRead = new Map<string, string>();

/**
 * A task finished while a thread handed to it waits on him (needs): the thread goes back to the node
 * that handed it, as a thread goes with its work, so his decision stays in a Needs you count (a
 * finished task counts none: user-status-sync.ts) and the card he sees is the one that counts.
 * Run by the follow pass (thread-follow.ts runThreadFollowPass). Returns how many went back.
 */
export async function returnFinishedAsks(p: OrgPlaces): Promise<number> {
  if (!(await oneIdOn())) return 0;
  const store = await import('./threads-store.js');
  const follow = await import('./thread-follow.js');
  const held = new Set(await store.threadTaskIds());
  let n = 0;
  for (const task of p.all as readonly Task[]) {
    if (task.org_role || openTask(task) || !held.has(task.id)) continue;
    const mark = `${task.updated_at ?? ''}|${task.phase ?? ''}`;
    if (finishedRead.get(task.id) === mark) continue;
    let left = false;
    for (const t of (await store.readThreads(task.id)).threads) {
      if (t.closed || t.state !== 'needs' || t.movedFrom?.kind !== 'hand') continue;
      const back = p.byId.get(t.movedFrom.task);
      if (!back || !openTask(back)) { left = true; continue; }
      const why = `its task ${JSON.stringify(task.title)} finished while it waits on the user`;
      if (await follow.runMove({ from: task, to: back, threadId: t.id, title: t.title, why }, 'agent', { tellFrom: false }, 'work')) n++;
      else left = true;
    }
    if (!left) finishedRead.set(task.id, mark);
    if (finishedRead.size > 5_000) finishedRead.clear();
  }
  return n;
}
