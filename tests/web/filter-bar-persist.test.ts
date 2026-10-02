/**
 * Filter bar persistence (web/src/components/tasks/filter-bar-persist.ts, 4.7
 * and 4.8) and the Recent model (filter-recent.ts): versioned round trip, bad
 * data dropped with a warning, the one-time legacy fold, Recent stored as ids.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_FILTER_STATE as S0, type FilterLists, type FilterState } from '../../web/src/components/tasks/filter-bar-types';
import {
  LS_FILTERS_KEY, LS_FILTER_RECENT_KEY, LS_LEGACY_DATE_KEY, markTierUsed, pushRecent, readMoreOpen,
  readPersistedFilters, readRecent, readTierUsed, writeMoreOpen, writePersistedFilters,
} from '../../web/src/components/tasks/filter-bar-persist';
import { INBOX_TAB, LS_TAB_KEY } from '../../web/src/components/tasks/task-tabs';
import {
  applyRecentEntry, isRecentActive, recentEntriesFor, recentEntryLabel, validRecent,
} from '../../web/src/components/tasks/filter-recent';
import { log } from '../../web/src/utils/log';

class FakeStorage {
  store = new Map<string, string>();
  quota = false;
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { if (this.quota) throw new Error('QuotaExceededError'); this.store.set(k, String(v)); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
let ls: FakeStorage;
beforeEach(() => {
  ls = new FakeStorage();
  vi.stubGlobal('localStorage', ls);
  vi.restoreAllMocks();
});

const lists: FilterLists = {
  loading: false,
  projects: ['Walnut', 'iOS App', 'Garden'],
  sources: [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }],
  tags: ['label:urgent'],
  sprints: [],
  showPriority: false,
  tagLabel: (t) => (t.startsWith('label:') ? t.slice(6) : t),
};

describe('walnut-todo-filters (4.8)', () => {
  it('round-trips the whole chip set with v: 1', () => {
    const s: FilterState = {
      ...S0, status: ['COMPLETE'], projects: ['Garden', ''], date: 'overdue', sources: ['ms-todo'],
      priorities: ['important'], blocked: false, tagsAny: ['label:urgent'], sprints: ['S1'],
      time: { basis: 'created', preset: 'custom', customValue: 3, customUnit: 'days' },
    };
    writePersistedFilters(s);
    expect(JSON.parse(ls.getItem(LS_FILTERS_KEY)!).v).toBe(1);
    expect(readPersistedFilters()).toEqual(s);
    writePersistedFilters(S0);
    expect(readPersistedFilters()).toEqual(S0);
  });
  it('bad JSON and unknown versions are dropped with a warning', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    ls.setItem(LS_FILTERS_KEY, '{not json');
    expect(readPersistedFilters()).toBeNull();
    ls.setItem(LS_FILTERS_KEY, JSON.stringify({ v: 2, status: ['COMPLETE'] }));
    expect(readPersistedFilters()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toBe('filter-bar');
  });
  it('sanitizes field by field (empty status, junk values)', () => {
    ls.setItem(LS_FILTERS_KEY, JSON.stringify({ v: 1, status: [], projects: ['A', 3], date: 'soon', priorities: ['nope', 'none'] }));
    expect(readPersistedFilters()).toEqual({ ...S0, projects: ['A'], priorities: ['none'] });
  });
  it('folds the old date key and the tab bookmark once, then the new key wins', () => {
    expect(readPersistedFilters()).toBeNull();
    ls.setItem(LS_LEGACY_DATE_KEY, 'this-week');
    ls.setItem(LS_TAB_KEY, INBOX_TAB);
    const s = readPersistedFilters()!;
    expect(s.date).toBe('this-week');
    expect(s.projects).toEqual(['']);
    expect(ls.getItem(LS_FILTERS_KEY)).not.toBeNull();
    ls.setItem(LS_TAB_KEY, 'Walnut');
    expect(readPersistedFilters()!.projects).toEqual(['']);
  });
  it('quota errors are swallowed', () => {
    ls.quota = true;
    expect(() => writePersistedFilters(S0)).not.toThrow();
    expect(() => pushRecent([{ dim: 'project', value: 'Walnut' }])).not.toThrow();
  });
  it('More filters and tier-used flags', () => {
    expect(readMoreOpen()).toBe(false);
    writeMoreOpen(true);
    expect(readMoreOpen()).toBe(true);
    expect(readTierUsed()).toBe(false);
    markTierUsed();
    expect(readTierUsed()).toBe(true);
  });
});

describe('Recent (4.7, G35)', () => {
  it('records new non-default conditions as ids; Status stores the whole set', () => {
    const next: FilterState = { ...S0, projects: ['Walnut'], status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'], date: 'this-week' };
    expect(recentEntriesFor(S0, next)).toEqual([
      { dim: 'project', value: 'Walnut' },
      { dim: 'status', value: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] },
      { dim: 'date', value: 'this-week' },
    ]);
    expect(recentEntriesFor(next, { ...next, date: 'now' })).toEqual([]);
    expect(recentEntriesFor(S0, { ...S0, time: { ...S0.time, preset: '24h' } })).toEqual([]);
  });
  it('C68: labels are drawn from ids through the registry', () => {
    expect(recentEntryLabel({ dim: 'status', value: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] }, lists)).toBe('Status: Open, Complete');
    expect(recentEntryLabel({ dim: 'date', value: 'this-week' }, lists)).toBe('Date: Starting within 7 days');
    expect(recentEntryLabel({ dim: 'source', value: 'ms-todo' }, lists)).toBe('Source: Microsoft To Do');
    expect(recentEntryLabel({ dim: 'tags', value: 'label:urgent' }, lists)).toBe('Tags: urgent');
    expect(recentEntryLabel({ dim: 'blocked', value: 'false' }, lists)).toBe('Not blocked');
  });
  it('a Status entry replaces the whole set; Project replaces; an active entry removes', () => {
    const open = { dim: 'status' as const, value: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] };
    const s1 = applyRecentEntry({ ...S0, status: ['WAITING'] }, open);
    expect(s1.status).toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE']);
    expect(isRecentActive(s1, open)).toBe(true);
    expect(applyRecentEntry(s1, open).status).toEqual(S0.status);
    const ios = { dim: 'project' as const, value: 'iOS App' };
    const s2 = applyRecentEntry({ ...S0, projects: ['Walnut'] }, ios);
    expect(s2.projects).toEqual(['iOS App']);
    expect(applyRecentEntry(s2, ios).projects).toEqual([]);
    expect(applyRecentEntry({ ...S0, tagsAny: ['a'] }, { dim: 'tags', value: 'label:urgent' }).tagsAny).toEqual(['a', 'label:urgent']);
    expect(applyRecentEntry(S0, { dim: 'date', value: 'overdue' }).date).toBe('overdue');
  });
  it('pushRecent keeps newest first, deduped (a repeat counts a use); readRecent shape-checks', () => {
    pushRecent([{ dim: 'project', value: 'Walnut' }]);
    pushRecent([{ dim: 'source', value: 'ms-todo' }, { dim: 'project', value: 'Walnut' }]);
    expect(readRecent()).toEqual([{ dim: 'project', value: 'Walnut', uses: 2 }, { dim: 'source', value: 'ms-todo' }]);
    ls.setItem(LS_FILTER_RECENT_KEY, JSON.stringify([{ dim: 'nope', value: 'x' }, { dim: 'project', value: 4 }, { dim: 'project', value: 'Garden' }]));
    expect(readRecent()).toEqual([{ dim: 'project', value: 'Garden' }]);
    ls.setItem(LS_FILTER_RECENT_KEY, 'garbage');
    expect(readRecent()).toEqual([]);
  });
  it('validRecent drops values that no longer exist before taking the top 4', () => {
    const entries = [
      { dim: 'project' as const, value: 'Deleted' },
      { dim: 'project' as const, value: 'Walnut' },
      { dim: 'source' as const, value: 'ms-todo' },
      { dim: 'status' as const, value: ['COMPLETE'] },
      { dim: 'date' as const, value: 'this-week' },
      { dim: 'project' as const, value: 'Garden' },
    ];
    const shown = validRecent(entries, lists);
    expect(shown).toHaveLength(4);
    expect(shown.map((e) => e.value)).toEqual(['Walnut', 'ms-todo', ['COMPLETE'], 'this-week']);
    expect(validRecent([{ dim: 'project', value: 'Deleted' }], { ...lists, loading: true })).toHaveLength(1);
    expect(validRecent([{ dim: 'status', value: ['BOGUS'] }], lists)).toEqual([]);
  });
});
