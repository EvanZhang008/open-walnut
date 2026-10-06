/**
 * N1: lane counts follow the cards drawn. A held lane (kanban-freeze) can keep a
 * card that live data already moved; the heads, the strip and the rail then
 * count what is on screen, and the lane the card is headed for says how many
 * are on their way (`incoming`). Pure; unit-pinned in tests/web/kanban-freeze.test.ts.
 */
import type { KanbanLayout } from './kanban-freeze';
import type { KanbanBoardVM, KanbanLaneVM } from './kanban-model';

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The board's lanes as drawn: order, totals, needs and open-in-done from the drawn layout. */
export function withDrawnLanes(vm: KanbanBoardVM, layout: KanbanLayout): KanbanBoardVM {
  let changed = false;
  const lanes = vm.lanes.map((l): KanbanLaneVM => {
    const ids = layout[l.lane.id];
    if (!ids || sameIds(ids, l.cardIds)) return l;
    changed = true;
    const drawn = new Set(ids);
    const cards = ids.map((id) => vm.cards[id]).filter((c) => !!c);
    // While the board loads nothing is drawn yet: no card is on its way anywhere.
    const incoming = vm.loading ? 0 : l.cardIds.filter((id) => !drawn.has(id)).length;
    return {
      ...l,
      cardIds: [...ids],
      total: cards.length,
      needs: cards.filter((c) => c.needsYou).length,
      openInDone: l.lane.kind === 'done' ? cards.filter((c) => !c.isComplete && !c.loading).length : 0,
      ...(incoming ? { incoming } : {}),
    };
  });
  return changed ? { ...vm, lanes } : vm;
}
