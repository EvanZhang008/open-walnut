/**
 * One lane (spec 3.1, 3.2, 7.3, 7.4, 9): a column in wide mode (its own
 * vertical scroll, sticky head), a foldable section in narrow mode. The head
 * is P4's KanbanLaneHead wrapped as a drop target (dropped there = first); the
 * body is the lane's drop target (empty area = last). A done lane shows its 5
 * newest cards until `Show all N` (sessionStorage), every match while a filter
 * is on. Empty: `Nothing here`, or `No matching cards` under a filter. Loading:
 * two skeleton cards.
 */
import { Fragment, memo, type ReactElement } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { BoardLane } from '../../../../../src/core/boards/board-lanes';
import { DONE_LANE_PREVIEW, type KanbanMode, type KanbanWriteApi } from './kanban-contract';
import type { KanbanCardVM } from './kanban-card-model';
import type { KanbanLaneVM } from './kanban-model';
import { cardsText } from './kanban-filter-model';
import type { DeletePreview } from '../../../../../src/core/boards/board-lanes';
import { KanbanCard } from './KanbanCard';
import { KanbanLaneHead } from './KanbanLaneHead';
import { KanbanAddTask } from './KanbanAddTask';
import type { PendingAdd } from './useKanbanWrites';

export interface KanbanLaneProps {
  lane: KanbanLaneVM;
  /** This lane's cards in the order drawn (the freeze's), before the filter. */
  order: readonly string[];
  cards: Readonly<Record<string, KanbanCardVM>>;
  lanes: readonly BoardLane[];
  index: number;
  mode: KanbanMode;
  folded: boolean;
  onToggleFold(): void;
  api: KanbanWriteApi;
  deletePreview(laneId: string): DeletePreview;
  flashing: boolean;
  /** null = no filter; else is the card shown. */
  visible: ((taskId: string) => boolean) | null;
  isHandled(taskId: string): boolean;
  /** A chip's live count is 0: the centre line speaks instead of each lane. */
  filterEmpty: boolean;
  tabStop: string | null;
  moved: ReadonlySet<string>;
  flash: ReadonlySet<string>;
  /** The drop line in this lane: before this card, or null = at the end; undefined = none. */
  dropBefore: string | null | undefined;
  dropOver: boolean;
  draggingId: string | null;
  showAll: boolean;
  onShowAll(all: boolean): void;
  pending: readonly PendingAdd[];
  loading: boolean;
  /** Empty board: this lane's Add task opens focused (spec 9). */
  autoAdd: boolean;
  /** Wide done lane that was opened from its rail: offer folding it back. */
  onFoldRail?: () => void;
  /** N3: the card a keyboard drag holds (drawn lifted where it was) and, in the target lane, its title at the line. */
  keyDragId?: string | null;
  keyGhost?: string | null;
  reducedMotion?: boolean;
}

