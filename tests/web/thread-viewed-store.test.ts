/**
 * When each question was last viewed, kept per session in localStorage
 * (web/src/utils/thread-viewed-store.ts): merged by the later time, bounded per
 * session and across sessions, and tolerant of junk.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_VIEWED_PER_SESSION, MAX_VIEWED_SESSIONS, VIEWED_INDEX_KEY, VIEWED_PREFIX,
  mergeViewed, readViewed, sanitizeViewed, writeViewed,
} from '@/utils/thread-viewed-store';

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('mergeViewed', () => {
  it('keeps the later time per head', () => {
    expect(mergeViewed({ a: 1, b: 5 }, { a: 3, b: 2, c: 4 })).toEqual({ a: 3, b: 5, c: 4 });
  });
  it('keeps the newest heads when over the bound', () => {
    expect(mergeViewed({ a: 1, b: 2 }, { c: 3, d: 4 }, 2)).toEqual({ c: 3, d: 4 });
  });
});

describe('sanitizeViewed', () => {
  it('drops anything not a finite number under a non-empty key', () => {
    expect(sanitizeViewed({ a: 1, b: 'x', c: Infinity, '': 2, d: null })).toEqual({ a: 1 });
    expect(sanitizeViewed([1, 2])).toEqual({});
    expect(sanitizeViewed(null)).toEqual({});
  });
});

describe('readViewed / writeViewed', () => {
  it('a write survives a fresh read, merged with what another tab wrote', () => {
    const store = memStore();
    writeViewed('s1', { h1: 100 }, store, 1);
    store.setItem(`${VIEWED_PREFIX}s1`, JSON.stringify({ h1: 100, h2: 50 })); // another tab
    writeViewed('s1', { h1: 90, h3: 70 }, store, 2);
    expect(Object.fromEntries(readViewed('s1', store))).toEqual({ h1: 100, h2: 50, h3: 70 });
    expect(readViewed('other', store).size).toBe(0);
  });

  it('is bounded per session', () => {
    const store = memStore();
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_VIEWED_PER_SESSION + 25; i++) many[`h${i}`] = i;
    writeViewed('s1', many, store, 1);
    const kept = readViewed('s1', store);
    expect(kept.size).toBe(MAX_VIEWED_PER_SESSION);
    expect(kept.has('h0')).toBe(false);
    expect(kept.has(`h${MAX_VIEWED_PER_SESSION + 24}`)).toBe(true);
  });

  it('forgets the sessions written longest ago', () => {
    const store = memStore();
    for (let i = 0; i < MAX_VIEWED_SESSIONS + 3; i++) writeViewed(`s${i}`, { h: 1 }, store, 1000 + i);
    expect(readViewed('s0', store).size).toBe(0);
    expect(readViewed('s2', store).size).toBe(0);
    expect(readViewed('s3', store).size).toBe(1);
    expect(Object.keys(JSON.parse(store.getItem(VIEWED_INDEX_KEY)!)).length).toBe(MAX_VIEWED_SESSIONS);
  });

  it('junk in storage reads as nothing, and a broken store never throws', () => {
    const store = memStore();
    store.setItem(`${VIEWED_PREFIX}s1`, '{not json');
    expect(readViewed('s1', store).size).toBe(0);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(() => writeViewed('s1', { h: 1 }, broken)).not.toThrow();
    expect(readViewed('s1', broken).size).toBe(0);
  });
});
