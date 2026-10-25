/**
 * The main agent's task never parks and never hands itself back (user,
 * 2026-10-25: "your main agent always stays active ... there is no reason to put
 * wait, because that makes you vanish from the task list").
 *
 * Main is a standing conversation, not a job with a finish line: a subtask's
 * reply, a Walnut notice and the user's own message all wake it on their own.
 * Before this, Main read the generic "arm a trigger, it parks this task" rule as
 * "park at the end of every turn": it set WAITING with a wait_until almost every
 * turn, dropped off the user's task list, added a tool row per turn, and its
 * clock woke it for nothing. And every turn end painted it NEED_ACTION ("needs
 * you") although it was only answering.
 *
 * So, for a task whose `org_role` is 'main':
 *  - a WAITING write is not applied, from any writer (updateTask drops it and
 *    the PATCH answers with `phase_ignored`; trigger_create never parks it);
 *  - a turn end (a result, or the reconciler's hand-back of a settled session)
 *    keeps it In Progress. It needs the user only when it really asks them: a
 *    question or permission prompt still moves it to NEED_ACTION, and so does an
 *    error, or a NEED_ACTION it sets itself;
 *  - the "IN_PROGRESS with a settled session = a lost result" repair lanes skip
 *    it unless its session ended in an error, because for Main that shape is
 *    normal, not debt; an idle reap is no error for it, and its phase never
 *    arms an unattended auto-resume (In Progress no longer means a turn ran).
 */

export const MAIN_STAYS_ACTIVE = 'main_stays_active' as const;

export const MAIN_STAYS_ACTIVE_NOTE =
  'The main agent\'s task never parks: WAITING is not applied to it, and it stays In Progress. '
  + 'Replies from subtasks, Walnut notices and the user\'s messages wake it on their own.';

export function isMainAgentTask(task: { org_role?: string } | null | undefined): boolean {
  return task?.org_role === 'main';
}
