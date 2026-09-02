/**
 * search() query-result memo: the TTL+LRU primitive, the cache key, and the
 * wired behaviour of search() itself.
 *
 * Why the memo exists: one /api/search fans out into three hybrid lanes PLUS a
 * whole-store task + session read, and identical queries arrive in bursts (the
 * AI-search child re-asks while it reasons, the browser re-issues on mount).
 * Measured on the live server under load 28 (2026-08-30): a query repeated
 * back-to-back still cost 1.08s and 1.37s after its 4.5s cold run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTtlLru,
  searchResultCacheKey,
  SEARCH_RESULT_CACHE_CAP,
  SEARCH_RESULT_CACHE_TTL_MS,
} from '../../src/core/search.js';

describe('createTtlLru', () => {
  it('returns a stored value, then forgets it after the TTL', () => {
    let now = 1_000;
    const cache = createTtlLru<string>({ ttlMs: 100, cap: 10, now: () => now });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    now += 99;
    expect(cache.get('k')).toBe('v');   // still inside the window
    now += 1;                            // exactly at the TTL is already stale
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);          // expiry also frees the slot
  });

  it('a read does NOT extend the TTL', () => {
    let now = 0;
    const cache = createTtlLru<string>({ ttlMs: 100, cap: 10, now: () => now });
    cache.set('k', 'v');
    now = 60;
    expect(cache.get('k')).toBe('v');
    now = 120;
    // Would still be alive if get() had re-dated the entry.
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the OLDEST key at the cap', () => {
    const cache = createTtlLru<number>({ ttlMs: 10_000, cap: 3, now: () => 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('d')).toBe(4);
  });

  it('a read promotes a key so the next eviction takes someone else', () => {
    const cache = createTtlLru<number>({ ttlMs: 10_000, cap: 3, now: () => 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1); // 'a' is now the youngest
    cache.set('d', 4);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined(); // 'b' was the oldest
  });

  it('re-setting a key replaces the value and re-dates it', () => {
    let now = 0;
    const cache = createTtlLru<string>({ ttlMs: 100, cap: 3, now: () => now });
    cache.set('k', 'old');
    now = 90;
    cache.set('k', 'new');
    now = 150;
    expect(cache.get('k')).toBe('new'); // 60ms into the SECOND write
    expect(cache.size).toBe(1);
  });

  it('clear() empties it', () => {
    const cache = createTtlLru<number>({ ttlMs: 100, cap: 3 });
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('ships the intended tuning: 20s TTL, 100 entries', () => {
    expect(SEARCH_RESULT_CACHE_TTL_MS).toBe(20_000);
    expect(SEARCH_RESULT_CACHE_CAP).toBe(100);
  });
});

describe('searchResultCacheKey', () => {
  it('is independent of the order the caller listed types in', () => {
    expect(searchResultCacheKey('q', ['session', 'task'], 20))
      .toBe(searchResultCacheKey('q', ['task', 'session'], 20));
  });

  it('separates different type sets, limits, and queries', () => {
    const base = searchResultCacheKey('q', ['task'], 20);
    expect(searchResultCacheKey('q', ['task', 'memory'], 20)).not.toBe(base);
    expect(searchResultCacheKey('q', ['task'], 50)).not.toBe(base);
    expect(searchResultCacheKey('other', ['task'], 20)).not.toBe(base);
  });

  it('collapses whitespace but PRESERVES case', () => {
    expect(searchResultCacheKey('  helm   crd  ', ['task'], 20))
      .toBe(searchResultCacheKey('helm crd', ['task'], 20));
    // Case reaches FTS tokenization and snippet extraction — not provably the
    // same request, so it must not collapse into one entry.
    expect(searchResultCacheKey('CDK', ['task'], 20))
      .not.toBe(searchResultCacheKey('cdk', ['task'], 20));
  });

  it('cannot be forged across fields by a query containing the separator', () => {
    // Distinct field values must never produce the same key.
    expect(searchResultCacheKey('a,b', ['task'], 20))
      .not.toBe(searchResultCacheKey('b', ['a', 'task'], 20));
  });
});

describe('search() memo (wired)', () => {
  const OLD_V2 = process.env.WALNUT_SEARCH_V2;
  const OLD_FLAG = process.env.WALNUT_SEARCH_RESULT_CACHE;

  beforeEach(() => {
    vi.resetModules();
    // QMD path: lets the memory lane be mocked by name without loading the v2
    // index (better-sqlite3 + embed worker) into a unit test.
    process.env.WALNUT_SEARCH_V2 = '0';
    // The memo is OFF by default under vitest (the suite mutates its mocked
    // stores between identical queries); these tests are the ones that want it.
    process.env.WALNUT_SEARCH_RESULT_CACHE = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/memory-search.js');
    if (OLD_V2 === undefined) delete process.env.WALNUT_SEARCH_V2;
    else process.env.WALNUT_SEARCH_V2 = OLD_V2;
    if (OLD_FLAG === undefined) delete process.env.WALNUT_SEARCH_RESULT_CACHE;
    else process.env.WALNUT_SEARCH_RESULT_CACHE = OLD_FLAG;
  });

  function mockLane() {
    const lane = vi.fn().mockResolvedValue([
      { title: 'Helm CRD update behavior', snippet: 'body about helm', filepath: '/m/a.md', finalScore: 0.9, source: 'memory' },
    ]);
    vi.doMock('../../src/core/memory-search.js', () => ({ memoryNotesSearch: lane }));
    return lane;
  }

  it('serves a repeated identical query without touching the lane again', async () => {
    const lane = mockLane();
    const { search } = await import('../../src/core/search.js');
    const first = await search('helm crd', { types: ['memory'] });
    const second = await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('hands out a defensive copy — a caller decorating a row cannot poison the memo', async () => {
    mockLane();
    const { search } = await import('../../src/core/search.js');
    const first = await search('helm crd', { types: ['memory'] });
    first[0].title = 'MUTATED BY CALLER';
    first[0].score = -999;
    first.push({ type: 'memory', title: 'injected', snippet: '', score: 1, matchField: 'memory' });

    const second = await search('helm crd', { types: ['memory'] });
    expect(second).toHaveLength(1);
    expect(second[0].title).toBe('Helm CRD update behavior');
    expect(second[0].score).toBeCloseTo(0.9, 5);
    // Rows are distinct objects, not the same references handed out twice.
    expect(second[0]).not.toBe(first[0]);
  });

  it('a different limit or type set is a different entry', async () => {
    const lane = mockLane();
    const { search } = await import('../../src/core/search.js');
    await search('helm crd', { types: ['memory'] });
    await search('helm crd', { types: ['memory'], limit: 5 });
    expect(lane).toHaveBeenCalledTimes(2);
    await search('helm crd', { types: ['memory'], limit: 5 });
    expect(lane).toHaveBeenCalledTimes(2);
  });

  it('clearSearchResultCache() forces the next query back to the lane', async () => {
    const lane = mockLane();
    const { search, clearSearchResultCache } = await import('../../src/core/search.js');
    await search('helm crd', { types: ['memory'] });
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(1);
    clearSearchResultCache();
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(2);
  });

  it('an empty query is never memoized (and never reaches the lane)', async () => {
    const lane = mockLane();
    const { search } = await import('../../src/core/search.js');
    expect(await search('   ', { types: ['memory'] })).toEqual([]);
    expect(await search('', { types: ['memory'] })).toEqual([]);
    expect(lane).not.toHaveBeenCalled();
  });

  it('a failing lane is NOT memoized — the next call retries', async () => {
    // A total outage throws so the browser keeps its local matches; caching the
    // throw would freeze that error in place for 20s after the store recovered.
    const lane = vi.fn().mockRejectedValue(new Error('store down'));
    vi.doMock('../../src/core/memory-search.js', () => ({ memoryNotesSearch: lane }));
    const { search } = await import('../../src/core/search.js');
    await expect(search('helm crd', { types: ['memory'] })).rejects.toThrow('store down');
    await expect(search('helm crd', { types: ['memory'] })).rejects.toThrow('store down');
    expect(lane).toHaveBeenCalledTimes(2);
  });

  it('a task/session write on the bus invalidates it — the memo never outlives an index write', async () => {
    // The staleness window is user-visible: this memo also fronts the frozen
    // /api/v1/search the iOS app calls, and its global section renders ONLY
    // server hits (the web TodoPanel hides the same gap behind a client-side
    // substring match). Create a task, search its title, and without this the
    // pre-create answer is served for the rest of the 20s TTL.
    const lane = mockLane();
    const { search } = await import('../../src/core/search.js');
    const { bus, EventNames } = await import('../../src/core/event-bus.js');
    await search('helm crd', { types: ['memory'] });
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(1);

    bus.emit(EventNames.TASK_CREATED, { taskId: 't-new' } as never, ['*']);
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(2);

    // Session content changes the session lane's answers too.
    bus.emit(EventNames.SESSION_CONTENT_UPDATED, { sessionId: 's-1' } as never, ['*']);
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(3);

    // An unrelated high-frequency event must NOT throw the memo away.
    bus.emit('session:text-delta', { sessionId: 's-1' } as never, ['*']);
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(3);
    bus.unsubscribe('search-result-cache');
  });

  it('WALNUT_SEARCH_RESULT_CACHE=0 turns the memo off', async () => {
    process.env.WALNUT_SEARCH_RESULT_CACHE = '0';
    const lane = mockLane();
    const { search } = await import('../../src/core/search.js');
    await search('helm crd', { types: ['memory'] });
    await search('helm crd', { types: ['memory'] });
    expect(lane).toHaveBeenCalledTimes(2);
  });
});
