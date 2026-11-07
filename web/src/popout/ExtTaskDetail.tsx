/**
 * A task with no conversation, opened from the extension's first page: Home's task detail in the
 * frame (loaded lazily, as Home's own detail is a console module), never a new browser tab. Its
 * session row opens the conversation here too (`onOpenSession`).
 */
import type { Task } from '@open-walnut/core';
import { TaskDetailPane } from '@/components/tasks/TaskDetailPane';
import { useTasksContext } from '@/contexts/TasksContext';

export default function ExtTaskDetail({ task, onOpenSession, onClose }: { task: Task; onOpenSession: (sessionId: string) => void; onClose: () => void }) {
  const { tasks } = useTasksContext();
  return <TaskDetailPane task={task} allTasks={tasks} onClose={onClose} onOpenSession={onOpenSession} />;
}
