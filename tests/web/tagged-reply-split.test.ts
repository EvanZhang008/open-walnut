/**
 * Questions answered inside the running turn's reply (web/src/utils/tagged-reply-split.ts).
 *
 * The real-CLI shape (2026-10-29 acceptance run, Opus): two questions sent while a
 * turn ran reach the model as mid-turn `queue-…` rows, and the turn's final reply
 * answers all three in one message, each answer under its `[Qn]` line. Before the
 * split the whole reply was filed under the last question: question 1 read New,
 * the main conversation lost its own answer.
 */
import { describe, it, expect } from 'vitest';
import { cutAtTags, splitTaggedReplies, type SplitRow } from '@/utils/tagged-reply-split';
import { buildThreadTree, threadKeyOf, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { withTagAnchors } from '@/utils/question-tag';
import { deriveThreadStats } from '@/utils/thread-stack-state';
import { cardTurnsOf } from '@/utils/thread-card';
import type { SessionThreadAnchor } from '@/types/session';

type Row = SplitRow & { timestamp?: string };
const user = (msgId: string, text: string): Row => ({ role: 'user', msgId, text });
/** A question that ran mid-turn: a `queue-…` row carrying the uuid it was sent under. */
const midTurn = (msgId: string, sourceUuid: string, text: string, seq: number): Row =>
  ({ role: 'user', msgId, sourceUuid, text, hints: [{ kind: 'question', arg: String(seq) }] });
const reply = (msgId: string, text: string, extra: Partial<Row> = {}): Row => ({ role: 'assistant', msgId, text, ...extra });
const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
  ({ msgId, parent, quote: { exact }, source: 'selection', at: '2026-10-29T00:00:00Z' });

const TURN = [
  user('u0', 'Explain the plan.'),
  reply('a0', 'Alpha line.\nBeta line.'),
  user('u1', 'Run sleep 30, then reply ROOT-DONE.'),
  reply('a1', '', { tools: [{ name: 'Bash' }] }),
  midTurn('queue-1', 'src-q1', 'What is alpha?', 1),
  midTurn('queue-2', 'src-q2', 'What is beta?', 2),
  reply('a2', 'ROOT-DONE\n\n[Q1]\nAlpha means one.\n\n[Q2]\nBeta means two.'),
];

describe('cutAtTags', () => {
  it('cuts at line-start tags of the given questions only', () => {
    expect(cutAtTags('Done.\n[Q1]\nOne.\n[Q2]: Two.', new Set([1, 2]))).toEqual([
      { seq: null, text: 'Done.' }, { seq: 1, text: '[Q1]\nOne.' }, { seq: 2, text: '[Q2]: Two.' },
    ]);
    // A tag for a question that is not in this turn, or one inside a line, stays text.
    expect(cutAtTags('See [Q1] above.\n[Q7]\nx', new Set([1]))).toEqual([{ seq: null, text: 'See [Q1] above.\n[Q7]\nx' }]);
    expect(cutAtTags('**[Q1]**\nOne.', new Set([1]))).toEqual([{ seq: 1, text: '**[Q1]**\nOne.' }]);
    // A tag quoted inside a code block stays text.
    expect(cutAtTags('The format is:\n```\n[Q1]\nanswer\n```\n[Q1]\nReal.', new Set([1]))).toEqual([
      { seq: null, text: 'The format is:\n```\n[Q1]\nanswer\n```' }, { seq: 1, text: '[Q1]\nReal.' },
    ]);
  });
});

describe('splitTaggedReplies', () => {
  it('files the turn first, then each question with the part under its tag', () => {
    const rows = splitTaggedReplies(TURN);
    expect(rows.map((r) => [r.msgId, r.text])).toEqual([
      ['u0', 'Explain the plan.'], ['a0', 'Alpha line.\nBeta line.'],
      ['u1', 'Run sleep 30, then reply ROOT-DONE.'], ['a1', ''], ['a2', 'ROOT-DONE'],
      ['queue-1', 'What is alpha?'], ['a2~1', '[Q1]\nAlpha means one.'],
      ['queue-2', 'What is beta?'], ['a2~2', '[Q2]\nBeta means two.'],
    ]);
  });

  it('every question reads answered and the main conversation keeps its reply', () => {
    const rows = splitTaggedReplies(TURN);
    const anchors = [anchor('src-q1', 'a0', 'Alpha line.'), anchor('src-q2', 'a0', 'Beta line.')];
    const tree = buildThreadTree(rows as never, withTagAnchors(rows as never, anchors, new Map([[1, 'src-q1'], [2, 'src-q2']])));
    const k1 = threadKeyOf(anchors[0]);
    const k2 = threadKeyOf(anchors[1]);
    expect(tree.byRow.get('a2')?.key).toBe(ROOT_THREAD_KEY);
    expect(tree.byRow.get('a2~1')?.key).toBe(k1);
    expect(tree.byRow.get('a2~2')?.key).toBe(k2);
    const stats = deriveThreadStats(rows as never, (id) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY);
    expect([...stats.answered].sort()).toEqual(['src-q1', 'src-q2', 'u0', 'u1']);
    expect(cardTurnsOf(rows, tree.byKey.get(k1))[0].replies.map((r) => r.text)).toEqual(['[Q1]\nAlpha means one.']);
  });

  it('a tag hands what follows it to its question, as the live view files it', async () => {
    const rows = splitTaggedReplies([
      user('u1', 'Run two commands.'),
      midTurn('queue-1', 'src-q1', 'Why?', 1),
      reply('a1', 'First step done.\n[Q1]\nBecause.', { tools: [{ name: 'Bash' }], thinking: 'plan' }),
      reply('a2', 'Both commands ran.'),
    ]);
    expect(rows.map((r) => [r.msgId, r.text])).toEqual([
      ['u1', 'Run two commands.'], ['a1', 'First step done.'],
      ['queue-1', 'Why?'], ['a1~1', '[Q1]\nBecause.'], ['a2', 'Both commands ran.'],
    ]);
    // The row's id stays on its first part with its thinking; its tool calls follow the tag.
    expect(rows.find((r) => r.msgId === 'a1')).toMatchObject({ thinking: 'plan' });
    expect(rows.find((r) => r.msgId === 'a1')?.tools).toBeUndefined();
    expect(rows.find((r) => r.msgId === 'a1~1')?.tools).toEqual([{ name: 'Bash' }]);
  });

  it('hands the same part objects back while the rows are the same', () => {
    const a = splitTaggedReplies(TURN);
    const b = splitTaggedReplies([...TURN]);
    expect(b).not.toBe(a);
    expect(b.find((r) => r.msgId === 'a2~1')).toBe(a.find((r) => r.msgId === 'a2~1'));
  });

  it('changes nothing without a mid-turn question or without its tag', () => {
    const plain = [user('u1', 'hi'), reply('a1', 'Done.\n[Q1]\nx')];
    expect(splitTaggedReplies(plain)).toBe(plain);
    // The model answered without the tag: the rows stay as the transcript has them.
    const untagged = [user('u1', 'go'), midTurn('queue-1', 'src-q1', 'Why?', 1), reply('a1', 'Because.')];
    expect(splitTaggedReplies(untagged)).toBe(untagged);
    // An idle-time question is its own turn already.
    const idle = [user('u1', 'go'), reply('a1', 'ok'), { ...user('u2', 'Why?'), hints: [{ kind: 'question', arg: '1' }] }, reply('a2', '[Q1]\nBecause.')];
    expect(splitTaggedReplies(idle)).toBe(idle);
  });

  it('stops at the next turn the CLI ran on its own', () => {
    const rows = splitTaggedReplies([
      user('u1', 'go'),
      midTurn('queue-1', 'src-q1', 'Why?', 1),
      reply('a1', 'Done.\n[Q1]\nBecause.'),
      user('u2', 'next'),
      reply('a2', '[Q1]\nnot for the earlier turn'),
    ]);
    expect(rows.map((r) => r.msgId)).toEqual(['u1', 'a1', 'queue-1', 'a1~1', 'u2', 'a2']);
  });
});
