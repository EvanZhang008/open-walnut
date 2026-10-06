/**
 * G9 (C67): the frozen kanban layout (web/src/components/board/kanban/kanban-freeze.ts).
 * While frozen, cards keep their lane and place, new cards join the end of
 * their lane, gone ones leave; on release the cards that moved are named for
 * the `data-moved` flash.
 */
import { describe, expect, it } from 'vitest';
import { applyHolds, laneOf, mergeFrozen, movedCards, sameLayout } from '../../web/src/components/board/kanban/kanban-freeze';
import { withDrawnLanes } from '../../web/src/components/board/kanban/kanban-drawn';
import type { KanbanBoardVM } from '../../web/src/components/board/kanban/kanban-model';

describe('kanban freeze', () => {
  const frozen = { new: ['a', 'b'], investigating: ['c', 'd'], resolved: [] };

  it('nothing moves while frozen, even when the live layout reorders and changes lanes', () => {
    const live = { new: ['b'], investigating: ['d', 'c', 'a'], resolved: [] };
    expect(mergeFrozen(frozen, live)).toEqual(frozen);
  });

  it('a new card joins the end of its live lane; a gone card leaves', () => {
    const live = { new: ['a', 'b'], investigating: ['e', 'c'], resolved: [] };
    expect(mergeFrozen(frozen, live)).toEqual({ new: ['a', 'b'], investigating: ['c', 'e'], resolved: [] });
  });

  it("a deleted lane's cards go to their live lane; a new lane appears", () => {
    const live = { new: ['a', 'b', 'c', 'd'], mitigating: [], resolved: [] };
    expect(mergeFrozen(frozen, live)).toEqual({ new: ['a', 'b', 'c', 'd'], mitigating: [], resolved: [] });
  });

  it('moved cards: a lane change or a change of order, never a new card, never a mere index shift (N5)', () => {
    const next = { new: ['b'], investigating: ['c', 'd', 'a'], resolved: ['z'] };
    // b only shifted up because a left: it is not moved.
    expect(movedCards(frozen, next).sort()).toEqual(['a']);
    expect(movedCards(frozen, frozen)).toEqual([]);
    // One card arriving above twelve marks none of the twelve.
    const twelve = Array.from({ length: 12 }, (_, i) => `c${i}`);
    expect(movedCards({ inv: twelve }, { inv: ['x', ...twelve] })).toEqual([]);
    // One card moved from the bottom to the top is the one moved card.
    expect(movedCards({ inv: twelve }, { inv: ['c11', ...twelve.slice(0, 11)] })).toEqual(['c11']);
    // Two swapped: one of the two counts as moved, not the whole lane.
    expect(movedCards({ inv: ['a', 'b', 'c', 'd'] }, { inv: ['a', 'c', 'b', 'd'] })).toHaveLength(1);
  });

  it('sameLayout compares lanes and order', () => {
    expect(sameLayout(frozen, { ...frozen })).toBe(true);
    expect(sameLayout(frozen, { ...frozen, new: ['b', 'a'] })).toBe(false);
    expect(sameLayout(frozen, { new: ['a', 'b'], investigating: ['c', 'd'] })).toBe(false);
  });

  it('N1: a held lane keeps its cards; every other lane is live', () => {
    // The leader moved c from investigating to mitigating, and a moved to the top of new.
    const live = { new: ['b', 'a'], investigating: ['d'], mitigating: ['c'], resolved: [] };
    const held = applyHolds(live, new Map([['investigating', ['c', 'd']]]));
    expect(held).toEqual({ new: ['b', 'a'], investigating: ['c', 'd'], mitigating: [], resolved: [] });
    // The pointer rests on the empty target lane: the card arrives at once.
    expect(applyHolds(live, new Map([['mitigating', []]]))).toEqual(live);
    expect(applyHolds(live, new Map())).toBe(live);
    expect(laneOf(held, 'c')).toBe('investigating');
  });

  it('N1: a card arriving in a held lane joins its end; a gone card leaves', () => {
    const live = { new: [], investigating: ['e', 'c', 'x'], resolved: [] };
    expect(applyHolds(live, new Map([['investigating', ['c', 'd']]]))).toEqual({ new: [], investigating: ['c', 'e', 'x'], resolved: [] });
  });

  it('N1: lane counts follow the drawn layout and name the cards on their way', () => {
    const cards = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { taskId: id, needsYou: id === 'c', isComplete: false, loading: false }]));
    const vm = {
      cards,
      lanes: [
        { lane: { id: 'investigating', name: 'Investigating', kind: 'active' }, cardIds: ['a', 'b'], total: 2, needs: 0, openInDone: 0 },
        { lane: { id: 'mitigating', name: 'Mitigating', kind: 'active' }, cardIds: ['c'], total: 1, needs: 1, openInDone: 0 },
      ],
    } as unknown as KanbanBoardVM;
    const drawn = withDrawnLanes(vm, { investigating: ['a', 'b', 'c'], mitigating: [] });
    expect(drawn.lanes.map((l) => [l.lane.id, l.total, l.needs, l.incoming ?? 0])).toEqual([
      ['investigating', 3, 1, 0], ['mitigating', 0, 0, 1],
    ]);
    expect(withDrawnLanes(vm, { investigating: ['a', 'b'], mitigating: ['c'] })).toBe(vm);
    // Round 4: while the board loads nothing is drawn, so no lane says `13 incoming`.
    const loading = withDrawnLanes({ ...vm, loading: true } as KanbanBoardVM, { investigating: [], mitigating: [] });
    expect(loading.lanes.map((l) => l.incoming ?? 0)).toEqual([0, 0]);
  });
});
