/**
 * G13 (C72, C33, C32): the kanban filter's state. A chip's members freeze when
 * it turns on: a card that stops matching stays (Handled) until the chip
 * changes, a new match joins, the centre line shows once the live count is 0,
 * and the search intersects with the chip. Also the seen baseline's pure
 * parts (useKanbanSeen.ts): what a write takes as shown.
 */
import { describe, expect, it } from 'vitest';
import type { KanbanCardVM } from '../../web/src/components/board/kanban/kanban-card-model';
import type { KanbanBoardVM } from '../../web/src/components/board/kanban/kanban-model';
import {
  filterMembers, filterView, liveCount, matchingIds,
} from '../../web/src/components/board/kanban/useKanbanFilter';
import { chipCounts } from '../../web/src/components/board/kanban/kanban-filter-model';
import { EMPTY_SUMMARY_HASH, overlaySeen, splitSnapshot } from '../../web/src/components/board/kanban/useKanbanSeen';
import { summaryHash } from '../../src/core/boards/board-lanes';

type CardBits = Partial<Pick<KanbanCardVM, 'needsYou' | 'running' | 'changed' | 'sev' | 'laneKind' | 'isComplete' | 'loading' | 'summary' | 'waiting' | 'ticket'>> & { stale?: boolean };

function card(taskId: string, title: string, bits: CardBits = {}): KanbanCardVM {
  return {
    taskId, title, lane: bits.laneKind === 'done' ? 'resolved' : 'investigating', laneKind: bits.laneKind ?? 'active',
    source: 'auto', completedAfterMove: false, status: { text: '', tone: bits.needsYou ? 'red' : 'grey', kind: 'idle', tooltip: '' },
    needsYou: !!bits.needsYou, running: !!bits.running, activity: '', hasSession: true, isComplete: !!bits.isComplete,
    foot: { activeText: '', activeTooltip: '', unread: false, ...(bits.stale ? { stale: 'Stale 3d' } : {}) },
    changed: !!bits.changed, createdAt: '2026-10-01T08:00:00.000Z', doneAt: '', loading: !!bits.loading,
    snapshot: { lane: 'investigating', summaryHash: '' },
    ...(bits.sev ? { sev: bits.sev } : {}), ...(bits.summary ? { summary: bits.summary } : {}),
    ...(bits.waiting ? { waiting: bits.waiting } : {}), ...(bits.ticket ? { ticket: bits.ticket } : {}),
  } as KanbanCardVM;
}

function board(cards: KanbanCardVM[], stillOpen = 0): Pick<KanbanBoardVM, 'cards' | 'chips' | 'rollup'> {
  const byId = Object.fromEntries(cards.map((c) => [c.taskId, c]));
  return { cards: byId, chips: chipCounts(cards), rollup: { stillOpen } as KanbanBoardVM['rollup'] };
}

const T = (n: number) => `V${1000000100 + n}`;

describe('kanban filter: frozen membership (G13)', () => {
  it('a handled card stays visible and is marked handled until the chip changes', () => {
    const before = board([card('a', T(1), { needsYou: true }), card('b', T(2), { needsYou: true }), card('c', T(3))]);
    let state = filterMembers(null, 'needs', matchingIds(before, 'needs'));
    expect([...state.members!].sort()).toEqual(['a', 'b']);
    // The user answers a's prompt: a stops matching.
    const after = board([card('a', T(1)), card('b', T(2), { needsYou: true }), card('c', T(3))]);
    const matching = matchingIds(after, 'needs');
    state = filterMembers(state, 'needs', matching);
    const view = filterView(after, state, matching, '');
    expect([...view.visible].sort()).toEqual(['a', 'b']);
    expect([...view.handled]).toEqual(['a']);
    expect(view.emptyText).toBe('');
  });

  it('a new match joins the members', () => {
    const b0 = board([card('a', T(1), { needsYou: true }), card('c', T(3))]);
    let state = filterMembers(null, 'needs', matchingIds(b0, 'needs'));
    const b1 = board([card('a', T(1), { needsYou: true }), card('c', T(3), { needsYou: true })]);
    const m1 = matchingIds(b1, 'needs');
    state = filterMembers(state, 'needs', m1);
    expect([...filterView(b1, state, m1, '').visible].sort()).toEqual(['a', 'c']);
  });

  it('once the live count is 0 the centre line says so, and the handled cards stay', () => {
    const b0 = board([card('a', T(1), { needsYou: true })]);
    let state = filterMembers(null, 'needs', matchingIds(b0, 'needs'));
    const b1 = board([card('a', T(1))]);
    const m1 = matchingIds(b1, 'needs');
    state = filterMembers(state, 'needs', m1);
    const view = filterView(b1, state, m1, '');
    expect(view.emptyText).toBe('Nothing needs you now');
    expect([...view.visible]).toEqual(['a']);
    expect([...view.handled]).toEqual(['a']);
  });

  it('another chip, or turning it off, starts over', () => {
    const b0 = board([card('a', T(1), { needsYou: true }), card('r', T(4), { running: true })]);
    let state = filterMembers(null, 'needs', matchingIds(b0, 'needs'));
    const b1 = board([card('a', T(1)), card('r', T(4), { running: true })]);
    state = filterMembers(state, 'running', matchingIds(b1, 'running'));
    expect([...state.members!]).toEqual(['r']);
    expect(filterMembers(state, null, new Set()).members).toBeNull();
    state = filterMembers({ chip: null, members: null }, 'needs', matchingIds(b1, 'needs'));
    expect(state.members!.size).toBe(0);
    const view = filterView(b1, state, matchingIds(b1, 'needs'), '');
    expect(view.visible.size).toBe(0);
    expect(view.emptyText).toBe('Nothing needs you now');
  });

  it('no chip and no query shows every card', () => {
    const b = board([card('a', T(1)), card('b', T(2), { laneKind: 'done', isComplete: true })]);
    const view = filterView(b, filterMembers(null, null, new Set()), new Set(), '');
    expect(view.visible.size).toBe(2);
    expect(view.handled.size).toBe(0);
    expect(view.emptyText).toBe('');
  });
});

