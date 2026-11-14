/**
 * The kanban's fixed header above the lanes: the rollup line, the question
 * chips with the search, and (wide mode) the lane strip. It never scrolls
 * with the lanes (the container keeps it out of the lanes' scroller).
 */
import '@/styles/board-kanban-controls.css';
import type { KanbanHeaderProps } from './kanban-contract';
import { KanbanFilters } from './KanbanFilters';
import { KanbanLaneStrip } from './KanbanLaneStrip';
import { KanbanRollup } from './KanbanRollup';

export function KanbanHeader({ board, filter, seen, mode, onJumpToLane, onRevealCard, onOpenTask, searchRef }: KanbanHeaderProps) {
  return (
    <div className={`kanban-header is-${mode}`} data-testid="kanban-header" data-mode={mode}>
      <KanbanRollup board={board} filter={filter} mode={mode} onOpenTask={onOpenTask} />
      <KanbanFilters board={board} filter={filter} seen={seen} mode={mode} searchRef={searchRef} onRevealCard={onRevealCard} />
      {mode === 'wide' && board.lanes.length > 0 && <KanbanLaneStrip board={board} onJumpToLane={onJumpToLane} isVisible={filter.active ? (t) => filter.isVisible(t) || filter.isHandled(t) : null} />}
    </div>
  );
}
