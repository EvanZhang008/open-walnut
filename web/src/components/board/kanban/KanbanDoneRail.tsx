/**
 * A wide board's done lane, folded to a 56px rail (spec 3.0): its name and
 * count written vertically. A click opens it as a normal lane (sessionStorage
 * per owner, useKanbanLayout); a card dropped on the rail goes into the lane.
 */
import { memo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { KanbanLaneVM } from './kanban-model';
import { cardsText, laneCountText } from './kanban-filter-model';

export interface KanbanDoneRailProps {
  lane: KanbanLaneVM;
  readOnly: boolean;
  dropOver: boolean;
  flashing: boolean;
  onOpen(): void;
}

function KanbanDoneRailInner({ lane, readOnly, dropOver, flashing, onOpen }: KanbanDoneRailProps) {
  const drop = useDroppable({ id: `lane:${lane.lane.id}`, data: { lane: lane.lane.id, rail: true }, disabled: readOnly });
  const open = lane.openInDone ? ` (${lane.openInDone} open)` : '';
  // R3-07: the same count as the head and the strip (`3 / 24` under a filter).
  const count = laneCountText(lane.total, lane.matched, lane.openInDone);
  return (
    <button
      ref={drop.setNodeRef}
      type="button"
      className={`kanban-done-rail kanban-kind-done${dropOver || drop.isOver ? ' is-over' : ''}`}
      data-testid="kanban-done-rail" data-lane-id={lane.lane.id} data-kanban-drop={`lane:${lane.lane.id}`} data-flash={flashing ? 'true' : undefined}
      aria-label={`${lane.lane.name}, ${cardsText(lane.total)}. Open the lane`}
      title={`${lane.lane.name}: ${cardsText(lane.total)}${open}. Click to open the lane`}
      onClick={onOpen}
    >
      <span className="kanban-done-rail-text">{lane.lane.name} {count}</span>
    </button>
  );
}

export const KanbanDoneRail = memo(KanbanDoneRailInner);
