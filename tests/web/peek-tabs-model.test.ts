/**
 * The chat column's tabs (web/src/components/board/peek-tabs-model.ts): open,
 * switch, close like a browser's tabs, and the per-task record that makes them
 * sticky. The bar itself is proven in a real browser:
 * tests/e2e/browser/task-board-peek.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_PEEK_TABS, PEEK_TABS_PREFIX, PEEK_TABS_STORED_MAX,
  activatePeekTab, closeAllPeekTabs, closeOtherPeekTabs, closePeekTab, openPeekTab,
  parsePeekTabs, peekTabsKey, readPeekTabs, stepPeekTab, writePeekTabs, type PeekTabs,
} from '../../web/src/components/board/peek-tabs-model';

const tabs = (ids: string[], active: string | null = null): PeekTabs => ({ tabs: ids, active });

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('openPeekTab', () => {
  it('a new task goes last and becomes active', () => {
    expect(openPeekTab(NO_PEEK_TABS, 'a')).toEqual(tabs(['a'], 'a'));
    expect(openPeekTab(tabs(['a', 'b'], 'a'), 'c')).toEqual(tabs(['a', 'b', 'c'], 'c'));
  });

  it('a task that already has a tab is switched to, never duplicated or moved', () => {
    const s = tabs(['a', 'b', 'c'], 'c');
    expect(openPeekTab(s, 'a')).toEqual(tabs(['a', 'b', 'c'], 'a'));
    expect(openPeekTab(tabs(['a', 'b'], null), 'b')).toEqual(tabs(['a', 'b'], 'b'));
  });

  it('opening the active tab again changes nothing (same object, no write)', () => {
    const s = tabs(['a', 'b'], 'b');
    expect(openPeekTab(s, 'b')).toBe(s);
  });

  it('the panel\'s own task is the own chat: no tab, the own chat shows', () => {
    expect(openPeekTab(tabs(['a'], 'a'), 'own', 'own')).toEqual(tabs(['a'], null));
    expect(openPeekTab(NO_PEEK_TABS, '', 'own')).toBe(NO_PEEK_TABS);
  });
});

describe('activatePeekTab', () => {
  it('switches between tabs and back to the own chat', () => {
    expect(activatePeekTab(tabs(['a', 'b'], 'a'), 'b')).toEqual(tabs(['a', 'b'], 'b'));
    expect(activatePeekTab(tabs(['a', 'b'], 'b'), null)).toEqual(tabs(['a', 'b'], null));
  });

  it('an id with no tab is ignored', () => {
    const s = tabs(['a'], 'a');
    expect(activatePeekTab(s, 'zz')).toBe(s);
  });
});

describe('closePeekTab', () => {
  it('closing the active tab hands over to its right-hand neighbour', () => {
    expect(closePeekTab(tabs(['a', 'b', 'c'], 'b'), 'b')).toEqual(tabs(['a', 'c'], 'c'));
  });

  it('the last tab hands over to its left-hand neighbour, the only one to the own chat', () => {
    expect(closePeekTab(tabs(['a', 'b', 'c'], 'c'), 'c')).toEqual(tabs(['a', 'b'], 'b'));
    expect(closePeekTab(tabs(['a'], 'a'), 'a')).toEqual(tabs([], null));
  });

  it('closing an inactive tab keeps the one on screen', () => {
    expect(closePeekTab(tabs(['a', 'b', 'c'], 'c'), 'a')).toEqual(tabs(['b', 'c'], 'c'));
    expect(closePeekTab(tabs(['a', 'b'], null), 'b')).toEqual(tabs(['a'], null));
  });

  it('an unknown id changes nothing', () => {
    const s = tabs(['a'], 'a');
    expect(closePeekTab(s, 'zz')).toBe(s);
  });
});

describe('closeOtherPeekTabs / closeAllPeekTabs', () => {
  it('keeps one tab (now active) and the own chat', () => {
    expect(closeOtherPeekTabs(tabs(['a', 'b', 'c'], 'a'), 'b')).toEqual(tabs(['b'], 'b'));
  });

  it('an unknown id changes nothing', () => {
    const s = tabs(['a', 'b'], 'a');
    expect(closeOtherPeekTabs(s, 'zz')).toBe(s);
  });

  it('close all leaves only the own chat', () => {
    expect(closeAllPeekTabs()).toEqual(NO_PEEK_TABS);
  });
});

describe('stepPeekTab', () => {
  it('walks the own chat and every tab, wrapping at both ends', () => {
    const s = tabs(['a', 'b'], null);
    expect(stepPeekTab(s, 1)).toBe('a');
    expect(stepPeekTab(s, -1)).toBe('b');
    expect(stepPeekTab(tabs(['a', 'b'], 'b'), 1)).toBeNull();
    expect(stepPeekTab(tabs(['a', 'b'], 'a'), 4)).toBe('b'); // more than once round
    expect(stepPeekTab(tabs(['a', 'b'], 'a'), -4)).toBeNull();
  });

  it('no tabs: always the own chat', () => {
    expect(stepPeekTab(NO_PEEK_TABS, 1)).toBeNull();
    expect(stepPeekTab(NO_PEEK_TABS, -3)).toBeNull();
  });
});

describe('the per-task record', () => {
  it('belongs to the panel\'s task, else its session', () => {
    expect(peekTabsKey('t1', 's1')).toBe('task:t1');
    expect(peekTabsKey(undefined, 's1')).toBe('session:s1');
    expect(peekTabsKey(undefined, '')).toBe('');
  });

  it('round-trips, and an empty set removes the record', () => {
    const store = memoryStorage();
    writePeekTabs(store, 'task:t1', tabs(['a', 'b'], 'b'));
    expect(store.map.get(`${PEEK_TABS_PREFIX}task:t1`)).toBe('{"tabs":["a","b"],"active":"b"}');
    expect(readPeekTabs(store, 'task:t1')).toEqual(tabs(['a', 'b'], 'b'));
    expect(readPeekTabs(store, 'task:t2')).toEqual(NO_PEEK_TABS);
    writePeekTabs(store, 'task:t1', NO_PEEK_TABS);
    expect(store.map.size).toBe(0);
  });

  it('a damaged record reads as no tabs, and a bad entry is dropped, not the whole set', () => {
    expect(parsePeekTabs(null)).toEqual(NO_PEEK_TABS);
    expect(parsePeekTabs('not json')).toEqual(NO_PEEK_TABS);
    expect(parsePeekTabs('"text"')).toEqual(NO_PEEK_TABS);
    expect(parsePeekTabs('{"tabs":"a"}')).toEqual(NO_PEEK_TABS);
    expect(parsePeekTabs(JSON.stringify({ tabs: ['a', 7, '', 'a', 'x'.repeat(129), 'b'], active: 'b' }))).toEqual(tabs(['a', 'b'], 'b'));
  });

  it('an active id with no tab falls back to the own chat', () => {
    expect(parsePeekTabs('{"tabs":["a"],"active":"gone"}')).toEqual(tabs(['a'], null));
    expect(parsePeekTabs('{"tabs":["a"],"active":5}')).toEqual(tabs(['a'], null));
  });

  it('keeps the newest tabs past the sanity bound', () => {
    const many = Array.from({ length: PEEK_TABS_STORED_MAX + 20 }, (_, i) => `t${i}`);
    const s = parsePeekTabs(JSON.stringify({ tabs: many, active: many.at(-1) }));
    expect(s.tabs).toHaveLength(PEEK_TABS_STORED_MAX);
    expect(s.tabs[0]).toBe('t20');
    expect(s.active).toBe(many.at(-1));
  });

  it('a storage that throws (blocked, full) never breaks the tabs', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(readPeekTabs(broken, 'task:t1')).toEqual(NO_PEEK_TABS);
    expect(() => writePeekTabs(broken, 'task:t1', tabs(['a'], 'a'))).not.toThrow();
    expect(readPeekTabs(null, 'task:t1')).toEqual(NO_PEEK_TABS);
  });
});
