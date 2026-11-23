/**
 * merge_into across one task tree (2026-11-23, the user's real data: a task with Threads on, under
 * a VP, with subtasks that keep their own Threads, held several threads about one issue on
 * different tasks, and merge_into answered no_thread for each: it looked only at the caller's own
 * Threads).
 *
 * The tree is the one the Threads views already read (thread-popup.ts threadTreeOf): the tasks
 * above the caller that read its threads (its parent chain, its lead, VP and Main) and the tasks
 * below it whose threads it reads. Only an open task that keeps Threads holds one. The caller's
 * thread moves to the task holding the target (thread-follow.ts moveThreadTo: its copy here closes
 * as moved, pointing there, and the nodes are told) and is merged there under that task's lock
 * (threads-store.ts mergeThread). The merge is tried on a copy first, so one the target refuses
 * (a closed target, his ask over the node's own post) moves nothing.
 */
import type { Task } from '../types.js';
import { orgDisplayTitle } from './org-tree.js';
import { checkMovable, mergeThreads, movedAway, moveThreadIn, ThreadError, type MoveEnd, type OrgThread, type ThreadWriter } from './threads-model.js';

export interface TreeMergeResult {
  /** The merged thread, where it lives now. */
  thread: OrgThread;
  /** The task that holds it. */
  on: MoveEnd;
}

/**
 * Merge `threadId` of `from` into `intoId` on another task of its tree. Null when the plain merge
 * on the caller's own Threads answers (the target is there, or the caller has no such thread: its
 * own refusals apply). Throws no_thread, saying why, when no task of the tree holds the target.
 */
export async function mergeAcrossTree(input: { from: Task; threadId: string; intoId: string; by: ThreadWriter }): Promise<TreeMergeResult | null> {
  const { from, threadId, intoId, by } = input;
  if (threadId === intoId) return null;
  const store = await import('./threads-store.js');
  const own = (await store.readThreads(from.id)).threads;
  const here = own.find((t) => t.id === intoId);
  const cur = own.find((t) => t.id === threadId);
  if ((here && !movedAway(here)) || !cur) return null;
  checkMovable(cur);
  const { threadTreeOf } = await import('./thread-popup.js');
  let holder: Task | undefined;
  let target: OrgThread | undefined;
  for (const t of await threadTreeOf(from.id, new Set(await store.threadTaskIds()))) {
    target = (await store.readThreads(t.id)).threads.find((x) => x.id === intoId && !movedAway(x));
    if (target) { holder = t; break; }
  }
  if (!holder || !target) {
    const went = here?.movedTo
      ? ` It moved to ${here.movedTo.title} (${here.movedTo.task}), outside your tree: thread_move ${threadId} there first, then merge it there.`
      : ' For a thread elsewhere: thread_move yours to the task that holds it, then merge it there.';
    throw new ThreadError('no_thread', 404, `No open thread ${intoId} on your Threads or on a task above or below yours that keeps Threads: merge_into reaches only your own task tree.${went}`);
  }
  const on: MoveEnd = { task: holder.id, title: orgDisplayTitle(holder) };
  const at = new Date().toISOString();
  const trial = moveThreadIn(await store.readThreads(holder.id), cur, { task: from.id, title: orgDisplayTitle(from) }, by, at);
  mergeThreads(trial.file, threadId, intoId, by, at);
  const { moveThreadTo } = await import('./thread-follow.js');
  const moved = await moveThreadTo({ from, threadId, to: holder.id, by, why: `merged into ${JSON.stringify(target.title)} there` });
  if (moved.to.task !== holder.id) throw new ThreadError('bad_input', 409, `Thread ${threadId} moved to ${moved.to.title} (${moved.to.task}), not to ${on.title}: merge it there with thread_update.`);
  try {
    const thread = await store.mergeThread(holder.id, threadId, intoId, by);
    // His follow-up from a card of the old thread goes to the one it joined (review 2026-11-23).
    await store.markMergedThere(from.id, threadId, intoId).catch(() => undefined);
    return { thread, on };
  } catch (err) {
    // Changed between the trial and the merge (the target closed meanwhile): the thread stays open where it went.
    if (!(err instanceof ThreadError)) throw err;
    throw new ThreadError(err.code, err.status, `${err.message} Your thread ${threadId} moved to ${on.title} (${on.task}) and stays open there.`);
  }
}
