/**
 * filter-home-model (the Filter menu's first page): each property row's value
 * in the chip's words (`dimSummary`), which rows show and which fold behind
 * `More filters` (`homeRows`), and the `Most used` ranking (`mostUsed`), plus
 * the use count `pushRecent` keeps so that ranking has something to rank by.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskPhase } from '../../src/core/types';
import { DEFAULT_FILTER_STATE as S0, FILTER_DIMS, type FilterLists, type FilterState, type RecentEntry } from '../../web/src/components/tasks/filter-bar-types';
import { buildFilterChips } from '../../web/src/components/tasks/filter-bar-model';
import { MOST_USED_LIMIT, dimSummary, homeRows, mostUsed } from '../../web/src/components/tasks/filter-home-model';
import { LS_FILTER_RECENT_KEY, RECENT_STORE_LIMIT, pushRecent, readRecent } from '../../web/src/components/tasks/filter-bar-persist';
import { validRecent } from '../../web/src/components/tasks/filter-recent';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

function lists(over: Partial<FilterLists> = {}): FilterLists {
  return {
    loading: false,
    projects: ['Home', 'Garden', 'Shed'],
    sources: [{ id: 'local', label: 'Local' }],
    tags: [],
    sprints: [],
    showPriority: false,
    tagLabel: (t: string) => t.replace(/^label:/, ''),
    ...over,
  };
}
const TWO_SOURCES = [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }];
const st = (over: Partial<FilterState>): FilterState => ({ ...S0, ...over });
const summaryOf = (dim: (typeof FILTER_DIMS)[number], s: FilterState, l = lists()) => dimSummary(dim, s, buildFilterChips(s, l));

describe('dimSummary: the value at the right of a property row', () => {
  it('each property at its default reads its default words, muted', () => {
    const want = {
      status: 'Open', project: 'Any', date: 'Available now', source: 'Any', priority: 'Any',
      blocked: 'Any', tags: 'Any', sprint: 'Any', time: 'Any time',
    };
    for (const dim of FILTER_DIMS) expect(summaryOf(dim, S0), dim).toEqual({ text: want[dim], isDefault: true });
  });

  it('a set property reads the chip value: Home, Garden; To Do, Need Action; 3 projects', () => {
    expect(summaryOf('project', st({ projects: ['Home', 'Garden'] }))).toEqual({ text: 'Home, Garden', isDefault: false });
    expect(summaryOf('project', st({ projects: ['Home', 'Garden', 'Shed'] }))).toEqual({ text: '3 projects', isDefault: false });
    expect(summaryOf('status', st({ status: ['TODO', 'NEED_ACTION'] as TaskPhase[] }))).toEqual({ text: 'To Do, Need Action', isDefault: false });
    expect(summaryOf('status', st({ status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] as TaskPhase[] })).text).toBe('Open, Complete');
    expect(summaryOf('project', st({ projects: [''] })).text).toBe('Inbox');
  });

  it('single-select and folded properties read their value words', () => {
    expect(summaryOf('date', st({ date: 'overdue' })).text).toBe('Overdue');
    expect(summaryOf('date', st({ date: '' })).text).toBe('Any date');
    expect(summaryOf('blocked', st({ blocked: false })).text).toBe('Not blocked');
    expect(summaryOf('blocked', st({ blocked: true })).text).toBe('Blocked');
    expect(summaryOf('time', st({ time: { ...S0.time, preset: '24h' } })).text).toBe('Updated in 24h');
    const tagged = st({ tagsAny: ['label:urgent'] });
    expect(summaryOf('tags', tagged, lists({ tags: ['label:urgent'] }))).toEqual({ text: 'urgent', isDefault: false });
    expect(summaryOf('source', st({ sources: ['ms-todo'] }), lists({ sources: TWO_SOURCES })).text).toBe('Microsoft To Do');
  });

  it('a chip that no longer matches the state does not set the row (the state decides)', () => {
    const staleChips = buildFilterChips(st({ projects: ['Home'] }), lists());
    expect(dimSummary('project', S0, staleChips)).toEqual({ text: 'Any', isDefault: true });
    expect(dimSummary('project', st({ projects: ['Home'] }), [])).toEqual({ text: 'Any', isDefault: true });
  });
});

describe('homeRows: shown rows and the More filters fold', () => {
  it('a fresh board: Status, Project, Date shown; Blocked and Time window folded', () => {
    expect(homeRows(S0, lists())).toEqual({ shown: ['status', 'project', 'date'], folded: ['blocked', 'time'] });
  });

  it('two sources add Source to the first rows; tags, sprints and priority fold in registry order', () => {
    const l = lists({ sources: TWO_SOURCES, tags: ['label:a'], sprints: ['S1'], showPriority: true });
    expect(homeRows(S0, l)).toEqual({
      shown: ['status', 'project', 'date', 'source'],
      folded: ['priority', 'blocked', 'tags', 'sprint', 'time'],
    });
  });

  it('a folded property that is set is promoted out of the fold, in registry order', () => {
    const l = lists({ sources: TWO_SOURCES, tags: ['label:a'] });
    expect(homeRows(st({ blocked: false }), l)).toEqual({
      shown: ['status', 'project', 'date', 'source', 'blocked'],
      folded: ['tags', 'time'],
    });
    expect(homeRows(st({ time: { ...S0.time, preset: '7d' }, tagsAny: ['label:a'] }), l)).toEqual({
      shown: ['status', 'project', 'date', 'source', 'tags', 'time'],
      folded: ['blocked'],
    });
  });

  it('a first-layer property at its default stays shown; nothing is folded twice', () => {
    const rows = homeRows(st({ date: '' }), lists());
    expect(rows.shown).toContain('date');
    expect(new Set([...rows.shown, ...rows.folded]).size).toBe(rows.shown.length + rows.folded.length);
  });

  it('Project hides with no project once loaded, shows while loading or while set', () => {
    expect(homeRows(S0, lists({ projects: [] })).shown).toEqual(['status', 'date']);
    expect(homeRows(S0, lists({ projects: [], loading: true })).shown).toEqual(['status', 'project', 'date']);
    expect(homeRows(st({ projects: ['Gone'] }), lists({ projects: [] })).shown).toEqual(['status', 'project', 'date']);
  });
});

describe('mostUsed: the Most used rows', () => {
  const e = (value: string, uses?: number): RecentEntry => (uses ? { dim: 'project', value, uses } : { dim: 'project', value });

  it('ranks by uses, ties keep the newest-first input order, and caps at 4', () => {
    expect(MOST_USED_LIMIT).toBe(4);
    const recent = [e('A'), e('B', 3), e('C'), e('D', 2), e('E'), e('F', 3)];
    expect(mostUsed(recent).map((x) => x.value)).toEqual(['B', 'F', 'D', 'A']);
    expect(mostUsed(recent, 2).map((x) => x.value)).toEqual(['B', 'F']);
  });

  it('absent uses counts as one; no history gives no rows; the input is not reordered', () => {
    const recent = [e('A'), e('B', 1), e('C', 2)];
    expect(mostUsed(recent).map((x) => x.value)).toEqual(['C', 'A', 'B']);
    expect(recent.map((x) => x.value)).toEqual(['A', 'B', 'C']);
    expect(mostUsed([])).toEqual([]);
  });

  it('mixes properties: a status set picked twice outranks a newer project', () => {
    const recent: RecentEntry[] = [
      { dim: 'project', value: 'Home' },
      { dim: 'status', value: ['TODO', 'COMPLETE'], uses: 2 },
      { dim: 'date', value: 'overdue' },
    ];
    expect(mostUsed(recent).map((x) => x.dim)).toEqual(['status', 'project', 'date']);
  });
});

describe('pushRecent: the use count behind Most used', () => {
  it('a first pick is stored without uses; the same pick again counts 2, then 3, and moves to the top', () => {
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    expect(readRecent()).toEqual([{ dim: 'project', value: 'Garden' }]);
    pushRecent([{ dim: 'project', value: 'Home' }]);
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    expect(readRecent()).toEqual([{ dim: 'project', value: 'Garden', uses: 2 }, { dim: 'project', value: 'Home' }]);
    pushRecent([{ dim: 'date', value: 'overdue' }]);
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    expect(readRecent()[0]).toEqual({ dim: 'project', value: 'Garden', uses: 3 });
    expect(JSON.parse(store.get(LS_FILTER_RECENT_KEY)!)[0]).toEqual({ dim: 'project', value: 'Garden', uses: 3 });
  });

  it('other entries keep their counts when a new pick lands; one push counts each of its picks once', () => {
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    pushRecent([{ dim: 'source', value: 'ms-todo' }, { dim: 'project', value: 'Home' }]);
    expect(readRecent()).toEqual([
      { dim: 'project', value: 'Home' },
      { dim: 'source', value: 'ms-todo' },
      { dim: 'project', value: 'Garden', uses: 2 },
    ]);
    pushRecent([]);
    expect(readRecent()[2]).toEqual({ dim: 'project', value: 'Garden', uses: 2 });
  });

  it('a status set counts as the same pick whatever its order', () => {
    pushRecent([{ dim: 'status', value: ['TODO', 'COMPLETE'] }]);
    pushRecent([{ dim: 'status', value: ['COMPLETE', 'TODO'] }]);
    const [first, ...rest] = readRecent();
    expect(first).toMatchObject({ dim: 'status', uses: 2 });
    expect(rest).toEqual([]);
  });

  it('readRecent keeps a stored count above one and drops a bad one', () => {
    store.set(LS_FILTER_RECENT_KEY, JSON.stringify([
      { dim: 'project', value: 'A', uses: 4 },
      { dim: 'project', value: 'B', uses: 1 },
      { dim: 'project', value: 'C', uses: 'many' },
      { dim: 'project', value: 'D', uses: 2.7 },
    ]));
    expect(readRecent()).toEqual([
      { dim: 'project', value: 'A', uses: 4 },
      { dim: 'project', value: 'B' },
      { dim: 'project', value: 'C' },
      { dim: 'project', value: 'D', uses: 2 },
    ]);
  });

  it('the store keeps 12 picks, counts included', () => {
    pushRecent([{ dim: 'project', value: 'P0' }]);
    pushRecent([{ dim: 'project', value: 'P0' }]);
    for (let i = 1; i <= RECENT_STORE_LIMIT - 1; i++) pushRecent([{ dim: 'project', value: `P${i}` }]);
    const stored = readRecent();
    expect(stored).toHaveLength(RECENT_STORE_LIMIT);
    expect(stored.at(-1)).toEqual({ dim: 'project', value: 'P0', uses: 2 });
    pushRecent([{ dim: 'project', value: 'P99' }]);
    expect(readRecent()).toHaveLength(RECENT_STORE_LIMIT);
    expect(readRecent().some((x) => x.value === 'P0')).toBe(false);
  });

  it('end to end: a value picked twice ranks first even after two newer picks', () => {
    const l = lists({ sources: TWO_SOURCES });
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    pushRecent([{ dim: 'project', value: 'Garden' }]);
    pushRecent([{ dim: 'project', value: 'Home' }]);
    pushRecent([{ dim: 'source', value: 'ms-todo' }]);
    const ranked = mostUsed(validRecent(readRecent(), l, RECENT_STORE_LIMIT));
    expect(ranked.map((x) => x.value)).toEqual(['Garden', 'ms-todo', 'Home']);
  });
});
