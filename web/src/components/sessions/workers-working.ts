/**
 * The workers a session's task has at work while its own turn is over: what its chat shows where
 * the "<engine> is working…" line goes. 2026-11-23, the user, on a task parked on its four
 * workers that read Working with no working line under its chat: "它正常的这种 working，它都会
 * 有这个 claude code is what what what，然后那个 sub agents is what what what。这上面没有显示啊，
 * 你确定吗". Its workers are Walnut tasks of their own (subtasks), not subagents of its session, so
 * the session's own working line never saw them. Pure, so the list's select can run it each change.
 */
import type { Task } from '@open-walnut/core';
import { taskUserState } from '@/utils/session-status';

export interface WorkingWorker { id: string; title: string }

/** The session's task when it reads Working on its workers' work, with each worker at work. */
export function workersWorkingOf(tasks: readonly Task[], sessionId: string): WorkingWorker[] {
  // Its current session only: an earlier session's chat is history, its workers are not its news.
  const own = tasks.find((t) => t.session_id === sessionId);
  if (!own || taskUserState(own) !== 'working') return [];
  return tasks
    .filter((t) => t.parent_task_id === own.id && taskUserState(t) === 'working')
    .map((t) => ({ id: t.id, title: t.title }));
}

/** The line's words: how many are at work. */
export function workersWorkingLabel(count: number): string {
  return count === 1 ? '1 worker is working…' : `${count} workers are working…`;
}
