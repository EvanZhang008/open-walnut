/**
 * The comment card's pure parts (web/src/utils/thread-card.ts): which rows a
 * question's card shows, how the question reads without its quote, where the
 * card sits, and which passages wear a mark in Conversation Mode.
 */
import { describe, expect, it } from 'vitest';
import { buildThreadTree, quoteBlockOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import { allPassageMarks, cardTurnsOf, placeCard, questionBodyOf, CARD_GAP, CARD_GROWN_WIDTH, CARD_MIN_WIDTH, CARD_WIDTH } from '@/utils/thread-card';
import type { SessionThreadAnchor } from '@/types/session';

const quote = { exact: 'the flush order', prefix: '', suffix: '' };
const rows: Array<ThreadTreeMessage & { tools?: unknown[] }> = [
  { role: 'user', msgId: 'r1', text: 'Explain the buffer.' },
  { role: 'assistant', msgId: 'a1', text: 'It flushes in the flush order you set.' },
  { role: 'user', msgId: 'q1', text: `${quoteBlockOf(quote)}\n\nWhy that order?` },
  { role: 'assistant', msgId: 'a2', text: '', tools: [{ name: 'Read' }] },
  { role: 'assistant', msgId: 'a3', text: 'Because the reader skips.' },
  { role: 'user', msgId: 'r2', text: 'Back to the main line.' },
  { role: 'assistant', msgId: 'a4', text: 'Sure.' },
  { role: 'user', msgId: 'q1b', text: '(Back to the earlier thread about “Why that order?”)\n\n> the flush order\n\nAnd on restart?' },
  { role: 'assistant', msgId: 'a5', text: 'Replayed from the journal.' },
];
const anchors: SessionThreadAnchor[] = [
  { msgId: 'q1', parent: 'a1', quote, source: 'selection', at: '2026-09-30T00:00:00Z' },
  { msgId: 'q1b', parent: 'a1', quote, source: 'manual', at: '2026-09-30T00:01:00Z' },
];

describe('cardTurnsOf', () => {
  it('groups each turn of the question with the prose rows of its reply, skipping tool-only rows', () => {
    const tree = buildThreadTree(rows, anchors);
    const node = tree.byRow.get('q1')!;
    const turns = cardTurnsOf(rows, tree.byKey.get(node.key));
    expect(turns.map((t) => t.user.msgId)).toEqual(['q1', 'q1b']);
    expect(turns[0].replies.map((r) => r.msgId)).toEqual(['a3']);
    expect(turns[1].replies.map((r) => r.msgId)).toEqual(['a5']);
  });

  it('is empty for no node and for a node whose rows are not loaded', () => {
    expect(cardTurnsOf(rows, undefined)).toEqual([]);
    const tree = buildThreadTree(rows, anchors);
    const node = tree.byKey.get(tree.byRow.get('q1')!.key)!;
    expect(cardTurnsOf(rows.slice(0, 2), node)).toEqual([]);
  });
});

describe('questionBodyOf', () => {
  it('drops the quoted passage the send composed in front of the question', () => {
    expect(questionBodyOf(`${quoteBlockOf(quote)}\n\nWhy that order?`)).toBe('Why that order?');
  });
  it('drops the orientation line and the quote together', () => {
    expect(questionBodyOf('(Back to the earlier thread about “x”)\n\n> the flush order\n\nAnd on restart?')).toBe('And on restart?');
    expect(questionBodyOf('(Back to the main conversation)\n\nNext topic.')).toBe('Next topic.');
  });
  it('drops a leading reply-tag banner', () => {
    const banner = '[Question Q2]\nThis message is question 2. Begin your reply with the line "[Q2]".\n[/Question Q2]';
    expect(questionBodyOf(`${banner}\n\n> the flush order\n\nWhy?`)).toBe('Why?');
  });
  it('drops the file line a file question leads with, with the quote after it', () => {
    expect(questionBodyOf('About `/repo/docs/cache.md:12`:\n\n> late flush\n\nWhy keep both?')).toBe('Why keep both?');
    expect(questionBodyOf('(Back to the earlier thread about “x”)\n\nAbout `/repo/docs/cache.md`:\n\n> late flush\n\nMore?')).toBe('More?');
    // A question that merely starts with "About" keeps its words.
    expect(questionBodyOf('About that: why?')).toBe('About that: why?');
  });
  it('keeps a plain question, and a question that is only a quote', () => {
    expect(questionBodyOf('Why that order?')).toBe('Why that order?');
    expect(questionBodyOf('> only a quote')).toBe('> only a quote');
    expect(questionBodyOf('a multi\nline question')).toBe('a multi\nline question');
  });
});

describe('placeCard', () => {
  const anchor = { top: 100, bottom: 120, left: 40, right: 500 };
  it('sits below the passage, right edges aligned, at the preferred width', () => {
    expect(placeCard(anchor, 900)).toEqual({ top: 120 + CARD_GAP, left: 500 - CARD_WIDTH, width: CARD_WIDTH });
  });
  it('expanded (the grown width): the same top, its right edge still on the passage when there is room', () => {
    const wide = { ...anchor, right: 1200 };
    expect(placeCard(wide, 1400, CARD_GROWN_WIDTH)).toEqual({ top: 120 + CARD_GAP, left: 1200 - CARD_GROWN_WIDTH, width: CARD_GROWN_WIDTH });
    expect(placeCard(anchor, 900, CARD_GROWN_WIDTH)).toEqual({ top: 120 + CARD_GAP, left: 0, width: 900 });
  });
  it('never leaves the layer on the left or the right', () => {
    expect(placeCard({ ...anchor, right: 200 }, 900).left).toBe(0);
    expect(placeCard({ ...anchor, right: 950 }, 900).left).toBe(900 - CARD_WIDTH);
  });
  it('shrinks to a narrow layer, never below the layer itself', () => {
    expect(placeCard(anchor, 300)).toEqual({ top: 128, left: 0, width: 300 });
    expect(placeCard(anchor, 200).width).toBe(200);
    expect(CARD_MIN_WIDTH).toBeLessThan(CARD_WIDTH);
  });
});

describe('allPassageMarks', () => {
  it('marks every question with a passage, whichever reply it is about, as neutral', () => {
    const nested: SessionThreadAnchor[] = [
      ...anchors,
      { msgId: 'r2', parent: 'a3', quote: { exact: 'reader skips', prefix: '', suffix: '' }, source: 'selection', at: '2026-09-30T00:02:00Z' },
    ];
    const tree = buildThreadTree(rows, nested);
    const marks = allPassageMarks(tree, new Set(), new Map());
    expect(marks.map((m) => m.parentMsgId).sort()).toEqual(['a1', 'a3']);
    expect(marks.every((m) => m.neutral)).toBe(true);
    expect(marks.find((m) => m.parentMsgId === 'a1')?.headId).toBe('q1');
  });
  it('leaves hidden questions out', () => {
    const tree = buildThreadTree(rows, anchors);
    const key = tree.byRow.get('q1')!.key;
    expect(allPassageMarks(tree, new Set([key]), new Map())).toEqual([]);
  });
});
