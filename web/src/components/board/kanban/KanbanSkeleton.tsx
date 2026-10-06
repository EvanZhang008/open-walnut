/**
 * The Cards view before the board's first payload (spec 9, R3-06): never a
 * text-only blank moment. The rollup line says `Loading the team...` and four
 * lanes hold two grey skeleton cards each; a narrow pane stacks them as the
 * board's sections (the same container width rule as the board, 600px).
 */
import '@/styles/board-kanban.css';
import '@/styles/board-kanban-controls.css';

const LANES = 4;

function SkeletonCard() {
  return (
    <div className="kanban-card kanban-skeleton" data-testid="kanban-skeleton" aria-hidden="true">
      <div className="kanban-skeleton-bar" /><div className="kanban-skeleton-bar short" />
    </div>
  );
}

export function KanbanSkeleton() {
  return (
    <div className="board-kanban kanban-skeleton-board" data-testid="board-kanban-loading" aria-busy="true">
      <div className="kanban-root">
        <div className="kanban-skeleton-rollup" role="status">Loading the team...</div>
        <div className="kanban-skeleton-lanes">
          {Array.from({ length: LANES }, (_, i) => (
            <div key={i} className="kanban-skeleton-lane" data-testid="kanban-skeleton-lane">
              <div className="kanban-skeleton-head"><div className="kanban-skeleton-bar short" /></div>
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
