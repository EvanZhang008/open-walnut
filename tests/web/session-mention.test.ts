/**
 * Unit tests for the unified "@" mention logic (session-mention.ts): how an
 * active "@query" routes (entities-first / files-first / recents), the
 * in-memory fuzzy matcher that makes the palette 0ms, and the unique-prefix
 * resolver the provenance card uses. Entity ranking lives in
 * mention-entities.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  routeMention,
  fuzzyMatch,
  resolveRefInIndex,
  type SessionMentionCandidate,
} from '../../web/src/components/chat/session-mention';

const s = (over: Partial<SessionMentionCandidate>): SessionMentionCandidate => ({
  id: 'e77d2af7-35fa-4de0-92e6-5a4826b9976f',
  title: 'Fix flaky auth test',
  host: '__local__',
  status: 'idle',
  lastActiveAt: '2026-08-27T00:00:00Z',
  ...over,
});

describe('routeMention', () => {
  it('a bare or word-shaped query leads with the entity groups, wherever the "@" sits', () => {
    expect(routeMention('')).toEqual({ kind: 'palette', order: 'entities-first' });
    expect(routeMention('auth')).toEqual({ kind: 'palette', order: 'entities-first' });
  });

  it('a path-shaped query leads with files — the user is clearly typing a path', () => {
    expect(routeMention('src/foo')).toEqual({ kind: 'palette', order: 'files-first' });
    expect(routeMention('~/notes')).toEqual({ kind: 'palette', order: 'files-first' });
    expect(routeMention('src/')).toEqual({ kind: 'palette', order: 'files-first' });
  });

  it('"@?" keeps the recents popup', () => {
    expect(routeMention('?')).toEqual({ kind: 'recents' });
    expect(routeMention('?wal')).toEqual({ kind: 'recents' });
  });
});

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively with positions', () => {
    const m = fuzzyMatch('noti', 'Notification denoise');
    expect(m?.positions).toEqual([0, 1, 2, 3]);
    // Best alignment wins, not the leftmost: "a[nd] [d]edup" is tighter than
    // "[N]otification [d]enoise an[d]".
    expect(fuzzyMatch('ndd', 'Notification denoise and dedup')?.positions).toEqual([22, 23, 25]);
  });

  it('returns null when a char is missing, and empty positions for empty query', () => {
    expect(fuzzyMatch('xyz', 'Notification')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ positions: [], score: 0 });
  });

  it('scores tight word-boundary matches above scattered ones', () => {
    const tight = fuzzyMatch('auth', 'auth service')!;
    const scattered = fuzzyMatch('auth', 'a menu with three helpers')!;
    expect(tight.score).toBeGreaterThan(scattered.score);
  });

  it('is not fooled by an early first-char hit (greedy trap)', () => {
    // A single greedy pass grabs the "t" in "Walnut" and shreds the tight
    // "target" word at the end — the best-alignment retry must find it.
    const m = fuzzyMatch('target', 'Walnut mention e2e target')!;
    expect(m.positions).toEqual([19, 20, 21, 22, 23, 24]);
    const decoy = fuzzyMatch('target', 'Task drag between projects')!;
    expect(m.score).toBeGreaterThan(decoy.score);
  });
});

describe('resolveRefInIndex', () => {
  it('resolves a UNIQUE prefix only (ambiguity mirrors the server 409)', () => {
    const pool = [s({ id: 'abcd1111' }), s({ id: 'abcd2222' }), s({ id: 'efgh3333' })];
    expect(resolveRefInIndex('efgh', pool)?.id).toBe('efgh3333');
    expect(resolveRefInIndex('abcd', pool)).toBeNull(); // ambiguous
    expect(resolveRefInIndex('zzzz', pool)).toBeNull(); // unknown
  });
});
