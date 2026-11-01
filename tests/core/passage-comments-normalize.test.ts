/**
 * `passage_comments` validation (src/core/sessions/session-lifecycle.ts): the
 * quotes and comments the selection pill keeps on a session record.
 */
import { describe, it, expect } from 'vitest';
import { normalizePassageComments } from '../../src/core/sessions/session-lifecycle.js';

const T0 = '2026-11-01T10:00:00.000Z';
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'c-1', msgId: 'm-1', role: 'assistant', quote: { exact: 'The reader trusts it.', prefix: 'so ' },
  text: 'The reader trusts it.', comment: 'Why?', createdAt: T0, ...over,
});

describe('normalizePassageComments', () => {
  it('keeps a valid list as it is, in order', () => {
    const list = [entry(), entry({ id: 'c-2', comment: '', sentAt: T0, updatedAt: T0, removedAt: T0 })];
    expect(normalizePassageComments(list)).toEqual([
      { id: 'c-1', msgId: 'm-1', role: 'assistant', quote: { exact: 'The reader trusts it.', prefix: 'so ' }, text: 'The reader trusts it.', comment: 'Why?', createdAt: T0 },
      { id: 'c-2', msgId: 'm-1', role: 'assistant', quote: { exact: 'The reader trusts it.', prefix: 'so ' }, text: 'The reader trusts it.', comment: '', createdAt: T0, updatedAt: T0, sentAt: T0, removedAt: T0 },
    ]);
  });

  it('keeps the first copy of a repeated id, and reads an unknown role as the reply', () => {
    const out = normalizePassageComments([entry(), entry({ comment: 'second' }), entry({ id: 'c-3', role: 'tool' })]);
    expect(out.map((c) => [c.id, c.comment, c.role])).toEqual([['c-1', 'Why?', 'assistant'], ['c-3', 'Why?', 'assistant']]);
  });

  it('keeps non-ASCII words as given', () => {
    const words = '\u8fd9\u4e00\u53e5\u5bf9\u5417\uff1f';
    expect(normalizePassageComments([entry({ comment: words })])[0]!.comment).toBe(words);
  });

  it.each([
    ['not-a-list', /passage_comments must be an array/],
    [[null], /each passage_comments entry must be an object/],
    [[entry({ id: '' })], /passage_comments\[\]\.id/],
    [[entry({ msgId: 7 })], /passage_comments\[\]\.msgId/],
    [[entry({ quote: { exact: '' } })], /passage_comments\[\]\.quote\.exact/],
    [[entry({ text: ' ' })], /passage_comments\[\]\.text/],
    [[entry({ comment: 'x'.repeat(4001) })], /passage_comments\[\]\.comment/],
    [[entry({ sentAt: 5 })], /passage_comments\[\]\.sentAt/],
    [[entry({ removedAt: 'x'.repeat(41) })], /passage_comments\[\]\.removedAt/],
    [[entry({ text: 'x'.repeat(4001) })], /passage_comments\[\]\.text/],
    [[entry({ quote: { exact: 'x'.repeat(2001) } })], /passage_comments\[\]\.quote\.exact/],
    [[entry({ doc: 'design.md' })], /passage_comments\[\]\.doc must be an object/],
    [[entry({ doc: { path: 'design.md', commentId: 'c-1' } })], /doc\.path must be an absolute path/],
    [[entry({ doc: { path: '/d.md', commentId: '' } })], /doc\.commentId/],
    [[entry({ doc: { path: '/d.md', commentId: 'c-1', host: 3 } })], /doc\.host/],
  ])('refuses %j', (value, message) => {
    expect(() => normalizePassageComments(value)).toThrow(message);
  });

  it('keeps a doc pointer, dropping an empty host and a reply flag that is not true', () => {
    const out = normalizePassageComments([
      entry({ doc: { path: '/notes/d.md', commentId: 'c-0a1b2c3d', host: '', reply: 'yes', extra: 1 } }),
      entry({ id: 'c-2', doc: { path: '/notes/d.md', commentId: 'c-0a1b2c3d', host: 'devbox', reply: true } }),
    ]);
    expect(out.map((c) => c.doc)).toEqual([
      { path: '/notes/d.md', commentId: 'c-0a1b2c3d' },
      { path: '/notes/d.md', commentId: 'c-0a1b2c3d', host: 'devbox', reply: true },
    ]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 101 }, (_, i) => entry({ id: `c-${i}` }));
    expect(() => normalizePassageComments(many)).toThrow(/at most 100/);
  });
});
