/**
 * A hand-off's outcome and the lines it says (thread-follow.ts handOffThread), and the one decision
 * of the experiment `threads_one_id` at a hand-off (thread-one-id.ts oneIdDecision): made before the
 * send, so the message that hands the work over tells the task which thread it is
 * (sameIdLineBeforeSend: task_send and task_start; a create's first message gets it from the op),
 * and again at the move, which wins: when the thread changed in between, the task hears the move in
 * one line on its next message, as before (2026-11-25, the lead's review: in the turn that receives
 * the work the task must already know its thread).
 */
import type { MoveEnd, OrgThread } from './threads-model.js';
import type { FollowTask, OrgPlaces } from './thread-follow.js';
import { keepsThreads } from './keeps-threads.js';
import { isBelow, oneIdDecision, oneIdOn, openTask, sameIdTaskLine, type OneIdDecision } from './thread-one-id.js';

export interface HandOffResult {
  /** `same_card`: moved to the task itself under threads_one_id; the caller shows that one card (thread-one-id-view.ts). */
  moved: Array<{ id: string; title: string; to: MoveEnd; same_card?: true }>;
  /** `stays`: why it stayed on the caller with threads_one_id on. */
  linked: Array<{ id: string; title: string; stays?: string }>;
  /** Why the named thread was not handed on. */
  refused?: string;
}

const q = (s: string) => JSON.stringify(s);

const NO_THREADS = 'Only Main, a lead or a task with Threads on keeps Threads: no thread was handed on.';

/** Who hands work on and to which task, or why no thread goes with it. `prefix`: `target` may be a unique id prefix. */
export async function handOffParties(callerSid: string | undefined, targetRef: string, opts: { prefix?: boolean } = {}): Promise<{ from: FollowTask; target: FollowTask; p: OrgPlaces } | { refused: string }> {
  const { resolveBoardCaller } = await import('../boards/board-team.js');
  const caller = await resolveBoardCaller(callerSid);
  if (caller.kind !== 'task') return { refused: NO_THREADS };
  const { orgTasks } = await import('./org-store.js');
  const p = (await import('./thread-follow.js')).orgPlaces(await orgTasks());
  const from = p.byId.get(caller.taskId);
  const named = opts.prefix && !p.byId.has(targetRef) ? (await import('../../lib/id-ref.js')).matchIdRef(p.byId.values(), targetRef) : [];
  const target = p.byId.get(targetRef) ?? (named.length === 1 ? named[0] : undefined);
  if (!from || !keepsThreads(from)) return { refused: NO_THREADS };
  if (!target) return { refused: `No task ${targetRef}: no thread was handed on.` };
  return { from, target, p };
}

/** The line an op's outcome carries about a hand-off (empty when there was none). */
export function handOffLine(r: HandOffResult | null | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  for (const m of r.moved) parts.push(`Thread ${m.id} ${q(m.title)} ${m.same_card ? `is on ${m.to.title}'s Threads now, same id: your Threads show that one card while it has something for the user` : `moved to ${m.to.title}'s Threads with the work; it is closed on yours`}.`);
  for (const l of r.linked) parts.push(`Thread ${l.id} ${q(l.title)} lists this task now${l.stays ? `; it stays on yours: ${l.stays}` : ''}.`);
  if (r.refused) parts.push(r.refused);
  return parts.join(' ');
}

/**
 * Pure: the one-id decision for the thread `from` names, handing work to `target`, whose work is in
 * node `to` (thread-follow.ts ownerNodeOf, given only when `from` is an Org node). A node's own team
 * is the tasks whose node it is; a task's, the tasks below it.
 */
export function sameIdDecision(input: { from: FollowTask; target: FollowTask; thread: OrgThread; to: FollowTask | undefined; p: OrgPlaces }): OneIdDecision {
  const { from, target, to, p } = input;
  return oneIdDecision({
    on: true, from, target, thread: input.thread,
    ownTeam: to ? to.id === from.id : isBelow(target, from.id, p.byId),
    isOpen: (id) => { const t = p.byId.get(id); return !!t && openTask(t); },
  });
}

/**
 * Before the send: the line the message that hands the work over carries when the thread it names
 * will go to the target under its id (sameIdDecision), else ''. Reads only; the move runs after the
 * send succeeded (handOffThread), so a failed send moves nothing. `target`: a task id or a unique
 * prefix of one. Never throws.
 */
export async function sameIdLineBeforeSend(input: { callerSid?: string; target?: string; threadId?: string }): Promise<string> {
  if (!input.threadId || !input.target || !(await oneIdOn())) return '';
  try {
    const follow = await import('./thread-follow.js');
    const parties = await handOffParties(input.callerSid, input.target, { prefix: true });
    if ('refused' in parties) return '';
    const { from, target, p } = parties;
    const { readThreads } = await import('./threads-store.js');
    const t = (await readThreads(from.id)).threads.find((x) => x.id === input.threadId && !x.closed);
    if (!t) return '';
    return sameIdDecision({ from, target, thread: t, to: follow.handOffTo(from, target, p), p }).move ? sameIdTaskLine(t.id, t.title) : '';
  } catch {
    return '';
  }
}

/** The message that hands the work over, with the task's line after its words. */
export function withSameIdLine(text: string, line: string): string {
  return line ? `${text}\n\n${line}` : text;
}
