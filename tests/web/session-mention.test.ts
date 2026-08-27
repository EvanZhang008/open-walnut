/**
 * Unit tests for the unified "@" mention logic (session-mention.ts): how an
 * active "@query" routes (sessions-first / files-first / recents), the
 * in-memory fuzzy matcher + ranking that make the palette 0ms, directive
 * parsing, and that file refs / literal "@" text can never be mistaken for a
 * routable directive (they must fall through to a normal send).
 */
import { describe, it, expect } from 'vitest';
import {
  routeMention,
  fuzzyMatch,
  rankSessionMentions,
  parseSessionDirective,
  formatSessionRef,
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
  it('line-start "@" leads with sessions', () => {
    expect(routeMention(0, '')).toEqual({ kind: 'palette', order: 'sessions-first' });
    expect(routeMention(0, 'auth')).toEqual({ kind: 'palette', order: 'sessions-first' });
  });

  it('a path-shaped query leads with files — even at line start', () => {
    expect(routeMention(0, 'src/foo')).toEqual({ kind: 'palette', order: 'files-first' });
    expect(routeMention(0, '~/notes')).toEqual({ kind: 'palette', order: 'files-first' });
    expect(routeMention(0, 'src/')).toEqual({ kind: 'palette', order: 'files-first' });
  });

  it('mid-text "@" leads with files', () => {
    expect(routeMention(5, 'auth')).toEqual({ kind: 'palette', order: 'files-first' });
  });

  it('"@?" keeps the recents popup', () => {
    expect(routeMention(0, '?')).toEqual({ kind: 'recents' });
    expect(routeMention(0, '?wal')).toEqual({ kind: 'recents' });
    expect(routeMention(3, '?wal')).toEqual({ kind: 'recents' });
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

describe('rankSessionMentions', () => {
  const pool: SessionMentionCandidate[] = [
    s({ id: 'aaaa1111-x', title: 'Notification denoise', status: 'idle', lastActiveAt: '2026-08-26T00:00:00Z' }),
    s({ id: 'bbbb2222-x', title: 'Auth token refresh', status: 'running', lastActiveAt: '2026-08-25T00:00:00Z' }),
    s({ id: 'cccc3333-x', title: 'Old idle thing', status: 'idle', lastActiveAt: '2026-08-01T00:00:00Z' }),
  ];

  it('empty query: running sessions first, then recency', () => {
    const r = rankSessionMentions('', pool);
    expect(r.map((x) => x.session.id)).toEqual(['bbbb2222-x', 'aaaa1111-x', 'cccc3333-x']);
    expect(r[0].matchField).toBeNull();
  });

  it('fuzzy-matches the title with highlight positions', () => {
    const r = rankSessionMentions('noti', pool);
    expect(r[0].session.id).toBe('aaaa1111-x');
    expect(r[0].matchField).toBe('title');
    expect(r[0].positions).toEqual([0, 1, 2, 3]);
  });

  it('matches the short id too (typing a shortId finds the session)', () => {
    const r = rankSessionMentions('bbbb22', pool);
    expect(r[0].session.id).toBe('bbbb2222-x');
    expect(r[0].matchField).toBe('id');
  });

  it('excludes the current session and respects limit', () => {
    const r = rankSessionMentions('', pool, { excludeId: 'bbbb2222-x', limit: 1 });
    expect(r).toHaveLength(1);
    expect(r[0].session.id).toBe('aaaa1111-x');
  });

  it('drops non-matching sessions entirely', () => {
    expect(rankSessionMentions('zzzzzz', pool)).toHaveLength(0);
  });
});

describe('parseSessionDirective', () => {
  it('parses "@<ref> message"', () => {
    expect(parseSessionDirective('@e77d2af7 check the build')).toEqual({
      ref: 'e77d2af7',
      body: 'check the build',
    });
  });

  it('keeps multi-line bodies whole', () => {
    const r = parseSessionDirective('@abcd1234 line one\nline two');
    expect(r?.body).toBe('line one\nline two');
  });

  it('rejects non-directives', () => {
    expect(parseSessionDirective('hello @e77d2af7')).toBeNull(); // not at start
    expect(parseSessionDirective('@e77d2af7')).toBeNull(); // no message
    expect(parseSessionDirective('@ab hi')).toBeNull(); // ref too short (< 4)
    expect(parseSessionDirective('@src/foo.ts fix this')).toBeNull(); // path ref ("/" breaks \w match)
    expect(parseSessionDirective('@"my file.ts" fix')).toBeNull(); // quoted file ref
    expect(parseSessionDirective('@e77d2af7    ')).toBeNull(); // whitespace-only body
  });

  it('parses a name-like ref — resolution decides whether it routes', () => {
    // "@Makefile fix this" parses, but the server prefix lookup fails and the
    // caller falls through to a normal send. Pinned so nobody "optimizes" the
    // regex into rejecting these and nobody routes without resolving.
    expect(parseSessionDirective('@Makefile fix this')).toEqual({ ref: 'Makefile', body: 'fix this' });
  });
});

describe('formatSessionRef / resolveRefInIndex', () => {
  it('inserts the 8-char id prefix with a trailing space', () => {
    expect(formatSessionRef('e77d2af7-35fa-4de0-92e6-5a4826b9976f')).toBe('@e77d2af7 ');
  });

  it('resolves a UNIQUE prefix only (ambiguity mirrors the server 409)', () => {
    const pool = [s({ id: 'abcd1111' }), s({ id: 'abcd2222' }), s({ id: 'efgh3333' })];
    expect(resolveRefInIndex('efgh', pool)?.id).toBe('efgh3333');
    expect(resolveRefInIndex('abcd', pool)).toBeNull(); // ambiguous
    expect(resolveRefInIndex('zzzz', pool)).toBeNull(); // unknown
  });
});