function KanbanLaneInner(p: KanbanLaneProps) {
  const { lane: vm, mode } = p;
  const lane = vm.lane;
  const head = useDroppable({ id: `head:${lane.id}`, data: { lane: lane.id, head: true }, disabled: p.api.readOnly });
  const body = useDroppable({ id: `lane:${lane.id}`, data: { lane: lane.id }, disabled: p.api.readOnly });
  const shownIds = p.visible ? p.order.filter((id) => p.visible!(id) || p.isHandled(id)) : [...p.order];
  const done = lane.kind === 'done';
  const limited = done && !p.visible && !p.showAll && shownIds.length > DONE_LANE_PREVIEW;
  const drawn = limited ? shownIds.slice(0, DONE_LANE_PREVIEW) : shownIds;
  const filtered = p.visible ? shownIds.length : undefined;

  // R3-15: the keyboard drag shows the same copy of the card as a pointer drag's overlay.
  const ghostVm = p.keyGhost != null && p.keyDragId ? p.cards[p.keyDragId] : undefined;
  const ghost = p.keyGhost != null ? (
    <div key="key-ghost" className={`kanban-drag-overlay kanban-key-ghost${p.reducedMotion ? '' : ' is-tilted'}`} data-testid="kanban-key-ghost" aria-hidden="true">
      {ghostVm ? <KanbanCard vm={ghostVm} laneName={lane.name} tabStop={false} overlay />
        : <div className="kanban-card"><div className="kanban-card-title">{p.keyGhost}</div></div>}
    </div>
  ) : null;
  // The line stays the card's direct sibling (the drop is `line + card`); the ghost, when any, follows it.
  const line = (key: string): ReactElement => (
    <Fragment key={key}>
      <div className="kanban-drop-line" data-testid="kanban-drop-line" aria-hidden="true" />
      {ghost}
    </Fragment>
  );
  const items: ReactElement[] = [];
  for (const id of drawn) {
    const card = p.cards[id];
    if (!card) continue;
    if (p.dropBefore === id) items.push(line(`line-${id}`));
    items.push(
      <KanbanCard
        key={id} vm={card} laneName={lane.name} drawnIn={lane.id} tabStop={p.tabStop === id} handled={!!p.visible && p.isHandled(id)}
        moved={p.moved.has(id)} flash={p.flash.has(id)} lifted={p.keyDragId === id}
      />,
    );
  }
  if (p.dropBefore === null) items.push(line('line-end'));

  return (
    <section
      className={`kanban-lane kanban-kind-${lane.kind}${p.folded ? ' is-folded' : ''}${p.dropOver ? ' is-over' : ''}`}
      data-testid="kanban-lane" data-lane-id={lane.id} data-kind={lane.kind} data-mode={mode}
      data-folded={p.folded ? 'true' : undefined} aria-label={`${lane.name}, ${cardsText(vm.total)}`}
    >
      <div ref={head.setNodeRef} className={`kanban-lane-head-wrap${head.isOver ? ' is-over' : ''}`} data-kanban-drop={`head:${lane.id}`} data-flash={p.flashing ? 'true' : undefined}>
        <KanbanLaneHead
          lane={vm} lanes={p.lanes} index={p.index} mode={mode} folded={p.folded} onToggleFold={p.onToggleFold}
          {...(filtered !== undefined ? { shown: filtered } : {})}
          api={p.api} flashing={p.flashing} deletePreview={p.deletePreview}
        />
      </div>
      {!p.folded && (
        <div ref={body.setNodeRef} className="kanban-lane-body" data-testid="kanban-lane-body" data-lane-id={lane.id} data-kanban-drop={`lane:${lane.id}`}>
          {p.loading && drawn.length === 0 ? (
            <>
              <div className="kanban-card kanban-skeleton" data-testid="kanban-skeleton" aria-hidden="true"><div className="kanban-skeleton-bar" /><div className="kanban-skeleton-bar short" /></div>
              <div className="kanban-card kanban-skeleton" data-testid="kanban-skeleton" aria-hidden="true"><div className="kanban-skeleton-bar" /><div className="kanban-skeleton-bar short" /></div>
            </>
          ) : items}
          {p.pending.map((a) => (
            <div key={a.key} className="kanban-card kanban-card-pending" data-testid="kanban-card-pending" aria-busy="true">
              <div className="kanban-card-title" title={a.title}>{a.title}</div>
              <div className="kanban-card-status kanban-tone-grey"><span className="kanban-card-dot" aria-hidden="true" /><span className="kanban-card-status-text">Adding...</span></div>
            </div>
          ))}
          {!p.loading && drawn.length === 0 && p.pending.length === 0 && !p.filterEmpty && (
            <div className="kanban-lane-empty" data-testid="kanban-lane-empty">{p.visible ? 'No matching cards' : 'Nothing here'}</div>
          )}
          {done && !p.visible && shownIds.length > DONE_LANE_PREVIEW && (
            <button type="button" className="kanban-text-btn kanban-lane-show-all" data-testid="kanban-lane-show-all"
              onClick={() => p.onShowAll(!p.showAll)}>{p.showAll ? 'Show fewer' : `Show all ${shownIds.length}`}</button>
          )}
          {p.onFoldRail && (
            <button type="button" className="kanban-text-btn kanban-done-fold" data-testid="kanban-done-fold" onClick={p.onFoldRail}>Fold to the rail</button>
          )}
          <KanbanAddTask laneId={lane.id} laneName={lane.name} api={p.api} autoFocus={p.autoAdd} />
        </div>
      )}
    </section>
  );
}

export const KanbanLane = memo(KanbanLaneInner);
