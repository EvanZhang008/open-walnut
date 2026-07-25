/**
 * Byte-budget eviction for the two parsed-content caches
 * (parsedHistoryCache in session-history.ts, changesCache in session-changes.ts).
 *
 * Regression target: both caches used to bound ENTRY COUNT only (30), while a
 * single entry could retain a 164MB transcript's parsed form — 30 whale entries
 * held ~600MB and the resulting major-GC pauses froze the event loop for 8-50s
 * ("Quick Session not loading" incident, 2026-07-19). These tests pin:
 *   1. total accounted chars never exceed the budget after inserts (except the
 *      newest-entry exemption),
 *   2. eviction is LRU (oldest keys drop first),
 *   3. delete/re-insert accounting never drifts (sum matches live entries).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _historyCacheGetForTesting,
  _historyCacheSetForTesting,
  _historyCacheStateForTesting,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';
import {
  _changesCacheGetForTesting,
  _changesCacheSetForTesting,
  _changesCacheStateForTesting,
  _resetChangesCacheForTesting,
  _setChangesCacheBudgetForTesting,
} from '../../src/core/session-changes.js';

const MB = 1024 * 1024;
const BUDGET = 64 * MB;
// The changes-cache half builds REAL strings (entryChars walks actual content),
// so it runs against a shrunken test budget — MB-scale allocations across
// parallel vitest workers were an OOM risk. The history half keeps MB units:
// its approxChars is a plain number, nothing is allocated.
const KB = 1024;
const CHANGES_BUDGET = 64 * KB;

describe('parsedHistoryCache byte budget', () => {
  beforeEach(() => _resetHistoryCacheForTesting());

  const entry = (chars: number) => ({ mtimeMs: 1, messages: [], approxChars: chars });

  it('evicts oldest entries once total chars exceed the budget', () => {
    // 5 × 20MB = 100MB > 64MB budget → the two oldest must go.
    for (let i = 0; i < 5; i++) _historyCacheSetForTesting(`sid-${i}`, entry(20 * MB));
    const state = _historyCacheStateForTesting();
    expect(state.keys).toEqual(['sid-2', 'sid-3', 'sid-4']);
    expect(state.chars).toBe(60 * MB);
    expect(state.chars).toBeLessThanOrEqual(BUDGET);
  });

  it('promotes a cache hit before byte-budget eviction', () => {
    _historyCacheSetForTesting('a', entry(20 * MB));
    _historyCacheSetForTesting('b', entry(20 * MB));
    expect(_historyCacheGetForTesting('a')).toBeDefined();
    _historyCacheSetForTesting('c', entry(30 * MB));
    expect(_historyCacheStateForTesting().keys).toEqual(['a', 'c']);
  });

  it('keeps a single whale entry even when it alone exceeds the budget', () => {
    _historyCacheSetForTesting('small', entry(1 * MB));
    _historyCacheSetForTesting('whale', entry(200 * MB));
    const state = _historyCacheStateForTesting();
    expect(state.keys).toEqual(['whale']);
    expect(state.chars).toBe(200 * MB);
  });

  it('re-inserting the same key replaces its accounting instead of double-counting', () => {
    _historyCacheSetForTesting('sid', entry(30 * MB));
    _historyCacheSetForTesting('sid', entry(10 * MB));
    const state = _historyCacheStateForTesting();
    expect(state.size).toBe(1);
    expect(state.chars).toBe(10 * MB);
  });

  it('still enforces the entry-count bound for many small entries', () => {
    for (let i = 0; i < 40; i++) _historyCacheSetForTesting(`sid-${i}`, entry(1000));
    const state = _historyCacheStateForTesting();
    expect(state.size).toBe(30);
    expect(state.chars).toBe(30 * 1000);
  });
});

describe('changesCache byte budget', () => {
  beforeEach(() => {
    _resetChangesCacheForTesting();
    _setChangesCacheBudgetForTesting(CHANGES_BUDGET);
  });

  // Entry whose retained chars come from file before/after content.
  const entry = (chars: number) => ({
    mtimeMs: 1,
    result: {
      sessionId: 's',
      fileCount: 1,
      anyPartial: false,
      groups: [{
        repoRoot: '/r', label: 'r', kind: 'cwd' as const,
        files: [{
          filePath: '/r/f', relPath: 'f',
          before: 'a'.repeat(Math.floor(chars / 2)),
          after: 'b'.repeat(Math.ceil(chars / 2)),
          status: 'modified' as const, ops: 1, partial: false,
        }],
      }],
    },
    gitRootByDir: new Map<string, string | null>(),
  });

  it('evicts oldest entries once total chars exceed the budget', () => {
    for (let i = 0; i < 5; i++) _changesCacheSetForTesting(`sid-${i}`, entry(20 * KB));
    const state = _changesCacheStateForTesting();
    expect(state.keys).toEqual(['sid-2', 'sid-3', 'sid-4']);
    expect(state.chars).toBe(60 * KB);
  });

  it('promotes a cache hit before byte-budget eviction', () => {
    _changesCacheSetForTesting('a', entry(20 * KB));
    _changesCacheSetForTesting('b', entry(20 * KB));
    expect(_changesCacheGetForTesting('a')).toBeDefined();
    _changesCacheSetForTesting('c', entry(30 * KB));
    expect(_changesCacheStateForTesting().keys).toEqual(['a', 'c']);
  });

  it('accounts incremental op payloads (Edit old/new + Write content)', () => {
    const withInc = {
      ...entry(1 * KB),
      inc: {
        parsedBytes: 0, lastLineStart: 0, lastLineCheck: null,
        mainFileMap: new Map([[
          '/r/f',
          { filePath: '/r/f', ops: [
            { kind: 'edit' as const, oldString: 'x'.repeat(2 * KB), newString: 'y'.repeat(2 * KB), replaceAll: false },
            { kind: 'write' as const, content: 'z'.repeat(3 * KB) },
          ] },
        ]]),
      },
    };
    _changesCacheSetForTesting('sid', withInc);
    expect(_changesCacheStateForTesting().chars).toBe(8 * KB);
  });

  it('keeps a single whale entry even when it alone exceeds the budget', () => {
    _changesCacheSetForTesting('small', entry(1 * KB));
    _changesCacheSetForTesting('whale', entry(200 * KB));
    const state = _changesCacheStateForTesting();
    expect(state.keys).toEqual(['whale']);
  });

  it('re-inserting the same key replaces its accounting instead of double-counting', () => {
    _changesCacheSetForTesting('sid', entry(30 * KB));
    _changesCacheSetForTesting('sid', entry(10 * KB));
    const state = _changesCacheStateForTesting();
    expect(state.size).toBe(1);
    expect(state.chars).toBe(10 * KB);
  });
});
