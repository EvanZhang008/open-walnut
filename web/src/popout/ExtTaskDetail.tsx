/**
 * A task with no conversation, opened from the extension's first page: Home's task detail in the
 * frame (loaded lazily, as Home's own detail is a console module), never a new browser tab. Its
 * session row opens the conversation here too (`onOpenSession`), and so does every task it links
 * to (its parent, its subtasks, its dependencies: `onOpenTask`): the detail's default opens Home,
 * which the panel's frame does not have, and the frame became the whole app (review round 5, #3).
 * A linked task not on the board opens in Walnut, beside the panel. The frame has no Home, so it
 * hands the one task open (hooks/useOpenTask.ts) its own way through TaskOpenerContext: a pill in
 * the detail's words goes the same way as its rows.
 */
import type { Task } from '@open-walnut/core';
import { TaskDetailPane } from '@/components/tasks/TaskDetailPane';
import { TaskOpenerContext, type OpenTaskOptions } from '@/hooks/useOpenTask';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useTasksContext } from '@/contexts/TasksContext';
import { resolveTaskSessionId } from '@/utils/session-status';
import { taskPath } from '@/utils/task-path';
import { toParent } from './ext-frame';
import type { OpenTask } from './ExtHomeTasks';

export default function ExtTaskDetail({ task, onOpenSession, onOpenTask, onClose }: {
  task: Task; onOpenSession: (sessionId: string) => void; onOpenTask: OpenTask; onClose: () => void;
}) {
  const { tasks } = useTasksContext();
  const open = useLeanCallback((id: string, opts?: OpenTaskOptions) => {
    // One of this task's own sessions (its session rows).
    if (opts?.sessionId && id === task.id) { onOpenSession(opts.sessionId); return; }
    const linked = tasks.find((t) => t.id === id);
    if (!linked) { toParent({ type: 'open-walnut', path: taskPath(id) }); return; }
    const sessionId = opts?.sessionId ?? resolveTaskSessionId(linked);
    onOpenTask(linked, sessionId ? { sessionId } : 'detail');
  }, [task.id, tasks, onOpenSession, onOpenTask]);
  return (
    <TaskOpenerContext.Provider value={open}>
      <TaskDetailPane task={task} allTasks={tasks} onClose={onClose} />
    </TaskOpenerContext.Provider>
  );
}
