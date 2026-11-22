/**
 * A thread's task chips: each task its live status dot and title, one click opens it. The card's
 * own chips and a Known card's "Waiting on" line (ThreadKnown.tsx) draw the same chip.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { shownState } from '@open-walnut/user-status';
import { useOpenTask } from '@/hooks/useOpenTask';

/** A task's live status dot, the colours of the Task view's tabs (OrgTaskRail TAB_DOT). */
const TASK_DOT: Record<string, string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)', done: 'var(--accent, #0A84FF)',
};

/** One task: its dot (when the task is loaded) and its title, or the `fallback` title, else its id. */
export function TaskChip({ id, task, fallback }: { id: string; task: Task | undefined; fallback?: string }) {
  const openTask = useOpenTask();
  // A task with only something to read wears Needs you, where it is drawn (shownState).
  const state = task ? shownState(userStateOf(task)) : null;
  const title = task?.title ?? fallback ?? id;
  return (
    // Its name wraps whole (.wn-title), so it needs no hover text; the icon keeps its line (.wn-fixed).
    <button type="button" className="org-thread-task" data-testid="org-thread-task" data-task-id={id} onClick={() => openTask(id)}>
      {state && <i className={state === 'working' ? 'wn-fixed task-working-pulse' : 'wn-fixed'} style={{ background: TASK_DOT[state] }} />}
      <span className="wn-title">{title}</span>
    </button>
  );
}

export function TaskChips({ ids, tasks }: { ids: readonly string[]; tasks: readonly Task[] }) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  return (
    <div className="org-thread-tasks" data-testid="org-thread-tasks">
      {ids.map((id) => <TaskChip key={id} id={id} task={byId.get(id)} />)}
    </div>
  );
}
