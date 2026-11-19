/**
 * The team tasks whose asks a VP's Threads show under "From your team" (experiment
 * action_needed_everywhere). The same items as each task's row (user_status.actions), never a
 * second record: answered or snoozed in either place, they go from both.
 */
import type { Task } from '@open-walnut/core';
import { flattenNodes, type ChannelRow } from '@/components/org/org-channels-model';
import type { OrgThread } from '@/api/org-threads';

/** An item asks now: not snoozed, or its snooze has run out. */
export function asksNow(task: Pick<Task, 'user_status'>, nowMs: number): boolean {
  return (task.user_status?.actions ?? []).some((i) => !i.snoozedUntil || Date.parse(i.snoozedUntil) <= nowMs);
}

/** The task a thread's decision is asked in (core/org/thread-task-ask.ts) while it still asks it:
 *  a shown thread's card answers that task's items in place, and "From your team" leaves it out.
 *  One rule for both, so an ask is drawn once. */
export function askingTaskOf(t: Pick<OrgThread, 'closed' | 'askedIn'>, byId: ReadonlyMap<string, Task>): Task | undefined {
  if (t.closed || !t.askedIn || t.askedIn.answered) return undefined;
  const task = byId.get(t.askedIn.task);
  return task?.user_status?.actions?.length ? task : undefined;
}

/**
 * The tasks of this node's own team (its tree, workers included, in its order) that ask the user
 * something now. Not the node itself (its asks are in its chat), nor a finished task. Main lists
 * only its own row's team (its row holds no project tree, so none today), never a VP's: each VP
 * lists its own, one place per ask. OrgThreads leaves out
 * the ones a shown thread already answers in place.
 */
export function teamActionTasks(row: Pick<ChannelRow, 'node' | 'contactId'>, byId: ReadonlyMap<string, Task>, nowMs: number): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  for (const n of flattenNodes(row.node?.teams ?? [])) {
    if (seen.has(n.id) || n.id === row.contactId) continue;
    seen.add(n.id);
    const t = byId.get(n.id);
    if (t && t.phase !== 'COMPLETE' && asksNow(t, nowMs)) out.push(t);
  }
  return out;
}
