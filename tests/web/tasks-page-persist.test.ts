/**
 * /tasks page view-state persistence (web/src/components/tasks/tasks-page-persist.ts).
 * Pure logic against a Map-backed store — no React, no browser.
 */
import { describe, it, expect } from 'vitest';
import {
  LS_TASKS_PAGE_PROJECT,
  LS_TASKS_PAGE_QUERY,
  LS_TASKS_PAGE_SEARCH,
  TASKS_PAGE_DEFAULT_QUERY,
  readActiveProject,
  writeActiveProject,
  readQuery,
  writeQuery,
  sanitizeQuery,
  readSearch,
  writeSearch,
  readSort,
  writeSort,
  LS_TASKS_PAGE_SORT,
  TASKS_PAGE_DEFAULT_SORT,
  type KeyStore,
} from '../../web/src/components/tasks/tasks-page-persist';

function fakeStore(seed: Record<string, string> = {}): KeyStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A store whose every call throws — private mode / quota exceeded. */
const brokenStore: KeyStore = {
  getItem: () => { throw new Error('nope'); },
  setItem: () => { throw new Error('nope'); },
  removeItem: () => { throw new Error('nope'); },
};

describe('active project', () => {
  it('round-trips a project name, the Inbox sentinel, and All Tasks', () => {
    const s = fakeStore();
    writeActiveProject('Lantern', s);
    expect(readActiveProject(s)).toBe('Lantern');
    // '' is Inbox — a real selection, which is why it is JSON-encoded, not stored bare.
    writeActiveProject('', s);
    expect(readActiveProject(s)).toBe('');
    expect(s.map.get(LS_TASKS_PAGE_PROJECT)).toBe('""');
    // null (All Tasks) clears the key rather than storing "null".
    writeActiveProject(null, s);
    expect(s.map.has(LS_TASKS_PAGE_PROJECT)).toBe(false);
    expect(readActiveProject(s)).toBeNull();
  });

  it('garbage reads as All Tasks', () => {
    expect(readActiveProject(fakeStore({ [LS_TASKS_PAGE_PROJECT]: '{oops' }))).toBeNull();
    expect(readActiveProject(fakeStore({ [LS_TASKS_PAGE_PROJECT]: '42' }))).toBeNull();
    expect(readActiveProject(null)).toBeNull();
  });

  it('a throwing store never propagates', () => {
    expect(() => writeActiveProject('x', brokenStore)).not.toThrow();
    expect(readActiveProject(brokenStore)).toBeNull();
  });
});

describe('query', () => {
  it('nothing stored → the page default (open tasks only)', () => {
    const q = readQuery(fakeStore());
    expect(q).toEqual(TASKS_PAGE_DEFAULT_QUERY);
    expect(q.completion).toEqual(['todo', 'in_progress']);
  });

  it('round-trips a real filter state', () => {
    const s = fakeStore();
    const q = {
      ...TASKS_PAGE_DEFAULT_QUERY,
      completion: [] as typeof TASKS_PAGE_DEFAULT_QUERY.completion,
      projects: ['Lantern', ''],
      priorities: ['immediate'] as typeof TASKS_PAGE_DEFAULT_QUERY.priorities,
      pinned: true,
      timePreset: '24h' as typeof TASKS_PAGE_DEFAULT_QUERY.timePreset,
    };
    writeQuery(q, s);
    expect(readQuery(s)).toEqual(q);
  });

  it('sanitize: wrong-typed fields fall back per field, unknown keys are dropped', () => {
    const q = sanitizeQuery({
      completion: 'todo',           // not an array → default
      projects: ['A', 7, 'B'],      // mixed → default (whole field)
      phases: ['COMPLETE'],         // fine
      pinned: 'yes',                // not tri-state → default
      timeCustomValue: -3,          // must be a positive integer → default
      timeCustomUnit: 'weeks',      // not hours|days → default
      timePreset: null,             // null is a legal value
      somethingNew: { a: 1 },       // unknown → not carried
    });
    expect(q.completion).toEqual(TASKS_PAGE_DEFAULT_QUERY.completion);
    expect(q.projects).toEqual([]);
    expect(q.phases).toEqual(['COMPLETE']);
    expect(q.pinned).toBeUndefined();
    expect(q.timeCustomValue).toBe(24);
    expect(q.timeCustomUnit).toBe('hours');
    expect(q.timePreset).toBeNull();
    expect((q as Record<string, unknown>).somethingNew).toBeUndefined();
    expect(Object.keys(q).sort()).toEqual(Object.keys(TASKS_PAGE_DEFAULT_QUERY).sort());
  });

  it('non-objects and malformed JSON read as the default', () => {
    expect(sanitizeQuery(null)).toEqual(TASKS_PAGE_DEFAULT_QUERY);
    expect(sanitizeQuery('x')).toEqual(TASKS_PAGE_DEFAULT_QUERY);
    expect(readQuery(fakeStore({ [LS_TASKS_PAGE_QUERY]: '[1,' }))).toEqual(TASKS_PAGE_DEFAULT_QUERY);
    expect(readQuery(brokenStore)).toEqual(TASKS_PAGE_DEFAULT_QUERY);
  });
});

describe('sort', () => {
  it('nothing stored → most recently updated first', () => {
    expect(readSort(fakeStore())).toEqual({ key: 'updated', dir: 'desc' });
    expect(readSort(fakeStore())).toEqual(TASKS_PAGE_DEFAULT_SORT);
  });

  it('round-trips a column sort', () => {
    const s = fakeStore();
    writeSort({ key: 'created', dir: 'asc' }, s);
    expect(readSort(s)).toEqual({ key: 'created', dir: 'asc' });
  });

  it('"off" is a remembered choice, not a fall-through to the default', () => {
    const s = fakeStore();
    writeSort(null, s);
    expect(s.map.get(LS_TASKS_PAGE_SORT)).toBe('null');
    expect(readSort(s)).toBeNull();
  });

  it('an unknown key, a bad direction or garbage reads as the default', () => {
    expect(readSort(fakeStore({ [LS_TASKS_PAGE_SORT]: JSON.stringify({ key: 'bogus', dir: 'asc' }) }))).toEqual(TASKS_PAGE_DEFAULT_SORT);
    expect(readSort(fakeStore({ [LS_TASKS_PAGE_SORT]: JSON.stringify({ key: 'due', dir: 'up' }) }))).toEqual(TASKS_PAGE_DEFAULT_SORT);
    expect(readSort(fakeStore({ [LS_TASKS_PAGE_SORT]: '{nope' }))).toEqual(TASKS_PAGE_DEFAULT_SORT);
    expect(readSort(brokenStore)).toEqual(TASKS_PAGE_DEFAULT_SORT);
  });
});

describe('search', () => {
  it('stores non-empty text and clears the key for empty', () => {
    const s = fakeStore();
    writeSearch('walnut', s);
    expect(readSearch(s)).toBe('walnut');
    writeSearch('', s);
    expect(s.map.has(LS_TASKS_PAGE_SEARCH)).toBe(false);
    expect(readSearch(s)).toBe('');
  });

  it('keeps surrounding whitespace and Unicode verbatim', () => {
    const s = fakeStore();
    writeSearch('  任务 ', s);
    expect(readSearch(s)).toBe('  任务 ');
  });

  it('a throwing store reads as empty', () => {
    expect(readSearch(brokenStore)).toBe('');
    expect(() => writeSearch('x', brokenStore)).not.toThrow();
  });
});
