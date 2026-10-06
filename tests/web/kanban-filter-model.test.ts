/**
 * Chips and search of the kanban (web/src/components/board/kanban/kanban-filter-model.ts):
 * what each chip matches (C14, C29, C80), search over the shown text only
 * (C32, C35, C76), counts, texts (C33) and the frozen membership (G13, C72).
 */
import { describe, expect, it } from 'vitest';
import {
  chipCounts, chipTooltip, emptyTextFor, filteredLane, handledIds, laneCountText, matchesChip, matchesSearch, nextMembers, sevChipShown,
} from '../../web/src/components/board/kanban/kanban-filter-model';
import type { KanbanCardVM } from '../../web/src/components/board/kanban/kanban-card-model';

type C = Pick<KanbanCardVM, 'needsYou' | 'sev' | 'laneKind' | 'foot' | 'changed' | 'running' | 'isComplete' | 'loading'
  | 'title' | 'ticket' | 'summary' | 'waiting'>;
const card = (p: Partial<C> = {}): C => ({
  needsYou: false, laneKind: 'active', foot: { activeText: '', activeTooltip: '', unread: false }, changed: false,
  running: false, isComplete: false, loading: false, title: 'Checkout latency', ...p,
});

describe('chips', () => {
  it('each chip matches its own rule; a loading card matches none', () => {
    expect(matchesChip(card({ needsYou: true }), 'needs')).toBe(true);
    expect(matchesChip(card({ sev: '1' }), 'sev1')).toBe(true);
    expect(matchesChip(card({ sev: '1', laneKind: 'done' }), 'sev1')).toBe(false);
    expect(matchesChip(card({ foot: { activeText: '', activeTooltip: '', unread: false, stale: 'Stale 3d' } }), 'stale')).toBe(true);
    expect(matchesChip(card({ changed: true }), 'changed')).toBe(true);
    expect(matchesChip(card({ running: true }), 'running')).toBe(true);
    expect(matchesChip(card({ laneKind: 'done' }), 'still-open')).toBe(true);
    expect(matchesChip(card({ laneKind: 'done', isComplete: true }), 'still-open')).toBe(false);
    expect(matchesChip(card({ needsYou: true, loading: true }), 'needs')).toBe(false);
  });

  it('counts, with the leader in Needs you', () => {
    const counts = chipCounts([card({ needsYou: true }), card({ running: true, changed: true }), card({ sev: '1' })], true);
    expect(counts).toEqual({ needs: 2, sev1: 1, stale: 0, changed: 1, running: 1 });
  });

  it('the Sev 1 chip shows only with more than one sev value among open cards', () => {
    expect(sevChipShown([card({ sev: '2' }), card({ sev: '2' })])).toBe(false);
    expect(sevChipShown([card({ sev: '2' }), card({ sev: '1' })])).toBe(true);
    expect(sevChipShown([card({ sev: '2' }), card({ sev: '1', laneKind: 'done' })])).toBe(false);
    // N13: two sev values but no open Sev 1: no chip.
    expect(sevChipShown([card({ sev: '2' }), card({ sev: '3' })])).toBe(false);
  });

  it('empty and tooltip texts', () => {
    expect(emptyTextFor('needs')).toBe('Nothing needs you now');
    expect(emptyTextFor('stale')).toBe('Nothing is stale now');
    expect(emptyTextFor('changed')).toBe('Nothing changed now');
    expect(emptyTextFor('running')).toBe('No worker is running now');
    expect(chipTooltip('needs', 0)).toBe('Nothing needs you');
    expect(chipTooltip('stale', 0)).toBe('Nothing is stale');
    expect(chipTooltip('running', 0)).toBe('No worker is running');
    const at = new Date(2026, 9, 3, 8, 30).toISOString();
    const now = new Date(2026, 9, 3, 9, 0).getTime();
    expect(chipTooltip('changed', 0, at, now)).toBe('Nothing changed since you last looked (08:30)');
    expect(chipTooltip('changed', 6, at, now)).toBe('Changed since you last looked (08:30)');
  });
});

describe('search', () => {
  it('matches title, ticket value, the shown summary and the shown waiting on, ignoring case', () => {
    const c = card({ ticket: { tag: 'ticket:V1000000107', value: 'V1000000107' }, summary: { text: 'Retry storm in checkout', source: 'task', tooltip: '' },
      waiting: { kind: 'text', text: 'CR-48213' } });
    expect(matchesSearch(c, 'v1000000107')).toBe(true);
    expect(matchesSearch(c, 'STORM')).toBe(true);
    expect(matchesSearch(c, 'cr-48213')).toBe(true);
    expect(matchesSearch(c, 'latency')).toBe(true);
    expect(matchesSearch(c, '  ')).toBe(true);
    expect(matchesSearch(c, 'nothing like it')).toBe(false);
    // A card moved out of a wait lane keeps the value but does not show it, so search does not find it.
    expect(matchesSearch({ ...c, waiting: undefined }, 'CR-48213')).toBe(false);
  });
});

describe('frozen membership (G13)', () => {
  it('a card that stops matching stays as Handled; new matches join', () => {
    let members = nextMembers(null, ['a', 'b']);
    expect([...members]).toEqual(['a', 'b']);
    members = nextMembers(members, ['b', 'c']);
    expect([...members].sort()).toEqual(['a', 'b', 'c']);
    expect([...handledIds(members, new Set(['b', 'c']))]).toEqual(['a']);
  });
});

describe('R3-07 R3-08 R3-09: one count rule for heads, strip, rail and badge', () => {
  const lane = { lane: { kind: 'active' }, cardIds: ['a', 'b', 'c'], total: 3, needs: 2, openInDone: 0 };
  const cards = { a: { needsYou: true, isComplete: false, loading: false }, b: { needsYou: true, isComplete: false, loading: false }, c: { needsYou: false, isComplete: false, loading: false } };
  it('no filter keeps the lane as is; a filter counts only the matched cards', () => {
    expect(filteredLane(lane, cards, null)).toBe(lane);
    expect(filteredLane(lane, cards, (id) => id === 'c')).toMatchObject({ matched: 1, needs: 0 });
    expect(filteredLane(lane, cards, () => false)).toMatchObject({ matched: 0, needs: 0 });
    const done = { lane: { kind: 'done' }, cardIds: ['a', 'c'], total: 2, needs: 0, openInDone: 2 };
    expect(filteredLane(done, cards, (id) => id === 'a')).toMatchObject({ matched: 1, openInDone: 1 });
  });
  it('an empty lane under a filter is 0, never 0 / 0; the done lane says how many are open', () => {
    expect(laneCountText(0, 0, 0)).toBe('0');
    expect(laneCountText(13, 0, 0)).toBe('0 / 13');
    expect(laneCountText(24, undefined, 1)).toBe('24 (1 open)');
    expect(laneCountText(6, undefined, 0)).toBe('6');
  });
});
