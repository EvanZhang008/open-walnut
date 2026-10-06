/**
 * The kanban's optimistic layer (web/src/components/board/kanban/kanban-overlay.ts),
 * spec 8.3 and G32 (C92): last write per card wins, a failure removes the
 * overlay, a success keeps it until a read that STARTED after the response
 * lands, whatever that read says, and moves lay rank and placement over the
 * payload.
 */
import { describe, expect, it } from 'vitest';
import {
  LANES_KEY, applyOverlays, dropOverlay, markResponded, moveCardPatches, putOverlay, releaseOverlays,
  releaseTaskOverlays, setCardPatch, type KanbanOverlay,
} from '../../web/src/components/board/kanban/kanban-overlay';
import { templateLanes, type BoardCard } from '../../src/core/boards/board-lanes';

const lanes = templateLanes('triage');
const base = { cards: { a: { lane: 'new', lane_by: 'human' } as BoardCard }, lanes, team: [{ id: 'a', phase: 'TODO' }, { id: 'b', phase: 'TODO' }] };
const ov = (key: string, seq: number, extra: Partial<KanbanOverlay> = {}): KanbanOverlay => ({ key, seq, startedAt: 1000 + seq, ...extra });

describe('kanban overlays', () => {
  it('the newer write on a card replaces the older one (last write wins)', () => {
    let m = putOverlay(new Map(), ov('a', 1, { cards: { a: { lane: 'mitigating' } } }));
    m = putOverlay(m, ov('a', 2, { cards: { a: { lane: 'waiting-cr' } } }));
    expect(applyOverlays(base, m).cards.a.lane).toBe('waiting-cr');
    // The first write's late answer cannot touch the second's overlay.
    expect(markResponded(m, 'a', 1, 5000)).toBeNull();
    expect(dropOverlay(m, 'a', 1)).toBeNull();
  });

  it('a failed write removes its overlay: the payload shows again', () => {
    const m = putOverlay(new Map(), ov('a', 1, { cards: { a: { lane: 'mitigating' } } }));
    const next = dropOverlay(m, 'a', 1);
    expect(next?.size).toBe(0);
    expect(applyOverlays(base, next ?? new Map()).cards.a.lane).toBe('new');
  });

  it('G32: a success is released only by a read that started after the response, whatever it says', () => {
    let m: Map<string, KanbanOverlay> = putOverlay(new Map(), ov('a', 1, { cards: { a: { lane: 'mitigating' } } }));
    m = markResponded(m, 'a', 1, 5000) ?? m;
    // A read that started before the response does not release (it may not contain the write).
    expect(releaseOverlays(m, 4999)).toBeNull();
    expect(releaseOverlays(m, 5000)).toBeNull();
    // A read that started after it does, even when another window already overwrote the card.
    const released = releaseOverlays(m, 5001);
    expect(released?.size).toBe(0);
    const otherWindow = { ...base, cards: { a: { lane: 'waiting-others', lane_by: 'human' } as BoardCard } };
    expect(applyOverlays(otherWindow, released ?? new Map()).cards.a.lane).toBe('waiting-others');
  });

  it('an overlay still in flight (no response) is never released by a read', () => {
    const m = putOverlay(new Map(), ov('a', 1, { cards: { a: { lane: 'mitigating' } } }));
    expect(releaseOverlays(m, 999_999)).toBeNull();
  });

  it('a phase overlay waits for the task store too, or a grace period', () => {
    let m: Map<string, KanbanOverlay> = putOverlay(new Map(), ov('a', 1, { tasks: { a: { phase: 'COMPLETE', completed_at: '2026-10-03T10:00:00Z' } } }));
    m = markResponded(m, 'a', 1, 5000) ?? m;
    expect(releaseOverlays(m, 6000)).toBeNull();
    expect(releaseTaskOverlays(m, () => 'TODO', 6000, 6000)).toBeNull();
    expect(releaseTaskOverlays(m, () => 'COMPLETE', 6000, 6000)?.size).toBe(0);
    expect(releaseTaskOverlays(m, () => 'TODO', 6000, 11_001)?.size).toBe(0);
    const out = applyOverlays(base, m);
    expect(out.team.find((e) => e.id === 'a')).toEqual({ id: 'a', phase: 'COMPLETE', completed_at: '2026-10-03T10:00:00Z' });
    expect(out.tasks.a.phase).toBe('COMPLETE');
  });

  it('a lanes write lays the whole lane list over the payload', () => {
    const renamed = lanes.map((l) => (l.id === 'waiting-others' ? { ...l, name: 'Waiting on partner team' } : l));
    const m = putOverlay(new Map(), ov(LANES_KEY, 1, { lanes: renamed }));
    expect(applyOverlays(base, m).lanes.find((l) => l.id === 'waiting-others')?.name).toBe('Waiting on partner team');
  });
});

describe('move and card patches', () => {
  const now = '2026-10-03T10:00:00.000Z';
  it('a move places the card by the human and ranks the whole lane order', () => {
    const p = moveCardPatches('b', 'waiting-cr', ['x', 'b', 'y'], { nowIso: now });
    expect(p.b).toMatchObject({ lane: 'waiting-cr', lane_by: 'human', lane_at: now, rank: 1, rank_lane: 'waiting-cr' });
    expect('lane_suggested' in p.b && p.b.lane_suggested === undefined).toBe(true);
    expect(p.x).toEqual({ rank: 0, rank_lane: 'waiting-cr' });
    const out = applyOverlays({ ...base, cards: { b: { lane_suggested: { lane: 'new', by: 'l', at: now } } } }, putOverlay(new Map(), ov('b', 1, { cards: p })));
    expect(out.cards.b.lane_suggested).toBeUndefined();
    expect(out.cards.y).toEqual({ rank: 2, rank_lane: 'waiting-cr' });
  });

  it('rank only (same lane) leaves the placement alone', () => {
    const p = moveCardPatches('b', 'investigating', ['b', 'x'], { rankOnly: true, nowIso: now });
    expect(p.b).toEqual({ rank: 0, rank_lane: 'investigating' });
  });

  it('a done lane takes no rank (G26)', () => {
    const p = moveCardPatches('b', 'resolved', ['b', 'x'], { doneLane: true, nowIso: now });
    expect(p.x).toBeUndefined();
    expect(p.b).toMatchObject({ lane: 'resolved', rank: undefined });
  });

  it("'' clears a field; lane '' goes back to automatic", () => {
    expect(setCardPatch({ lane: '' }, now)).toEqual({ lane: undefined, lane_at: undefined, lane_by: undefined, rank: undefined, rank_lane: undefined });
    expect(setCardPatch({ summary: 'Short', waiting_on: '' }, now)).toEqual({
      summary: 'Short', summary_at: now, summary_by: 'human', waiting_on: undefined, waiting_on_at: undefined, waiting_on_by: undefined,
    });
    const out = applyOverlays(base, putOverlay(new Map(), ov('a', 1, { cards: { a: setCardPatch({ lane: '' }, now) } })));
    expect(out.cards.a).toEqual({});
  });
});
