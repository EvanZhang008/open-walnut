/**
 * The details popup for a task the Home list does not carry: one finished over a week ago, a
 * plugin's own task, a link that named an id prefix. A click on such a task anywhere used to open
 * the separate task page, which read the task itself; that page is gone (utils/task-path.ts), so
 * Home reads it (MainPage `revealFetched`) and shows it here, over the list.
 *
 * The list's focus cannot hold it (MainPage drops a focus whose task is not in the list), so this
 * keeps its own copy, kept current by the task's events, and closes when the task is deleted.
 */
import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useEvent } from '@/hooks/useWebSocket';
import { deletedTaskId } from '../../../../src/core/task-deleted-id';
import { TaskDetailModal } from './TaskDetailModal';

export function OutsideTaskDetail({ task: initial, onClose }: {
  task: Task;
  onClose: () => void;
}) {
  const [task, setTask] = useState(initial);
  const follow = (data: unknown) => {
    const next = (data as { task?: Task } | undefined)?.task;
    if (next?.id === task.id) setTask((prev) => ({ ...prev, ...next }));
  };
  useEvent('task:updated', follow);
  useEvent('task:completed', follow);
  useEvent('task:deleted', (data) => { if (deletedTaskId(data) === task.id) onClose(); });
  return <TaskDetailModal task={task} onClose={onClose} />;
}
