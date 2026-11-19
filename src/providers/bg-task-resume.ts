/**
 * A background task the CLI ended and then started again under the SAME call: it runs again.
 *
 * Claude Code 2.1.32x parks a background subagent that waits on a background command of its own:
 * it marks the subagent completed (task_updated + task_notification, the summary saying what it
 * waits for), and when that command ends it lists the subagent again and sends a task_started with
 * the subagent's original tool_use_id and is_backgrounded:true, and the subagent goes on with its
 * tools. 2026-11-19: every background-task tracker held "terminal is terminal" against that start,
 * so the subagent stayed ended in Walnut's eyes; the moment its own command ended nothing was left
 * running, the task was handed back as NEED_ACTION and its lead read "stopped without completing
 * its task" three times while the subagent kept working.
 *
 * A stray start (a duplicate or a reordered line) still cannot revive an ended task: it is a resume
 * only with the call's own id and the backgrounded flag that a resumed subagent's start carries.
 * Should one revive a call that really ended, two things end it again: the next
 * background_tasks_changed that leaves it out (it was listed before, so it is marked endedPerLevel)
 * and the process ending. The live runner's daemon check (reconcileFromDaemon) takes the daemon's
 * terminal only when it was written after the start, since an older daemon keeps the park's.
 * Every tracker that counts backgrounded tasks uses this one rule: the live runner and the server's
 * reconcile call it; the daemon fold and both daemon twins' task counts are self-contained and
 * inline it, and tests/providers/bg-task-resume.test.ts feeds the real stream shape to all of them.
 * (session-history.ts's replay count leaves backgrounded tasks out altogether, so it needs none.)
 */
export function resumesEndedCall(
  line: { subtype?: unknown; tool_use_id?: unknown; is_backgrounded?: unknown },
  prevToolUseId: string | undefined,
): boolean {
  return line.subtype === 'task_started'
    && line.is_backgrounded === true
    && typeof line.tool_use_id === 'string' && line.tool_use_id.length > 0
    && line.tool_use_id === prevToolUseId
}
