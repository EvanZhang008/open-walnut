/**
 * Quotes and comments on passages (web/src/utils/passage-comments.ts): what the
 * model receives on send, what a send turns them into, and how a record copy is
 * merged into ours.
 */
import { describe, it, expect } from 'vitest';
import {
  composeWithComments, countLabel, DOC_COMMENTS_HOW, editComment, fitsAsComment, isMarked, isPending, markRemoved, markSent,
  MAX_COMMENT_CHARS, MAX_COMMENTS, mergeComments, mergeKeepingClaimed, pruneComments, recordNeedsWrite, settleSent, snippetOf,
} from '@/utils/passage-comments';
import type { SessionPassageComment } from '@/types/session';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';
const T2 = '2026-11-01T10:09:00.000Z';
const T3 = '2026-11-01T10:12:00.000Z';
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

describe('doc comments on the way to the model', () => {
  const doc = (id: string, text: string, comment: string, reply = false) => item(id, text, comment, {
    msgId: `doc:c-${id}`, role: 'user', doc: { path: '/notes/design.md', commentId: `c-${id}`, ...(reply ? { reply } : {}) },
  });

  it('puts the transcript ones first, then each doc one under its doc and id, then once how to answer, then the typed words', () => {
    const message = composeWithComments([doc('1', 'The cache is rebuilt.', 'Still true?'), item('a', 'Quoted.'), doc('2', 'Step two.', 'Done now', true)], 'Go.');
    expect(message).toBe([
      '> Quoted.',
      '',
      'Comment c-1 on `/notes/design.md` (thread in `/notes/design.md.comments.md`):',
      '> The cache is rebuilt.',
      '',
      'Still true?',
      '',
      'My reply in comment c-2 on `/notes/design.md` (thread in `/notes/design.md.comments.md`):',
      '> Step two.',
      '',
      'Done now',
      '',
      DOC_COMMENTS_HOW.trimEnd(),
      '',
      'Go.',
    ].join('\n'));
  });

  it('a sent doc comment leaves the tray and paints no transcript mark', () => {
    const list = [doc('1', 'The cache is rebuilt.', 'Still true?')];
    expect(isMarked(list[0]!)).toBe(false);
    expect(markSent(list, new Set(['1']), T1)[0]).toMatchObject({ sentAt: T1, removedAt: T1 });
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

describe('editComment (the card\'s Edit)', () => {
  const long = 'This paragraph says the reader trusts the newest copy, but the section before it says the oldest copy wins when two disagree. '
    + 'Which one is right? If the newest wins, the rule about stale copies in the third answer needs to change too, and the example with '
    + 'two windows reads the other way round. Please check both places and say which rule the code follows today.';

  it('changes a pending comment\'s words and stamps when, leaving the rest of the list alone', () => {
    expect(long.length).toBeGreaterThan(300);
    const list = [item('a', 'Quoted.'), item('b', 'Commented.', long), item('c', 'Other.', 'keep')];
    const next = editComment(list, 'b', `  ${long} Also the second answer.  `, T1);
    expect(next).not.toBe(list);
    expect(next[1]).toEqual({ ...list[1], comment: `${long} Also the second answer.`, updatedAt: T1 });
    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[2]);
    // The edited words are what the next send carries.
    expect(composeWithComments(next.filter(isPending), 'go')).toContain(`${long} Also the second answer.\n\n`);
    expect(composeWithComments(next.filter(isPending), 'go')).not.toContain(`${long}\n\n`);
  });

  it('gives a plain Quote words: it becomes a comment (and so a sent mark later)', () => {
    const next = editComment([item('a', 'Quoted.')], 'a', 'Why here?', T1);
    expect(next[0]!.comment).toBe('Why here?');
    expect(markSent(next, new Set(['a']), T2)[0]).toMatchObject({ sentAt: T2 });
    expect(markSent(next, new Set(['a']), T2)[0]!.removedAt).toBeUndefined();
  });

  it('keeps Unicode words as typed', () => {
    const words = 'Is \u201cnewest\u201d right? \u4e3a\u4ec0\u4e48 \ud83e\udd14';
    expect(editComment([item('a', 'x', 'old')], 'a', words, T1)[0]!.comment).toBe(words);
  });

  it('refuses a sent one, a removed one, a doc\'s, a missing id, empty words, words past the cap, and the same words', () => {
    const list = [
      item('sent', 'x', 'went', { sentAt: T1 }),
      item('gone', 'x', 'out', { removedAt: T1 }),
      item('doc', 'x', 'in doc', { doc: { path: '/notes/plan.md', commentId: 'c-0a1b2c3d' } }),
      item('p', 'x', 'pending'),
    ];
    for (const [id, words] of [
      ['sent', 'new'], ['gone', 'new'], ['doc', 'new'], ['missing', 'new'], ['p', '   '], ['p', ''], ['p', 'x'.repeat(MAX_COMMENT_CHARS + 1)], ['p', ' pending '],
    ] as const) expect(editComment(list, id, words, T2), `${id} / ${words.length}`).toBe(list);
    expect(editComment(list, 'p', 'x'.repeat(MAX_COMMENT_CHARS), T2)[3]!.comment).toHaveLength(MAX_COMMENT_CHARS);
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

  it('an edit is kept over a stale copy, and over a reload of the record from before it', () => {
    const edited = editComment([item('a', 'x', 'first words')], 'a', 'second words', T1);
    const stale = [item('a', 'x', 'first words')];
    expect(mergeComments(edited, stale)[0]!.comment).toBe('second words');
    expect(mergeComments(stale, edited)[0]!.comment).toBe('second words');
  });

  it('an edit made while another window sent it never rewrites the sent words (either order, either clock)', () => {
    const sentThere = [item('a', 'x', 'words that went', { sentAt: T1 })];
    // Our edit is stamped AFTER the send: newest-wins alone would take our words.
    const editedHere = editComment([item('a', 'x', 'words that went')], 'a', 'late edit', T2);
    for (const merged of [mergeComments(editedHere, sentThere), mergeComments(sentThere, editedHere)]) {
      expect(merged[0]).toMatchObject({ comment: 'words that went', sentAt: T1 });
      expect(isPending(merged[0]!)).toBe(false);
    }
    // A removal elsewhere still wins over an edit here.
    const removedThere = [item('a', 'x', 'words that went', { removedAt: T1 })];
    expect(mergeComments(editedHere, removedThere)[0]!.removedAt).toBe(T1);
  });
});

describe('a send in flight meets another window\'s edit (mergeKeepingClaimed)', () => {
  it('the claimed words stay until the send settles, then the sent copy keeps them everywhere', () => {
    // Window A claimed "as claimed" for its send; window B edits the same item later.
    const ours = [item('a', 'x', 'as claimed'), item('b', 'y', 'free')];
    const record = [
      item('a', 'x', 'edited in window B', { updatedAt: T2 }),
      item('b', 'y', 'b edited too', { updatedAt: T2 }),
      item('n', 'z', 'new from B'),
    ];
    const met = mergeKeepingClaimed(ours, record, new Set(['a']));
    expect(met.map((c) => [c.id, c.comment])).toEqual([['a', 'as claimed'], ['b', 'b edited too'], ['n', 'new from B']]);
    // Plain mergeComments would have let B's newer edit in: the send would then stamp words the model never read.
    expect(mergeComments(ours, record)[0]!.comment).toBe('edited in window B');
    // Accepted: sent on the claimed words; B's unsent edit meeting it later loses.
    const sent = markSent(met, new Set(['a']), T3);
    expect(sent[0]).toMatchObject({ comment: 'as claimed', sentAt: T3 });
    expect(mergeComments(record, sent)[0]).toMatchObject({ comment: 'as claimed', sentAt: T3 });
    expect(mergeComments(sent, record)[0]).toMatchObject({ comment: 'as claimed', sentAt: T3 });
  });

  it('a refused send gives it back: the newer edit from the other window wins again', () => {
    const ours = [item('a', 'x', 'as claimed')];
    const record = [item('a', 'x', 'edited in window B', { updatedAt: T2 })];
    expect(mergeKeepingClaimed(ours, record, new Set(['a']))[0]!.comment).toBe('as claimed');
    expect(mergeKeepingClaimed(ours, record, new Set())[0]!.comment).toBe('edited in window B');
  });

  it('a send given back after a stale window wrote the claimed item away: it stays ours and the record needs it again', () => {
    const now = Date.parse('2026-11-01T11:00:00.000Z');
    const ours = [item('a', 'x', 'as claimed'), item('b', 'y', 'kept')];
    const staleRecord = [item('b', 'y', 'kept')];
    // While held, the record's lack of it is not acted on.
    expect(recordNeedsWrite(mergeKeepingClaimed(ours, staleRecord, new Set(['a'])), staleRecord, now, new Set(['a']))).toBe(false);
    // Given back (settle refused): merged again with the newest record, it is still here, and must be written back.
    const back = mergeKeepingClaimed(ours, staleRecord, new Set());
    expect(back.filter(isPending).map((c) => c.id)).toEqual(['a', 'b']);
    expect(recordNeedsWrite(back, staleRecord, now)).toBe(true);
  });

  it('an accepted send keeps a removal another window made meanwhile, and its own words', () => {
    const carried = new Map([['a', item('a', 'x', 'as claimed')]]);
    const ours = [item('a', 'x', 'as claimed'), item('c', 'z', 'held by another send')];
    const record = [
      item('a', 'x', 'edited then removed in window B', { updatedAt: T1, removedAt: T2 }),
      item('c', 'z', 'edited in window B', { updatedAt: T2 }),
    ];
    const settled = markSent(settleSent(ours, record, carried, new Set(['c'])), new Set(['a']), T3);
    expect(settled[0]).toMatchObject({ comment: 'as claimed', removedAt: T2 });
    expect(settled[0]!.sentAt).toBeUndefined();
    expect(isPending(settled[0]!)).toBe(false);
    // An item another send still holds stays as held.
    expect(settled[1]!.comment).toBe('held by another send');
    // Not removed elsewhere: stamped sent on the carried words, over an edit that came in meanwhile.
    const plain = markSent(settleSent([item('a', 'x', 'as claimed')], [item('a', 'x', 'late edit', { updatedAt: T2 })], carried), new Set(['a']), T3);
    expect(plain[0]).toMatchObject({ comment: 'as claimed', sentAt: T3 });
  });

  it('two windows stamping one item at different times agree on the earliest, so neither writes again', () => {
    const now = Date.parse('2026-11-01T11:00:00.000Z');
    const a = [item('s', 'x', 'went', { sentAt: T1 }), item('r', 'y', '', { removedAt: T2 })];
    const b = [item('s', 'x', 'went', { sentAt: T2 }), item('r', 'y', '', { removedAt: T1 })];
    const ab = mergeComments(a, b);
    const ba = mergeComments(b, a);
    expect(ab).toEqual(ba);
    expect(ab.map((c) => [c.sentAt ?? null, c.removedAt ?? null])).toEqual([[T1, null], [null, T1]]);
    // Each window writes its merge; the other reads it and finds nothing to add.
    expect(recordNeedsWrite(mergeComments(a, ab), ab, now)).toBe(false);
    expect(recordNeedsWrite(mergeComments(b, ba), ba, now)).toBe(false);
  });

  it('two copies edited at the same instant settle on the same words in either order', () => {
    const a = [item('a', 'x', 'alpha', { updatedAt: T2 })];
    const b = [item('a', 'x', 'beta', { updatedAt: T2 })];
    expect(mergeComments(a, b)[0]!.comment).toBe(mergeComments(b, a)[0]!.comment);
  });
});

describe('recordNeedsWrite (a stale window wrote over ours)', () => {
  const now = Date.parse('2026-11-01T11:00:00.000Z');
  it('a record that lost our edit, our send or our removal needs ours again', () => {
    const ours = [item('a', 'x', 'edited', { updatedAt: T2 }), item('s', 'y', 'went', { sentAt: T1 }), item('r', 'z', '', { removedAt: T1 })];
    expect(recordNeedsWrite(ours, [item('a', 'x', 'old'), ours[1]!, ours[2]!], now)).toBe(true);
    expect(recordNeedsWrite(ours, [ours[0]!, item('s', 'y', 'went'), ours[2]!], now)).toBe(true);
    expect(recordNeedsWrite(ours, [ours[0]!, ours[1]!, item('r', 'z', '')], now)).toBe(true);
    expect(recordNeedsWrite(ours, [ours[0]!, ours[1]!], now)).toBe(true);
  });

  it('the echo of our own write needs nothing (no loop), whatever else the record holds', () => {
    const ours = [item('a', 'x', 'edited', { updatedAt: T2 }), item('s', 'y', 'went', { sentAt: T1 })];
    // The server keeps what a write stores; an entry of another window's is not ours to rewrite.
    const echo = JSON.parse(JSON.stringify([...pruneComments(ours, now), item('o', 'w', 'other window')]));
    expect(recordNeedsWrite(ours, echo, now)).toBe(false);
    // Merged with its echo, ours is unchanged, so the next check is the same: it converges.
    expect(recordNeedsWrite(mergeComments(ours, echo), echo, now)).toBe(false);
  });

  it('a tombstone a write would drop, and an item a send has claimed, are left alone', () => {
    const old = item('t', 'x', '', { removedAt: '2026-10-30T09:00:00.000Z' });
    expect(recordNeedsWrite([old], [], now)).toBe(false);
    expect(recordNeedsWrite([item('a', 'x', 'as claimed')], [item('a', 'x', 'edited in window B', { updatedAt: T2 })], now, new Set(['a']))).toBe(false);
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
    // In the order the list starts with.
    expect(countLabel([item('b', 'x'), item('a', 'x', 'y'), item('c', 'x')])).toBe('2 quotes, 1 comment');
  });

  it('folds a passage to one line and cuts it with an ellipsis', () => {
    expect(snippetOf('one\n\ntwo   three', 80)).toBe('one two three');
    expect(snippetOf('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}\u2026`);
  });
});