describe('kanban filter: search and the other chips', () => {
  const cards = [
    card('a', `${T(7)} payout mismatch`, { ticket: { tag: `ticket:${T(7)}`, value: T(7) }, needsYou: true }),
    card('b', `${T(8)} ledger export lag`, { summary: { text: 'Rolled the retry budget back', source: 'task', tooltip: '' } }),
    card('w', `${T(9)} card auth declines`, { laneKind: 'wait', waiting: { kind: 'text', text: 'CR-48213' }, stale: true }),
    card('d', `${T(10)} settled`, { laneKind: 'done', isComplete: false }),
  ];
  const b = board(cards, 1);

  it('matches the title, the ticket, the summary shown and the waiting on shown, case blind', () => {
    const none = filterMembers(null, null, new Set());
    expect([...filterView(b, none, new Set(), T(7).toLowerCase()).visible]).toEqual(['a']);
    expect([...filterView(b, none, new Set(), 'RETRY budget').visible]).toEqual(['b']);
    expect([...filterView(b, none, new Set(), 'cr-48213').visible]).toEqual(['w']);
    expect(filterView(b, none, new Set(), '   ').visible.size).toBe(4);
  });

  it('intersects the search with the chip', () => {
    const m = matchingIds(b, 'needs');
    const s = filterMembers(null, 'needs', m);
    expect([...filterView(b, s, m, T(7)).visible]).toEqual(['a']);
    expect(filterView(b, s, m, T(8)).visible.size).toBe(0);
  });

  it('stale, and the rollup still open filter, use their own live numbers', () => {
    expect([...matchingIds(b, 'stale')]).toEqual(['w']);
    expect([...matchingIds(b, 'still-open')]).toEqual(['d']);
    expect(liveCount(b, 'still-open')).toBe(1);
    expect(liveCount(b, 'needs')).toBe(1);
    expect(liveCount(b, 'running')).toBe(0);
  });

  it('a loading card never matches a chip', () => {
    const lb = board([card('l', 'Loading', { loading: true, needsYou: true })]);
    expect(matchingIds(lb, 'needs').size).toBe(0);
  });
});

describe('kanban filter: one board project', () => {
  const dns = { id: 'dns', title: 'DNS timeouts', status: null };
  const quota = { id: 'quota', title: 'Quota alarms', status: null };
  const projectOf = new Map([['a', dns], ['b', dns], ['c', quota]]);
  const b = board([card('a', T(1), { needsYou: true }), card('b', T(2)), card('c', T(3), { needsYou: true }), card('d', T(4))]);

  it('shows only the cards the Projects view places in that project', () => {
    const none = filterMembers(null, null, new Set());
    expect([...filterView(b, none, new Set(), '', 'dns', projectOf).visible].sort()).toEqual(['a', 'b']);
    expect([...filterView(b, none, new Set(), '', 'quota', projectOf).visible]).toEqual(['c']);
    expect([...filterView(b, none, new Set(), '', null, projectOf).visible].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('intersects with a chip and the search', () => {
    const matching = matchingIds(b, 'needs');
    const state = filterMembers(null, 'needs', matching);
    expect([...filterView(b, state, matching, '', 'dns', projectOf).visible]).toEqual(['a']);
    expect([...filterView(b, filterMembers(null, null, new Set()), new Set(), T(2), 'dns', projectOf).visible]).toEqual(['b']);
  });

  it('a project with no cards on this board shows none', () => {
    expect(filterView(b, filterMembers(null, null, new Set()), new Set(), '', 'gone', projectOf).visible.size).toBe(0);
  });
});

describe('kanban seen: what the browser writes as shown (8.4)', () => {
  it('the empty summary hash is summaryHash of an empty text', () => {
    expect(EMPTY_SUMMARY_HASH).toBe(summaryHash(''));
  });

  it('a card shown without a summary is left to the server, the others are taken as shown', () => {
    const shown = {
      a: { lane: 'investigating', summaryHash: summaryHash('Queue drained') },
      b: { lane: 'mitigating', summaryHash: summaryHash(''), unread: true },
    };
    expect(splitSnapshot(shown)).toEqual({ snapshot: { a: shown.a }, unsure: ['b'] });
  });

  it('overlays restart the baseline or add entries on top of it', () => {
    const base = { at: '2026-01-05T10:00:00.000Z', cards: { a: { lane: 'new', summaryHash: 'x' } } };
    const added = overlaySeen(base, [{ id: 1, cards: { b: { lane: 'new', summaryHash: 'y' } }, answered: false }]);
    expect(Object.keys(added?.cards ?? {}).sort()).toEqual(['a', 'b']);
    const restarted = overlaySeen(base, [{ id: 2, cards: { c: { lane: 'new', summaryHash: 'z' } }, restartAt: '2026-01-05T11:00:00.000Z', answered: false }]);
    expect(restarted).toEqual({ at: '2026-01-05T11:00:00.000Z', previous_at: base.at, cards: { c: { lane: 'new', summaryHash: 'z' } } });
  });
});
