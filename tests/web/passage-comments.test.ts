/**
 * Quotes and comments on passages (web/src/utils/passage-comments.ts): what the
 * model receives on send, what a send turns them into, and how a record copy is
 * merged into ours.
 */
import { describe, it, expect } from 'vitest';
import {
  composeWithComments, countLabel, fitsAsComment, isPending, markRemoved, markSent, MAX_COMMENTS, mergeComments, pruneComments, snippetOf,
} from '@/utils/passage-comments';
import type { SessionPassageComment } from '@/types/session';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';
const T2 = '2026-11-01T10:09:00.000Z';
const item = (id: string, text: string, comment = '', over: Partial<SessionPassageComment> = {}): SessionPassageComment => ({
  id, msgId: `m-${id}`, role: 'assistant', quote: { exact: text.replace(/\n/g, '') }, text, comment, createdAt: T0, ...over,
});

describe('composeWithComments', () => {
  it('leaves a message with nothing pending untouched', () => {
    expect(composeWithComments([], '  hello ')).toBe('  hello ');
  });

  it('puts 3 quotes and 2 comments in the order added, ahead of the typed words', () => {
    const pending = [
      item('a', 'The reader trusts the newest copy.'),
      item('b', 'Old copies are kept for a day.\nThen they go.', 'Why a day?'),
      item('c', 'A stale copy is never served.'),
      // Non-ASCII passage and comment: CJK punctuation and an emoji.
      item('d', '\u4e00\u6761\u6570\u636e\u90fd\u62ff\u4e0d\u5230', '\u8fd9\u91cc\u4e3a\u4ec0\u4e48\uff1f \u{1F914}'),
      item('e', 'The cache is rebuilt at start.'),
    ];
    const message = composeWithComments(pending, 'Please answer each one.');
    expect(message).toBe([
      '> The reader trusts the newest copy.',
      '',
      '> Old copies are kept for a day.\n> Then they go.',
      '',
      'Why a day?',
      '',
      '> A stale copy is never served.',
      '',
      '> \u4e00\u6761\u6570\u636e\u90fd\u62ff\u4e0d\u5230',
      '',
      '\u8fd9\u91cc\u4e3a\u4ec0\u4e48\uff1f \u{1F914}',
      '',
      '> The cache is rebuilt at start.',
      '',
      'Please answer each one.',
    ].join('\n'));
  });

  it('sends the comments alone when nothing was typed, with no trailing blank lines', () => {
    expect(composeWithComments([item('a', 'One line.', 'A note.')], '   ')).toBe('> One line.\n\nA note.');
  });
});

describe('markSent', () => {
  it('turns the sent comments into marks, takes the sent plain quotes out, keeps one added since', () => {
    const list = [item('a', 'Quoted.'), item('b', 'Commented.', 'note'), item('c', 'Added during the send.', 'later')];
    const next = markSent(list, new Set(['a', 'b']), T1);
    expect(next.map((c) => [c.id, c.sentAt ?? null, c.removedAt ?? null])).toEqual([['a', T1, T1], ['b', T1, null], ['c', null, null]]);
    expect(next.filter(isPending).map((c) => c.id)).toEqual(['c']);
  });

  it('never re-stamps a comment that was already sent', () => {
    const list = [item('b', 'Commented.', 'note', { sentAt: T0 })];
    expect(markSent(list, new Set(['b']), T1)[0]!.sentAt).toBe(T0);
  });
});

describe('mergeComments', () => {
  it('a record copy older than our write loses nothing of ours', () => {
    const ours = [item('a', 'x', 'y'), item('b', 'z', 'w')];
    expect(mergeComments(ours, [item('a', 'x', 'y')])).toEqual(ours);
  });

  it('a stale copy cannot un-send a comment or bring a removed one back', () => {
    const ours = [item('a', 'x', 'y', { sentAt: T1 }), item('b', 'z', 'w', { removedAt: T1 })];
    const stale = [item('a', 'x', 'y'), item('b', 'z', 'w')];
    expect(mergeComments(ours, stale)).toEqual(ours);
    expect(mergeComments(stale, ours)).toEqual(ours);
  });

  it('another window: its entries and its sends join ours, ours stay', () => {
    const ours = [item('a', 'x', 'old'), item('n', 'new one', 'mine')];
    const theirs = [item('a', 'x', 'edited elsewhere', { updatedAt: T2 }), item('o', 'other window', 'theirs', { sentAt: T1 })];
    const merged = mergeComments(ours, theirs);
    expect(merged.map((c) => [c.id, c.comment, c.sentAt ?? null])).toEqual([['a', 'edited elsewhere', null], ['n', 'mine', null], ['o', 'theirs', T1]]);
  });
});

describe('pruneComments and the caps', () => {
  const now = Date.parse('2026-11-03T10:00:00.000Z');
  it('drops tombstones over a day old and keeps fresh ones', () => {
    const list = [item('old', 'x', '', { removedAt: '2026-11-01T09:00:00.000Z' }), item('new', 'x', '', { removedAt: '2026-11-03T09:00:00.000Z' }), item('p', 'x', 'y')];
    expect(pruneComments(list, now).map((c) => c.id)).toEqual(['new', 'p']);
  });

  it('past the cap the oldest sent marks go first, never a pending one', () => {
    const sent = Array.from({ length: MAX_COMMENTS }, (_, i) => item(`s${i}`, 'x', 'y', { sentAt: `2026-11-02T10:${String(i % 60).padStart(2, '0')}:00.000Z`, createdAt: `2026-11-02T0${Math.floor(i / 60)}:00:00.000Z` }));
    const out = pruneComments([...sent, item('p1', 'x', 'y'), item('p2', 'x', 'y')], now);
    expect(out).toHaveLength(MAX_COMMENTS);
    expect(out.filter(isPending).map((c) => c.id)).toEqual(['p1', 'p2']);
  });

  it('a passage or comment past the caps takes the text path', () => {
    expect(fitsAsComment('x'.repeat(4000), 'y', [])).toBe(true);
    expect(fitsAsComment('x'.repeat(4001), 'y', [])).toBe(false);
    expect(fitsAsComment('x', 'y'.repeat(4001), [])).toBe(false);
    const full = Array.from({ length: MAX_COMMENTS }, (_, i) => item(`p${i}`, 'x', 'y'));
    expect(fitsAsComment('x', 'y', full)).toBe(false);
    expect(fitsAsComment('x', 'y', markRemoved(full, 'p0', T1))).toBe(true);
  });
});

describe('labels', () => {
  it('counts comments and quotes the way the list head reads', () => {
    expect(countLabel([item('a', 'x', 'y')])).toBe('1 comment');
    expect(countLabel([item('a', 'x', 'y'), item('b', 'x', 'z')])).toBe('2 comments');
    expect(countLabel([item('a', 'x')])).toBe('1 quote');
    expect(countLabel([item('a', 'x', 'y'), item('b', 'x'), item('c', 'x')])).toBe('1 comment, 2 quotes');
  });

  it('folds a passage to one line and cuts it with an ellipsis', () => {
    expect(snippetOf('one\n\ntwo   three', 80)).toBe('one two three');
    expect(snippetOf('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}\u2026`);
  });
});
