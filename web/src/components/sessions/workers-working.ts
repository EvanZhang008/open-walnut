/**
 * The workers a session's task has at work: the line under its chat beside the "<engine> is
 * working…" line. 2026-11-23, the user, on a task parked on its four workers that read Working with
 * no working line under its chat: "它正常的这种 working，它都会有这个 claude code is what what what，
 * 然后那个 sub agents is what what what。这上面没有显示啊，你确定吗". Its workers are Walnut tasks of
 * their own (subtasks), not subagents of its session, so the session's own working line never saw them.
 *
 * 2026-11-25, the user, on a lead with thirteen workers: "如果要显示这些，是不是自动应该 collapse？
 * 而且它刚才显示了之后又突然消失". So the line is drawn from the workers alone, whatever the lead
 * itself reads or runs (its own turn, a moment Waiting on its report), and a long one is one folded
 * line. Pure, so the list's select can run it each change.
 */
import type { Task } from '@open-walnut/core';
import { taskUserState } from '@/utils/session-status';

export interface WorkingWorker { id: string; title: string }

/** At most this many workers show as chips by themselves; more fold into one line. */
export const WORKERS_INLINE_MAX = 3;

/** The workers at work of the task this session is the current session of. */
export function workersWorkingOf(tasks: readonly Task[], sessionId: string): WorkingWorker[] {
  // Its current session only: an earlier session's chat is history, its workers are not its news.
  const own = tasks.find((t) => t.session_id === sessionId);
  if (!own) return [];
  return tasks
    .filter((t) => t.parent_task_id === own.id && taskUserState(t) === 'working')
    .map((t) => ({ id: t.id, title: t.title }));
}

/** The line's words: how many are at work. */
export function workersWorkingLabel(count: number): string {
  return count === 1 ? '1 worker is working…' : `${count} workers are working…`;
}

/** Whether the line starts folded: a long list does, a short one shows its chips. */
export const workersStartFolded = (count: number): boolean => count > WORKERS_INLINE_MAX;
