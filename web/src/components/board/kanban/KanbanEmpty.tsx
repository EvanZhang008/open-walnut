/**
 * The board with no subtasks yet (spec 9): the lanes stay (the template), and
 * this card sits over them. The first todo lane's Add task opens focused
 * (BoardKanban); the pane adds its `Ask the leader for a page` row below
 * when there is no page.
 */
import type { ReactNode } from 'react';

export function KanbanEmpty({ children }: { children?: ReactNode }) {
  return (
    <div className="kanban-empty" data-testid="kanban-empty" role="status">
      <div className="kanban-empty-title">No tasks on this board yet.</div>
      <p className="kanban-empty-text">Add a task to a lane, or ask the leader to split the work.</p>
      {children}
    </div>
  );
}
