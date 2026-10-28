/**
 * Which way a message goes in the org, for the expect_reply default (session-send-core.ts). A note
 * up the org (to the sender's own leader, the VP of its project, or Main) reports; it asks for no
 * reply unless the sender passes expect_reply=true. Work handed down or across still asks for one.
 *
 * 2026-10-27, the org's reflection: "X is live, nothing for you to do" reached Main with a request
 * id, so Main answered five such notices with "received", and a VP that did not answer was told it
 * "ended WITHOUT an explicit reply" and read its history four times over.
 */
import type { Task } from '../types.js';

/** `to` is above `from`: Main, an ancestor of `from` (its leader, its leader's leader), or the VP leading `from`'s team. */
export async function goesUp(fromTaskId: string | undefined, toTaskId: string | undefined): Promise<boolean> {
  if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return false;
  const { listTasks } = await import('../task-manager.js');
  const tasks = await listTasks();
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const from = byId.get(fromTaskId);
  const to = byId.get(toTaskId);
  if (!from || !to) return false;
  if (to.org_role === 'main') return from.org_role !== 'main';
  // Its own leaders, however far up (a cycle in bad data stops at the first repeat).
  const seen = new Set<string>();
  for (let t: Task | undefined = from; t?.parent_task_id && !seen.has(t.id); t = byId.get(t.parent_task_id)) {
    seen.add(t.id);
    if (t.parent_task_id === to.id) return true;
  }
  if (to.org_role !== 'lead' || from.org_role === 'main') return false;
  const { teamOf } = await import('../org/team-asks.js');
  return teamOf(tasks, from)?.lead.id === to.id;
}
