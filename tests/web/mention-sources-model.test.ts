/**
 * The "@" picker's tabs (web/src/components/chat/mention-sources-model.ts): All, Tasks,
 * then each source; keyword jumps; tab cycling; which sources the mixed "All" view asks
 * (every one, each in its lane) and how many rows each shows; and when an arrow key
 * switches tabs instead of moving the caret.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_BELOW_ROWS_EACH,
  ALL_BELOW_ROWS_MAX,
  ALL_TAB,
  ALL_TOP_ROWS,
  allPlan,
  arrowSwitchesTab,
  cycleTab,
  isPreciseMatch,
  parseKeywordScope,
  rowsForAll,
  tabsOf,
  TASKS_TAB,
  type MentionSourceInfo,
} from '@/components/chat/mention-sources-model';

const SOURCES: MentionSourceInfo[] = [
  { id: 'notes', label: 'Notes', keywords: ['notes', 'note', 'no'], kinds: ['note'], minChars: 0, lane: 'top' },
  { id: 'slack', label: 'Slack', keywords: ['slack', 'sl'], kinds: ['person', 'channel'], minChars: 0 },
  { id: 'mail', label: 'Mail', keywords: ['mail', 'ma'], kinds: ['message'], minChars: 0 },
];

describe('parseKeywordScope', () => {
  it('a keyword or alias followed by a space jumps to its source', () => {
    expect(parseKeywordScope('slack deploy', SOURCES)).toEqual({ sourceId: 'slack', keyword: 'slack', rest: 'deploy' });
    expect(parseKeywordScope('SL memory spike', SOURCES)).toEqual({ sourceId: 'slack', keyword: 'SL', rest: 'memory spike' });
    expect(parseKeywordScope('mail ', SOURCES)).toEqual({ sourceId: 'mail', keyword: 'mail', rest: '' });
    expect(parseKeywordScope('tasks deploy', SOURCES)).toEqual({ sourceId: TASKS_TAB, keyword: 'tasks', rest: 'deploy' });
    expect(parseKeywordScope('Task x', [])).toEqual({ sourceId: TASKS_TAB, keyword: 'Task', rest: 'x' });
  });

  it('the keyword alone, an unknown word, or a path is an ordinary search', () => {
    expect(parseKeywordScope('slack', SOURCES)).toBeNull();
    expect(parseKeywordScope('deploy alerts', SOURCES)).toBeNull();
    expect(parseKeywordScope('src/slack x', SOURCES)).toBeNull();
    expect(parseKeywordScope('slack x', [])).toBeNull();
  });
});

describe('tabs', () => {
  it('All, Tasks, then each source in the server order; cycling wraps both ways', () => {
    const tabs = tabsOf(SOURCES);
    expect(tabs).toEqual([ALL_TAB, TASKS_TAB, 'notes', 'slack', 'mail']);
    expect(tabsOf([])).toEqual([ALL_TAB, TASKS_TAB]);
    expect(cycleTab(tabs, ALL_TAB, 1)).toBe(TASKS_TAB);
    expect(cycleTab(tabs, 'mail', 1)).toBe(ALL_TAB);
    expect(cycleTab(tabs, ALL_TAB, -1)).toBe('mail');
    expect(cycleTab(tabs, 'gone', 1)).toBe(TASKS_TAB);
  });
});

describe('allPlan: All asks every source, each in its lane', () => {
  it('a top source (Notes) is asked from the bare "@", every other one from two letters on', () => {
    expect(allPlan(SOURCES, '')).toEqual({ top: ['notes'], below: [] });
    expect(allPlan(SOURCES, 'd')).toEqual({ top: ['notes'], below: [] });
    expect(allPlan(SOURCES, 'de')).toEqual({ top: ['notes'], below: ['slack', 'mail'] });
  });

  it('a source without a lane (an older server) is below; minChars and a path still hold it back', () => {
    const old: MentionSourceInfo[] = SOURCES.map(({ lane: _lane, ...s }) => ({ ...s, inAll: false }));
    expect(allPlan(old, 'deploy')).toEqual({ top: [], below: ['notes', 'slack', 'mail'] });
    expect(allPlan([{ ...SOURCES[1], minChars: 4 }], 'dep')).toEqual({ top: [], below: [] });
    expect(allPlan(SOURCES, 'src/de')).toEqual({ top: [], below: [] });
  });

  it('GUARD: every source, now or later, lands in exactly one lane for an ordinary query', () => {
    // A new source (whatever its fields) is asked in All: no flag can leave it out.
    const any: MentionSourceInfo[] = [
      ...SOURCES,
      { id: 'future', label: 'Future', keywords: [], kinds: [], minChars: 0, inAll: false },
      { id: 'future2', label: 'Future 2', keywords: ['f2'], kinds: ['thing'], minChars: 0, lane: 'below' },
    ];
    const plan = allPlan(any, 'deploy');
    for (const src of any) {
      expect([...plan.top, ...plan.below].filter((id) => id === src.id), src.id).toHaveLength(1);
    }
  });
});

describe('isPreciseMatch / rowsForAll', () => {
  it('only the exact title or a declared key counts, case and @/# and separators aside', () => {
    expect(isPreciseMatch('alice chen', { ref: 'u', title: 'Alice Chen' })).toBe(true);
    expect(isPreciseMatch('@alice', { ref: 'u', title: 'Alice Chen', keys: ['alice'] })).toBe(true);
    expect(isPreciseMatch('deploy-alerts', { ref: 'c', title: '#deploy_alerts' })).toBe(true);
    expect(isPreciseMatch('alice', { ref: 'u', title: 'Alice Chen' })).toBe(false);
    expect(isPreciseMatch('deploy', { ref: 'c', title: '#deploy-alerts' })).toBe(false);
  });

  it('shows loose matches too, exact ones first, capped per lane and below overall', () => {
    const rows = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ ref: `${p}${i}`, title: `${p} deploy ${i}` }));
    const out = rowsForAll('deploy', [
      { sourceId: 'notes', lane: 'top', rows: rows('n', 5) },
      { sourceId: 'slack', lane: 'below', rows: [...rows('s', 3), { ref: 'exact', title: '#deploy' }] },
      { sourceId: 'mail', lane: 'below', rows: rows('m', 3) },
      { sourceId: 'a', lane: 'below', rows: rows('a', 3) },
      { sourceId: 'b', lane: 'below', rows: rows('b', 3) },
    ]);
    const ids = (id: string) => out.filter((r) => r.sourceId === id).map((r) => r.row.ref);
    expect(ids('notes')).toHaveLength(ALL_TOP_ROWS);
    expect(ids('slack')).toEqual(['exact', 's0']);
    expect(ids('mail')).toHaveLength(ALL_BELOW_ROWS_EACH);
    expect(out.filter((r) => r.lane === 'below')).toHaveLength(ALL_BELOW_ROWS_MAX);
    expect(ids('b')).toEqual([]);
  });
});

describe('arrowSwitchesTab', () => {
  const base = { caret: 5, hasSelection: false, atIndex: 0, end: 5, justSwitched: false };
  it('→ at the end of the query, ← right after the "@"', () => {
    expect(arrowSwitchesTab({ ...base, key: 'ArrowRight' })).toBe(true);
    expect(arrowSwitchesTab({ ...base, key: 'ArrowRight', caret: 3 })).toBe(false);
    expect(arrowSwitchesTab({ ...base, key: 'ArrowLeft' })).toBe(false);
    expect(arrowSwitchesTab({ ...base, key: 'ArrowLeft', caret: 1 })).toBe(true);
    expect(arrowSwitchesTab({ ...base, key: 'ArrowLeft', caret: 1, end: 1 })).toBe(true);
  });

  it('either arrow keeps switching right after a switch; a selection never switches', () => {
    expect(arrowSwitchesTab({ ...base, key: 'ArrowLeft', justSwitched: true })).toBe(true);
    expect(arrowSwitchesTab({ ...base, key: 'ArrowRight', hasSelection: true })).toBe(false);
  });
});
