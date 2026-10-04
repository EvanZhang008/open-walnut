/**
 * filter-home-model (the filter half of the panel menu's first page): each
 * property row's value in the chip's words (`dimSummary`), which rows show and
 * which fold behind `More filters` (`homeRows`), and the ranking of search
 * hits: by use (`useCount`, `rankByUse`), then by how well the label answers
 * the text (`matchScore`, `rankByMatch`), plus the use count `pushRecent` keeps
 * so the use ranking has something to rank by.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskPhase } from '../../src/core/types';
import { DEFAULT_FILTER_STATE as S0, FILTER_DIMS, type FilterDim, type FilterLists, type FilterState, type RecentEntry } from '../../web/src/components/tasks/filter-bar-types';
import { buildFilterChips } from '../../web/src/components/tasks/filter-bar-model';
import { dimSummary, homeRows, matchScore, rankByMatch, rankByUse, useCount } from '../../web/src/components/tasks/filter-home-model';
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

  it('two sources list Source, folded with tags, sprints and priority in registry order', () => {
    const l = lists({ sources: TWO_SOURCES, tags: ['label:a'], sprints: ['S1'], showPriority: true });
    expect(homeRows(S0, l)).toEqual({
      shown: ['status', 'project', 'date'],
      folded: ['source', 'priority', 'blocked', 'tags', 'sprint', 'time'],
    });
  });

  it('a folded property that is set is promoted out of the fold, in registry order', () => {
    const l = lists({ sources: TWO_SOURCES, tags: ['label:a'] });
    expect(homeRows(st({ blocked: false }), l)).toEqual({
      shown: ['status', 'project', 'date', 'blocked'],
      folded: ['source', 'tags', 'time'],
    });
    expect(homeRows(st({ time: { ...S0.time, preset: '7d' }, tagsAny: ['label:a'] }), l)).toEqual({
      shown: ['status', 'project', 'date', 'tags', 'time'],
      folded: ['source', 'blocked'],
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

describe('useCount and rankByUse: search hits ranked by how often they were picked', () => {
  const e = (value: string, uses?: number): RecentEntry => (uses ? { dim: 'project', value, uses } : { dim: 'project', value });
  const byUse = (recent: readonly RecentEntry[], values: string[]) =>
    rankByUse(values, (v) => useCount(recent, 'project', v));

  it('ranks the values used most first, and ties keep their input order', () => {
    const recent = [e('A'), e('B', 3), e('C'), e('D', 2), e('E'), e('F', 3)];
    expect(byUse(recent, ['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(['B', 'F', 'D', 'A', 'C', 'E']);
    expect(byUse(recent, ['F', 'E', 'D', 'C', 'B', 'A'])).toEqual(['F', 'B', 'D', 'E', 'C', 'A']);
  });

  it('a value never picked counts 0 and sinks below every picked one; absent uses counts as one', () => {
    const recent = [e('A'), e('B', 1), e('C', 2)];
    expect(useCount(recent, 'project', 'A')).toBe(1);
    expect(useCount(recent, 'project', 'B')).toBe(1);
    expect(useCount(recent, 'project', 'C')).toBe(2);
    expect(useCount(recent, 'project', 'Z')).toBe(0);
    expect(useCount([], 'project', 'A')).toBe(0);
    expect(byUse(recent, ['Z', 'A', 'B', 'C'])).toEqual(['C', 'A', 'B', 'Z']);
  });

  it('the count is per property: the same value on another property is not counted', () => {
    const recent: RecentEntry[] = [{ dim: 'source', value: 'Home', uses: 4 }, { dim: 'date', value: 'overdue', uses: 2 }];
    expect(useCount(recent, 'project', 'Home')).toBe(0);
    expect(useCount(recent, 'source', 'Home')).toBe(4);
    expect(useCount(recent, 'date', 'overdue')).toBe(2);
    // A status set is one pick of the whole set, never a use of a single status.
    expect(useCount([{ dim: 'status', value: ['TODO', 'COMPLETE'], uses: 3 }], 'status', 'TODO')).toBe(0);
  });

  it('the input is not reordered; no items give no rows', () => {
    const values = ['A', 'B', 'C'];
    expect(byUse([e('C', 2)], values)).toEqual(['C', 'A', 'B']);
    expect(values).toEqual(['A', 'B', 'C']);
    expect(rankByUse([], () => 1)).toEqual([]);
  });
});

describe('matchScore and rankByMatch: the label the text names outright comes first', () => {
  it('scores 2 for the whole label, 1 for its start, 0 inside or through a keyword, case and spaces aside', () => {
    expect(matchScore('Recent', 'recent')).toBe(2);
    expect(matchScore(' Recent ', '  RECENT')).toBe(2);
    expect(matchScore('Waiting', 'wait')).toBe(1);
    expect(matchScore('Updated in 24h', 'up')).toBe(1);
    expect(matchScore('In Progress', 'progress')).toBe(0);
    // A keyword hit (doing finds In Progress) has no label match at all.
    expect(matchScore('In Progress', 'doing')).toBe(0);
  });

  it('an empty or blank text scores 0 for every label', () => {
    expect(matchScore('Recent', '')).toBe(0);
    expect(matchScore('Recent', '   ')).toBe(0);
    expect(matchScore('', '')).toBe(0);
  });

  it('exact beats prefix beats inside; ties keep their input order', () => {
    const labels = ['Created in 7d', 'Recently done', 'Updated recently', 'Recent', 'Recent tasks', 'Not recent'];
    expect(rankByMatch(labels, (l) => l, 'recent')).toEqual([
      'Recent', 'Recently done', 'Recent tasks', 'Created in 7d', 'Updated recently', 'Not recent',
    ]);
    expect(labels[0]).toBe('Created in 7d');
  });

  it('an empty text leaves the order alone, so the use ranking stands', () => {
    const items = [{ label: 'Home' }, { label: 'Garden' }, { label: 'Shed' }];
    expect(rankByMatch(items, (x) => x.label, '')).toEqual(items);
    expect(rankByMatch(items, (x) => x.label, '  ')).toEqual(items);
    expect(rankByMatch([], (x: string) => x, 'home')).toEqual([]);
  });

  it('runs after the use ranking: a used hit that only matches inside drops below the named label', () => {
    const recent: RecentEntry[] = [{ dim: 'project', value: 'Old recent work', uses: 5 }];
    const hits: { dim: FilterDim; value: string }[] = [
      { dim: 'project', value: 'Recent hires' }, { dim: 'project', value: 'Old recent work' }, { dim: 'project', value: 'Recent' },
    ];
    const used = rankByUse(hits, (h) => useCount(recent, h.dim, h.value));
    expect(used.map((h) => h.value)).toEqual(['Old recent work', 'Recent hires', 'Recent']);
    expect(rankByMatch(used, (h) => h.value, 'recent').map((h) => h.value)).toEqual(['Recent', 'Recent hires', 'Old recent work']);
  });
});

describe('pushRecent: the use count behind the search ranking', () => {
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
    const recent = validRecent(readRecent(), l, RECENT_STORE_LIMIT);
    // The hits in the order a search lists them: picked once keep it, never picked go last.
    const items: { dim: FilterDim; value: string }[] = [
      { dim: 'project', value: 'Home' }, { dim: 'project', value: 'Shed' },
      { dim: 'project', value: 'Garden' }, { dim: 'source', value: 'ms-todo' },
    ];
    const ranked = rankByUse(items, (x) => useCount(recent, x.dim, x.value));
    expect(ranked.map((x) => x.value)).toEqual(['Garden', 'Home', 'ms-todo', 'Shed']);
  });
});
