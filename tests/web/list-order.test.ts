/**
 * list-order (web/src/components/tasks/list-order.ts): which lists a view's Sort
 * and Group rows act on, how differing lists read, the stored tier sorts, and the
 * pin-order guard a drop runs over sorted tiers.
 */
import { describe, it, expect } from 'vitest';
import {
  SORT_VALUES, commonValue, groupOfTierMode, keepPinOrder, orderLists,
  parseTierSorts, tierModeOfGroup,
} from '../../web/src/components/tasks/list-order';

describe('orderLists: the lists a view draws', () => {
  const tiers = ['focus', 'satellite', 'wait', 'ct_a'];
  it('every view has lists to sort and group', () => {
    expect(orderLists('tasks', tiers)).toEqual({ tiers: [], projects: true, recent: false });
    // All acts on its Projects list; its tiers keep their own order (their heading menus).
    expect(orderLists('all', tiers)).toEqual({ tiers: [], projects: true, recent: false });
    expect(orderLists('pinned', tiers)).toEqual({ tiers, projects: false, recent: false });
    expect(orderLists('recent', tiers)).toEqual({ tiers: [], projects: false, recent: true });
    expect(orderLists('focus', tiers)).toEqual({ tiers: ['focus'], projects: false, recent: false });
    expect(orderLists('ct_a', tiers)).toEqual({ tiers: ['ct_a'], projects: false, recent: false });
  });
  it('every list offers all four sorts', () => {
    expect(SORT_VALUES).toEqual(['manual', 'priority', 'date', 'updated']);
  });
});

describe('commonValue', () => {
  it('one value when every list agrees, null when they differ or there are none', () => {
    expect(commonValue(['manual', 'manual'])).toBe('manual');
    expect(commonValue(['manual', 'priority'])).toBeNull();
    expect(commonValue([])).toBeNull();
  });
});

describe('group and order mappings', () => {
  it('a tier view mode is its Group', () => {
    expect(groupOfTierMode('project')).toBe('project');
    expect(groupOfTierMode('custom')).toBe('none');
    expect(tierModeOfGroup('none')).toBe('custom');
    expect(tierModeOfGroup('project')).toBe('project');
  });
  it('stored tier sorts keep only real non-Manual sorts', () => {
    expect(parseTierSorts(JSON.stringify({ focus: 'priority', wait: 'manual', ct_x: 'bogus', satellite: 'date' })))
      .toEqual({ focus: 'priority', satellite: 'date' });
    expect(parseTierSorts('not json')).toEqual({});
    expect(parseTierSorts(null)).toEqual({});
  });
});

describe('keepPinOrder: a drop never rewrites a sorted tier it did not reorder', () => {
  const pin = new Map(['a', 'b', 'c', 'x', 'y', 'z'].map((id, i) => [id, i]));
  it('a kept tier goes back to pin order in its own slots; other ids stay put', () => {
    // Focus (x, y, z) drew sorted as z, x, y; Satellite (a, b, c) was reordered by the drop.
    const order = ['c', 'a', 'b', 'z', 'x', 'y'];
    expect(keepPinOrder(order, [new Set(['x', 'y', 'z'])], pin)).toEqual(['c', 'a', 'b', 'x', 'y', 'z']);
  });
  it('a card that just arrived takes its place by its old pin index, nothing is lost or doubled', () => {
    const order = ['b', 'c', 'z', 'a', 'x', 'y'];
    const out = keepPinOrder(order, [new Set(['z', 'a', 'x', 'y'])], pin);
    expect(out).toEqual(['b', 'c', 'a', 'x', 'y', 'z']);
    expect([...out].sort()).toEqual([...order].sort());
  });
  it('no kept tier: the order is unchanged', () => {
    expect(keepPinOrder(['b', 'a'], [], pin)).toEqual(['b', 'a']);
  });
});
