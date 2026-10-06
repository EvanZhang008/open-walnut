/**
 * The wide mode lane strip (spec 3.0, G1): one line under the chips naming
 * every lane with its count and, in red, how many of its cards need the user
 * (`Investigating 4 (1)`), so a ~700px pane that shows 2.5 lanes still answers
 * every lane without a sideways scroll. Each item scrolls its lane into view.
 * Items that do not fit fold into `+N`, which jumps to the first folded lane.
 * The widths come from an invisible measuring copy of the row.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { KanbanBoardVM, KanbanLaneVM } from './kanban-model';
import { cardsText, filteredLane, laneCountText } from './kanban-filter-model';

export interface KanbanLaneStripProps {
  board: KanbanBoardVM;
  onJumpToLane(laneId: string): void;
  /** The active chip or search (R3-07): counts are the matched ones, as on the lane heads. */
  isVisible?: ((id: string) => boolean) | null;
}

const MORE_WIDTH = 44;

/** How many items fit in `width`, keeping room for the `+N` button when some do not. */
export function stripFit(widths: readonly number[], width: number, gap = 0): number {
  const total = widths.reduce((a, w, i) => a + w + (i ? gap : 0), 0);
  if (total <= width) return widths.length;
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + widths[i] + (i ? gap : 0);
    if (next + MORE_WIDTH > width) return Math.max(1, i);
    used = next;
  }
  return widths.length;
}

function Item({ lane, onJump }: { lane: KanbanLaneVM; onJump?: (id: string) => void }) {
  return (
    <button
      type="button"
      className="kanban-lane-strip-item"
      data-testid={onJump ? 'kanban-lane-strip-item' : undefined}
      data-lane-id={lane.lane.id}
      data-kind={lane.lane.kind}
      tabIndex={onJump ? 0 : -1}
      aria-label={lane.needs ? `${lane.lane.name}, ${cardsText(lane.total)}, ${lane.needs} need${lane.needs === 1 ? 's' : ''} you` : `${lane.lane.name}, ${cardsText(lane.total)}`}
      title={`Show ${lane.lane.name}`}
      onClick={onJump ? () => onJump(lane.lane.id) : undefined}
    >
      <span className="kanban-lane-strip-name">{lane.lane.name}</span>{' '}
      {/* R3-07, R3-09: the head's count (`0 / 13`, `24 (1 open)`). */}
      <span className="kanban-lane-strip-count">{laneCountText(lane.total, lane.matched, lane.openInDone)}</span>
      {lane.needs > 0 && <>{' '}<span className="kanban-lane-strip-needs">({lane.needs})</span></>}
    </button>
  );
}

export function KanbanLaneStrip({ board, onJumpToLane, isVisible = null }: KanbanLaneStripProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const lanes = board.lanes.map((l) => filteredLane(l, board.cards, isVisible));
  const [fit, setFit] = useState(lanes.length);
  const key = lanes.map((l) => `${l.lane.id}:${l.lane.name}:${l.total}:${l.matched ?? ''}:${l.openInDone}:${l.needs}`).join('|');

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const update = () => {
      const items = [...measure.querySelectorAll<HTMLElement>('.kanban-lane-strip-item')];
      // Each measured item already carries its separator (CSS ::before on all but the first).
      setFit(stripFit(items.map((el) => el.offsetWidth), row.clientWidth));
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(row);
    return () => ro?.disconnect();
  }, [key]);

  const shown = lanes.slice(0, fit);
  const folded = lanes.slice(fit);
  return (
    <div className="kanban-lane-strip" data-testid="kanban-lane-strip" ref={rowRef} role="navigation" aria-label="Lanes">
      <div className="kanban-lane-strip-measure" ref={measureRef} aria-hidden>
        {lanes.map((l) => <Item key={l.lane.id} lane={l} />)}
      </div>
      {shown.map((l) => <Item key={l.lane.id} lane={l} onJump={onJumpToLane} />)}
      {folded.length > 0 && (
        <button
          type="button"
          className="kanban-lane-strip-more"
          data-testid="kanban-lane-strip-more"
          title={folded.map((l) => `${l.lane.name} ${laneCountText(l.total, l.matched, l.openInDone)}`).join(', ')}
          onClick={() => onJumpToLane(folded[0].lane.id)}
        >+{folded.length}</button>
      )}
    </div>
  );
}
