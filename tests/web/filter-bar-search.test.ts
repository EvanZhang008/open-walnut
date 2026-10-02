/**
 * Filter popover search (web/src/components/tasks/filter-bar-search.ts, 6.3):
 * aliases, coverage of More dims and truncated values, unselected-first order.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTER_STATE as S0, type FilterLists } from '../../web/src/components/tasks/filter-bar-types';
import { searchFilterDims } from '../../web/src/components/tasks/filter-bar-search';
import { pickValue } from '../../web/src/components/tasks/filter-bar-model';

const projects = ['', 'Walnut', 'iOS App', ...Array.from({ length: 28 }, (_, i) => `Project ${String(i + 1).padStart(2, '0')}`)];
const lists: FilterLists = {
  loading: false,
  projects,
  sources: [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }],
  tags: ['label:ios', 'label:urgent'],
  sprints: [],
  showPriority: false,
  tagLabel: (t) => (t.startsWith('label:') ? t.slice(6) : t),
};
const rows = (text: string, state = S0) =>
  searchFilterDims(text, state, lists).hits.map((h) => `${h.dimLabel}  ${h.valueLabel}${h.selected ? ' *' : ''}`);

describe('searchFilterDims', () => {
  it('empty text has no hits', () => {
    expect(searchFilterDims('   ', S0, lists)).toEqual({ hits: [], pinHint: false, viewHint: null });
  });
  it('S8: "ios" finds the project and the tag', () => {
    expect(rows('ios')).toEqual(['Project  iOS App', 'Tags  ios']);
  });
  it('C26b: "todo" puts the unselected Source first and the default Status after it', () => {
    expect(rows('todo')).toEqual(['Source  Microsoft To Do', 'Status  To Do *']);
  });
  it('C26: "gard" finds nothing else; "doing" finds In Progress', () => {
    const garden = { ...lists, projects: [...lists.projects, 'Garden'] };
    expect(searchFilterDims('gard', S0, garden).hits.map((h) => `${h.dimLabel}  ${h.valueLabel}`)).toEqual(['Project  Garden']);
    expect(rows('doing')).toEqual(['Status  In Progress *']);
  });
  it('done, complete, completed all find Complete', () => {
    for (const q of ['done', 'complete', 'completed', 'COMPLETED']) expect(rows(q)).toContain('Status  Complete');
  });
  it('phase finds the whole Status dimension', () => {
    expect(rows('phase')).toHaveLength(5);
  });
  it('updated, created, time find the Time window presets, never Custom', () => {
    for (const q of ['updated', 'created', 'time']) {
      const r = searchFilterDims(q, S0, lists).hits.filter((h) => h.dim === 'time');
      expect(r.map((h) => h.value)).toEqual(['1h', '6h', '24h', '7d', '30d']);
    }
    expect(rows('24h')).toEqual(['Time window  Updated in 24h']);
  });
  it('flag and blocked find Blocked', () => {
    expect(rows('flag')).toEqual(['Blocked  Blocked', 'Blocked  Not blocked']);
    expect(rows('not bl')).toEqual(['Blocked  Not blocked']);
  });
  it('"pin" finds no value and asks for the Display hint', () => {
    const r = searchFilterDims('pin', S0, lists);
    expect(r.pinHint).toBe(true);
    expect(searchFilterDims('pinned', S0, lists).pinHint).toBe(true);
    expect(searchFilterDims('pi', S0, lists).pinHint).toBe(false);
  });
  it('C27: covers values past the 8 shown (the 20th project) and More dims', () => {
    expect(rows('project 20')).toEqual(['Project  Project 20']);
    expect(rows('urgent')).toEqual(['Tags  urgent']);
  });
  it('G15: unselected first, then selected, each in registry order', () => {
    const s = pickValue(S0, 'source', 'local', 'replace');
    expect(rows('l', s).filter((r) => r.startsWith('Source') || r.startsWith('Project  Walnut'))).toEqual([
      'Project  Walnut', 'Source  Local *',
    ]);
    const all = searchFilterDims('o', s, lists).hits;
    const firstSelected = all.findIndex((h) => h.selected);
    expect(all.slice(firstSelected).every((h) => h.selected)).toBe(true);
  });
  it('hidden dimensions stay out (Priority with show_priority off)', () => {
    expect(rows('important')).toEqual([]);
    expect(searchFilterDims('important', S0, { ...lists, showPriority: true }).hits.map((h) => h.dim)).toEqual(['priority']);
  });
});
