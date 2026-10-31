/**
 * The "@" picker's source tabs (web/src/components/chat/mention-sources-model.ts):
 * keyword jumps, tab cycling, the exact-match rule of the mixed "All" view, and when an
 * arrow key switches tabs instead of moving the caret.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_TAB,
  arrowSwitchesTab,
  cycleTab,
  isPreciseMatch,
  parseKeywordScope,
  preciseRowsForAll,
  tabsOf,
  type MentionSourceInfo,
} from '@/components/chat/mention-sources-model';

const SOURCES: MentionSourceInfo[] = [
  { id: 'notes', label: 'Notes', keywords: ['notes', 'note', 'no'], kinds: ['note'], minChars: 0 },
  { id: 'slack', label: 'Slack', keywords: ['slack', 'sl'], kinds: ['person', 'channel'], minChars: 0 },
  { id: 'mail', label: 'Mail', keywords: ['mail', 'ma'], kinds: ['message'], minChars: 0 },
];

describe('parseKeywordScope', () => {
  it('a keyword or alias followed by a space jumps to its source', () => {
    expect(parseKeywordScope('slack deploy', SOURCES)).toEqual({ sourceId: 'slack', keyword: 'slack', rest: 'deploy' });
    expect(parseKeywordScope('SL memory spike', SOURCES)).toEqual({ sourceId: 'slack', keyword: 'SL', rest: 'memory spike' });
    expect(parseKeywordScope('mail ', SOURCES)).toEqual({ sourceId: 'mail', keyword: 'mail', rest: '' });
  });

  it('the keyword alone, an unknown word, or a path is an ordinary search', () => {
    expect(parseKeywordScope('slack', SOURCES)).toBeNull();
    expect(parseKeywordScope('deploy alerts', SOURCES)).toBeNull();
    expect(parseKeywordScope('src/slack x', SOURCES)).toBeNull();
    expect(parseKeywordScope('slack x', [])).toBeNull();
  });
});

describe('tabs', () => {
  it('All first, then each source; cycling wraps both ways', () => {
    const tabs = tabsOf(SOURCES);
    expect(tabs).toEqual([ALL_TAB, 'notes', 'slack', 'mail']);
    expect(cycleTab(tabs, ALL_TAB, 1)).toBe('notes');
    expect(cycleTab(tabs, 'mail', 1)).toBe(ALL_TAB);
    expect(cycleTab(tabs, ALL_TAB, -1)).toBe('mail');
    expect(cycleTab(tabs, 'gone', 1)).toBe('notes');
  });
});

describe('isPreciseMatch / preciseRowsForAll', () => {
  it('only the exact title or a declared key counts, case and @/# and separators aside', () => {
    expect(isPreciseMatch('alice chen', { ref: 'u', title: 'Alice Chen' })).toBe(true);
    expect(isPreciseMatch('@alice', { ref: 'u', title: 'Alice Chen', keys: ['alice'] })).toBe(true);
    expect(isPreciseMatch('deploy-alerts', { ref: 'c', title: '#deploy_alerts' })).toBe(true);
    expect(isPreciseMatch('alice', { ref: 'u', title: 'Alice Chen' })).toBe(false);
    expect(isPreciseMatch('deploy', { ref: 'c', title: '#deploy-alerts' })).toBe(false);
    expect(isPreciseMatch('a', { ref: 'u', title: 'A' })).toBe(false);
  });

  it('caps rows per source and overall, in source order', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `r${i}`, title: 'Deploy' }));
    const out = preciseRowsForAll('deploy', [
      { sourceId: 'notes', rows: [{ ref: 'loose', title: 'Deploy notes' }, ...rows(3)] },
      { sourceId: 'slack', rows: rows(3) },
      { sourceId: 'mail', rows: rows(3) },
    ]);
    expect(out.map((r) => `${r.sourceId}:${r.row.ref}`)).toEqual(['notes:r0', 'notes:r1', 'slack:r0']);
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
