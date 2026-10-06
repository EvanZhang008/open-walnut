/**
 * R3-05: a card opened in a narrow board with no session to show: the task
 * itself under the card's header, what the card had no room for: its
 * description, its note and its open subtasks. The store holds the list
 * projection (no description, no note), so the task is read once on open
 * (fetchTask); until it answers, the section waits quietly.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchTask } from '@/api/tasks';
import { useStoreTask, useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';

const isOpen = (phase: string | undefined) => phase !== 'COMPLETE';

export function KanbanDetailTask({ taskId }: { taskId: string }) {
  const task = useStoreTask(taskId);
  const store = useTasksContextSafe();
  const tasks = store?.tasks;
  const subtasks = useMemo(
    () => (tasks ?? []).filter((t) => t.parent_task_id === taskId && isOpen(t.phase)),
    [tasks, taskId],
  );
  const [full, setFull] = useState<{ description: string; note: string } | null>(null);
  useEffect(() => {
    let live = true;
    setFull(null);
    fetchTask(taskId).then((t) => {
      if (live) setFull({ description: (t.description ?? '').trim(), note: (t.note ?? '').trim() });
    }).catch((err: unknown) => {
      log.warn('board', 'kanban card detail task not read', { taskId, error: err instanceof Error ? err.message : String(err) });
      if (live) setFull({ description: (task?.description ?? '').trim(), note: '' });
    });
    return () => { live = false; };
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  const description = full?.description ?? '';
  const note = full?.note ?? '';
  const empty = !!full && !description && !note && subtasks.length === 0;
  return (
    <div className="kanban-detail-task" data-testid="kanban-detail-task" aria-busy={full ? undefined : true}>
      {description && (
        <section className="kanban-detail-section">
          <h4 className="kanban-detail-heading">Description</h4>
          <p className="kanban-detail-text" data-testid="kanban-detail-description">{description}</p>
        </section>
      )}
      {note && (
        <section className="kanban-detail-section">
          <h4 className="kanban-detail-heading">Note</h4>
          <p className="kanban-detail-text" data-testid="kanban-detail-note">{note}</p>
        </section>
      )}
      {subtasks.length > 0 && (
        <section className="kanban-detail-section">
          <h4 className="kanban-detail-heading">Open subtasks ({subtasks.length})</h4>
          <ul className="kanban-detail-subtasks" data-testid="kanban-detail-subtasks">
            {subtasks.map((t) => <li key={t.id} title={t.title}>{t.title}</li>)}
          </ul>
        </section>
      )}
      {empty && <p className="kanban-detail-none" data-testid="kanban-detail-none">No session yet, and no description. Start worker gives it one.</p>}
    </div>
  );
}
