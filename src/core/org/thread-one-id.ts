/**
 * One thread across a hand-off (experiment `threads_one_id`; 2026-11-25, the user, of one request
 * he saw as his VP's card and as a second card the task it was handed to opened: "two threads for
 * the same thing"). One request, one id:
 *
 *   1. the hand-off: a node (Main, a lead, or a task with Threads on) hands a thread with `thread`
 *      to a task of its own team that keeps Threads: the thread MOVES to that task with the same id,
 *      through the cross-node move (thread-follow.ts runMove: the node keeps a closed pointer
 *      `movedTo`, the task gets it with `movedFrom`, kind 'hand'), instead of only listing the task.
 *      `oneIdDecision` says move or stay; a thread that stays is linked as before;
 *   2. the card he asked on: the node that handed it on reads that one record, same id, while it has
 *      something for him (it waits on him, a result for him, his reply on its way), whatever
 *      `threads_pop_up` says (thread-one-id-view.ts handedRows): never a second card (its own pointer steps aside), and
 *      his reply on it goes to the task (thread-popup.ts elsewhereThread, thread-reply.ts);
 *   3. the task hears it in one line (`sameIdTaskLine`): it answers there and opens no second one,
 *      and the same-subject refusal (thread-same-subject.ts) finds the thread on its own Threads.
 *
 * Off again: a moved thread stays where it is, an ordinary moved thread (closed pointer, open copy).
 * Pure but for the switch: the model, the hand-off and the ops import this; the reads live in
 * thread-one-id-view.ts.
 */
import { experimentCache } from '../experimental-cache.js';
import type { Task } from '../types.js';
import { keepsThreads } from './keeps-threads.js';
import type { OrgThread } from './threads-model.js';

const flag = experimentCache('threads_one_id');
/** The experiment as last read (user-status-sync.ts sets it on every config change). */
export const setThreadsOneId = flag.set;
export const oneIdNow = flag.now;
/** The experiment, read from the config now (a route right after Settings changed it agrees). */
export const oneIdOn = flag.on;

/** Why a named thread stays on the node that handed the work on (and only lists the task). */
export type OneIdStay =
  | 'off' | 'not_a_task' | 'no_threads' | 'closed_task' | 'not_own_team'
  | 'waits_on_him' | 'letter' | 'choice' | 'own_ask' | 'watched' | 'known' | 'other_tasks';

export type OneIdDecision = { move: true } | { move: false; stay: OneIdStay };

type Keeper = Pick<Task, 'id' | 'org_role' | 'threads_on' | 'phase' | 'status'>;
export const openTask = (t: Pick<Task, 'phase' | 'status'>): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';

/**
 * Pure: does the thread `from` names go to `target` under its id? Only to an open task (no Org node:
 * the cross-node rule moves those) that keeps Threads and works in `from`'s own team (`ownTeam`).
 * A thread stays and lists the task, as before, when it holds something of the node's he acts on
 * there: it waits on him now (his buttons are the node's ask), a decision letter or a Board choice
 * of the node's, the node's own ask, his watch or his Acknowledge (Known) on the node's Threads, or
 * other open tasks besides the target (the node still holds the rest of it, as the follow rule says).
 */
export function oneIdDecision(input: { on: boolean; from: Keeper; target: Keeper; thread: OrgThread; ownTeam: boolean; isOpen: (taskId: string) => boolean }): OneIdDecision {
  const { from, target, thread: t } = input;
  const stay = (why: OneIdStay): OneIdDecision => ({ move: false, stay: why });
  if (!input.on) return stay('off');
  if (target.org_role) return stay('not_a_task');
  if (!keepsThreads(target)) return stay('no_threads');
  if (!openTask(target)) return stay('closed_task');
  if (target.id === from.id || !input.ownTeam) return stay('not_own_team');
  if (t.state === 'needs' || t.askOwner) return stay('waits_on_him');
  if (t.letter) return stay('letter');
  if (t.choice) return stay('choice');
  if (t.reportAsk) return stay('own_ask');
  if (t.watched) return stay('watched');
  if (t.ackedAt && t.state === 'pending') return stay('known');
  if ((t.tasks ?? []).some((id) => id !== target.id && id !== from.id && input.isOpen(id))) return stay('other_tasks');
  return { move: true };
}

/** The words a link says when the switch is on and the thread still stays (none: the reason is today's rule). */
const STAY_WORDS: Partial<Record<OneIdStay, string>> = {
  waits_on_him: 'it waits on the user now, and he answers it where he was asked',
  letter: 'it holds your decision letter',
  choice: 'it holds your Board choice',
  own_ask: 'it holds your own ask',
  watched: 'the user watches it on your Threads',
  known: 'the user put it in Known on your Threads',
  other_tasks: 'it lists other open tasks too',
  no_threads: 'that task keeps no Threads',
};
export function stayWords(d: OneIdDecision | null): string | undefined {
  return d && !d.move ? STAY_WORDS[d.stay] : undefined;
}

/** Pure: is `task` below `ancestor` in the parent chain (a task's own team when it is no Org node)? */
export function isBelow(task: Pick<Task, 'parent_task_id'>, ancestor: string, byId: ReadonlyMap<string, Pick<Task, 'parent_task_id'>>): boolean {
  const seen = new Set<string>();
  for (let id = task.parent_task_id; id && !seen.has(id); id = byId.get(id)?.parent_task_id) {
    if (id === ancestor) return true;
    seen.add(id);
  }
  return false;
}

const q = (s: string) => JSON.stringify(s);

/** The one line the task hears when its thread came with the work (about 140 bytes, once per hand-off). */
export function sameIdTaskLine(id: string, title: string): string {
  return `This work is thread ${id} ${q(title)}, on your Threads now: answer the user there and open no second thread for it.`;
}

/** The task's line for a create's outcome (src/ops/tasks.ts puts it in the first message: the task had no session when it moved). */
export function sameIdLineFor(r: { moved?: ReadonlyArray<{ id: string; title: string; to: { task: string }; same_card?: boolean }> } | null | undefined, taskId: string): string {
  return (r?.moved ?? []).filter((m) => m.same_card && m.to.task === taskId).map((m) => sameIdTaskLine(m.id, m.title)).join(' ');
}

/**
 * Pure: `t` came to `holder` from `viewerId` by a hand-off (a node's, never the user's own move),
 * and the holder is a task, not an Org node: the viewer reads it as its card.
 */
export function handedFrom(t: Pick<OrgThread, 'closed' | 'movedFrom'>, viewerId: string): boolean {
  const m = t.movedFrom;
  return !t.closed && !!m && m.kind === 'hand' && m.task === viewerId && m.by !== 'human';
}

/** Pure: a pointer here of a thread this node handed on (the user's own move never reads through). */
export function handedPointer(t: Pick<OrgThread, 'closed' | 'movedTo'>): boolean {
  return !!t.closed && !!t.movedTo && t.movedTo.kind === 'hand' && t.movedTo.by !== 'human';
}
