/**
 * Strict Ask here questions are filed from their `<walnut-ask-answer>` tag alone
 * (web/src/utils/tagged-reply-split.ts fileStrictAnswers, read by every stored
 * reader through `ownerId`). 2026-11-03, the user: an Ask here question taken
 * mid-turn, then a compaction, then an answer without the old `[Q6]` tag: the
 * answer was filed in the main conversation and the card read "Answered" over
 * "No answer".
 */
import { describe, it, expect } from 'vitest';
import { splitIndexOf, splitTaggedReplies, type SplitRow } from '@/utils/tagged-reply-split';
import { buildThreadTree, threadKeyOf, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { headsBySeq, withTagAnchors } from '@/utils/question-tag';
import { deriveThreadStats } from '@/utils/thread-stack-state';
import { cardTurnsOf } from '@/utils/thread-card';
import { markStateOf } from '@/utils/thread-mark-state';
import { reviewTurnIndex } from '@/components/sessions/ThreadReviewSidebar';
import type { SessionHistoryMessage, SessionThreadAnchor } from '@/types/session';
import { strictAskRow } from './helpers/strict-ask';

type Row = SplitRow & { timestamp?: string; systemVariant?: 'compact' | 'error' | 'info'; injected?: boolean };
const AT = '2026-11-03T00:00:00Z';
const user = (msgId: string, text: string, extra: Partial<Row> = {}): Row => ({ role: 'user', msgId, text, ...extra });
const reply = (msgId: string, text: string, extra: Partial<Row> = {}): Row => ({ role: 'assistant', msgId, text, ...extra });
const ask = (msgId: string, text: string, thread: string, name: string, extra: Partial<Row> = {}): Row =>
  strictAskRow(msgId, text, thread, name, extra) as Row;
const span = (thread: string, name: string, body: string) =>
  `<walnut-ask-answer thread="${thread}" name="${name}">\n${body}\n</walnut-ask-answer>`;
const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
  ({ msgId, parent, quote: { exact }, source: 'selection', at: AT });

const BASE: Row[] = [
  user('u0', 'Explain the plan.'),
  reply('a0', 'Alpha line.\nBeta line.'),
];
const A6 = anchor('q6', 'a0', 'Alpha line.');
const A7 = anchor('q7', 'a0', 'Beta line.');
const K6 = threadKeyOf(A6);
const K7 = threadKeyOf(A7);

function read(rows: Row[], anchors: SessionThreadAnchor[], headBySeq: ReadonlyMap<number, string> = new Map()) {
  const split = splitTaggedReplies(rows);
  const tree = buildThreadTree(split as never, withTagAnchors(split as never, anchors, headBySeq));
  const keyOf = (id: string | undefined) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY;
  const stats = deriveThreadStats(split as never, keyOf);
  const words = (key: string) => split.filter((r) => r.role === 'assistant' && keyOf(r.msgId) === key && (r.text ?? '').trim()).map((r) => r.text);
  const card = (key: string) => cardTurnsOf(split, tree.byKey.get(key)).map((t) => t.replies.map((r) => r.text));
  const review = reviewTurnIndex(split as unknown as SessionHistoryMessage[]);
  return { split, tree, keyOf, stats, words, card, review };
}

describe('strict questions are answered by their tag alone', () => {
  it('(a) answered inside its tag: the tag is the answer, the turn\'s other words read in the main conversation', () => {
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', 'Let me check the file.', { tools: [{ name: 'Read' }] }),
      reply('a2', `${span('6', 'What is alpha', 'Alpha means one.')}\nI also updated the notes.`),
    ], [A6]);
    expect(r.words(K6)).toEqual(['Alpha means one.']);
    expect(r.words(ROOT_THREAD_KEY)).toEqual(['Alpha line.\nBeta line.', 'Let me check the file.', 'I also updated the notes.']);
    expect(r.card(K6)).toEqual([['Alpha means one.']]);
    expect(r.review.get('q6')?.reply?.text).toBe('Alpha means one.');
    expect(r.stats.answered.has('q6')).toBe(true);
    expect(r.stats.lastAnswer.get(K6)).toBe('Alpha means one.');
    expect(r.stats.unanswered.size).toBe(0);
    // The span keeps the reply's id (live blocks and anchors name it).
    expect(r.split.find((x) => x.text === 'Alpha means one.')?.msgId).toBe('a2');
  });

  it('(b) no tag: the question waits (never Answered, never No answer) and the main conversation keeps the text', () => {
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', 'Alpha means one.'),
      // The old tag is no filing mark for a strict question.
      reply('a2', '[Q6]\nStill alpha.'),
    ], [A6]);
    expect(r.words(K6)).toEqual([]);
    expect(r.words(ROOT_THREAD_KEY)).toEqual(['Alpha line.\nBeta line.', 'Alpha means one.', '[Q6]\nStill alpha.']);
    expect(r.card(K6)).toEqual([[]]);
    expect(r.review.get('q6')?.reply).toBeUndefined();
    expect(r.stats.answered.has('q6')).toBe(false);
    expect(r.stats.turnEnds.get('q6')).toBeUndefined();
    expect([...r.stats.unanswered]).toEqual([K6]);
    // What its mark and its card's head say.
    expect(markStateOf({ awaiting: true })).toBe('waiting');
    expect(markStateOf({ awaiting: true, answeredAt: 2, lastViewedAt: 1 })).toBe('waiting');
    expect(markStateOf({})).toBe('read');
  });

  it('(c) one message answering two questions: each tag to its own question', () => {
    const r = read([
      ...BASE,
      user('u1', 'Run the build.'),
      ask('queue-1', 'What is alpha?', '6', 'What is alpha', { sourceUuid: 'q6' }),
      ask('queue-2', 'What is beta?', '7', 'What is beta', { sourceUuid: 'q7' }),
      reply('a1', `The build passed.\n${span('6', 'What is alpha', 'Alpha means one.')}\n${span('7', 'What is beta', 'Beta means two.')}`),
    ], [A6, A7]);
    expect(r.words(K6)).toEqual(['Alpha means one.']);
    expect(r.words(K7)).toEqual(['Beta means two.']);
    expect(r.words(ROOT_THREAD_KEY)).toEqual(['Alpha line.\nBeta line.', 'The build passed.']);
    expect(r.card(K6)).toEqual([['Alpha means one.']]);
    expect(r.card(K7)).toEqual([['Beta means two.']]);
    // The main turn's own answer is still the main turn's.
    expect(r.review.get('u1')?.reply?.text).toBe('The build passed.');
  });

  it('(d) taken mid-turn, a compaction, answered in a later turn: filed under the question', () => {
    const r = read([
      ...BASE,
      user('u1', 'Refactor the module.'),
      reply('a1', '', { tools: [{ name: 'Edit' }] }),
      ask('queue-1', 'What is alpha?', '6', 'What is alpha', { sourceUuid: 'q6' }),
      reply('a2', 'The refactor is done.'),
      { role: 'system', msgId: 'c1', text: 'Conversation compacted', systemVariant: 'compact' },
      user('s1', 'This session is being continued from a previous conversation.', { injected: true }),
      reply('a3', `Picking the question back up.\n${span('6', 'What is alpha', 'Alpha means one.')}`),
    ], [A6]);
    expect(r.words(K6)).toEqual(['Alpha means one.']);
    expect(r.words(ROOT_THREAD_KEY)).toContain('The refactor is done.');
    expect(r.words(ROOT_THREAD_KEY)).toContain('Picking the question back up.');
    expect(r.card(K6)).toEqual([['Alpha means one.']]);
    expect(r.review.get('q6')?.reply?.text).toBe('Alpha means one.');
    expect(r.stats.answered.has('q6')).toBe(true);
    expect(r.stats.unanswered.size).toBe(0);
    // The main turn keeps its own words: the compaction's summary starts no turn
    // (isTurnHead), so its last words are the ones after the summary.
    expect(r.review.get('u1')?.reply?.text).toBe('Picking the question back up.');
  });

  it('a nested question (6.1) and a follow-up: each answer to its own thread and turn', () => {
    const A61 = anchor('q61', 'a6', 'Alpha means one.');
    const K61 = threadKeyOf(A61);
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a6', span('6', 'What is alpha', 'Alpha means one.')),
      ask('q61', 'Why one?', '6.1', 'Why one'),
      reply('a61', span('6.1', 'Why one', 'Because it is first.')),
      // A follow-up in question 6: its hint names the same id and the first send's name.
      ask('q6b', 'And two?', '6', 'What is alpha'),
      reply('a6b', `Sure.\n${span('6', 'What is alpha', 'Two is next.')}`),
    ], [A6, A61, { ...A6, msgId: 'q6b', source: 'manual' }]);
    expect(r.tree.byKey.get(K61)?.parentKey).toBe(K6);
    expect(r.words(K61)).toEqual(['Because it is first.']);
    expect(r.words(K6)).toEqual(['Alpha means one.', 'Two is next.']);
    expect(r.card(K6)).toEqual([['Alpha means one.'], ['Two is next.']]);
    expect(r.words(ROOT_THREAD_KEY)).toContain('Sure.');
  });

  it('a tag whose id or name matches no question stays as text where it is', () => {
    const wrongName = span('6', 'Something else', 'Not filed.');
    const noSuch = span('9', 'What is alpha', 'Not filed either.');
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', wrongName),
      reply('a2', noSuch),
      // The name compares with case and spacing folded, a trailing ellipsis ignored.
      reply('a3', span('6', 'what  is ALPHA…', 'Filed.')),
    ], [A6]);
    expect(r.words(K6)).toEqual(['Filed.']);
    expect(r.words(ROOT_THREAD_KEY)).toEqual(['Alpha line.\nBeta line.', wrongName, noSuch]);
  });

  it('a message ending in an answer hands its tool calls to the turn\'s own row', () => {
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', span('6', 'What is alpha', 'Alpha means one.'), { tools: [{ name: 'Bash' }] }),
    ], [A6]);
    const rows = r.split.filter((x) => x.msgId?.startsWith('a1'));
    expect(rows.map((x) => [x.text, !!x.tools, r.keyOf(x.msgId)])).toEqual([
      ['Alpha means one.', false, K6],
      ['', true, ROOT_THREAD_KEY],
    ]);
  });

  it('in a strict question\'s turn, an old question\'s `[Qn]` still files to that old question; the strict one\'s never does', () => {
    const banner = '[Question Q1]\nThis message is question 1 of this conversation. Begin your reply with the line "[Q1]".\n[/Question Q1]';
    const A1 = anchor('q1', 'a0', 'Beta line.');
    const K1 = threadKeyOf(A1);
    const r = read([
      ...BASE,
      user('q1', `${banner}\n\nWhat is beta?`),
      reply('a1', '[Q1]\nBeta means two.'),
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a2', span('6', 'What is alpha', 'Alpha means one.')),
      reply('a3', '[Q1]\nBack to beta.'),
      reply('a4', '[Q6]\nNot filed by the old tag.'),
    ], [A1, A6]);
    expect(r.words(K1)).toEqual(['[Q1]\nBeta means two.', '[Q1]\nBack to beta.']);
    expect(r.words(K6)).toEqual(['Alpha means one.']);
    expect(r.words(ROOT_THREAD_KEY)).toContain('[Q6]\nNot filed by the old tag.');
  });

  it('old-protocol rows read exactly as before (the same array back, the same stats)', () => {
    const oldHint = (n: string) => ({ hints: [{ kind: 'question', arg: n, text: `this message is question ${n} of this conversation.` }] });
    const old: Row[] = [
      ...BASE,
      user('q4', 'What is alpha?', oldHint('4')),
      reply('a1', '[Q4]\nAlpha means one.'),
      // A question whose turn has no reply at all (the CLI died, or the next
      // line was batched in): it reads `No answer`, never waiting.
      user('q5', 'What is beta?', oldHint('5')),
      user('u2', 'Next main line.'),
      reply('a2', 'Main reply.'),
    ];
    expect(splitTaggedReplies(old)).toBe(old);
    const anchors = [anchor('q4', 'a0', 'Alpha line.'), anchor('q5', 'a0', 'Beta line.')];
    const r = read(old, anchors);
    expect(r.card(threadKeyOf(anchors[0]))).toEqual([['[Q4]\nAlpha means one.']]);
    expect(r.stats.unanswered.size).toBe(0);
    expect([...r.stats.answered].sort()).toEqual(['q4', 'u0', 'u2']);
    expect([...r.stats.turnEnds]).toEqual([]);
    // What the stats say read straight off the transcript (no split) is the same.
    const raw = deriveThreadStats(old as never, r.keyOf);
    expect(raw.unanswered).toEqual(r.stats.unanswered);
    expect(raw.turnEnds).toEqual(r.stats.turnEnds);
    expect(raw.answered).toEqual(r.stats.answered);
  });

  it('a strict question whose turn ends in an API error reads failed (Retry), and the error is no takeaway', () => {
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', 'Let me look.', { tools: [{ name: 'Read' }] }),
      reply('a2', 'API Error: 529 overloaded'),
    ], [A6]);
    expect(r.stats.turnEnds.get('q6')).toBe('error');
    expect(r.stats.unanswered.size).toBe(0);
    expect(r.stats.lastAnswer.get(ROOT_THREAD_KEY)).not.toMatch(/API Error/);
    // The error row is the question's (its card shows how its turn ended).
    expect(r.keyOf('a2')).toBe(K6);
    expect(r.keyOf('a1')).toBe(ROOT_THREAD_KEY);
  });

  it('a strict question taken mid-turn whose turn then dies: both the turn and the question fail', () => {
    const r = read([
      ...BASE,
      user('u1', 'Refactor the module.'),
      reply('a1', '', { tools: [{ name: 'Edit' }] }),
      ask('queue-1', 'What is alpha?', '6', 'What is alpha', { sourceUuid: 'q6' }),
      reply('a2', 'API Error: 500'),
    ], [A6]);
    expect(r.stats.turnEnds.get('q6')).toBe('error');
    expect(r.stats.turnEnds.get('u1')).toBe('error');
    expect(r.stats.unanswered.size).toBe(0);
  });

  it('a follow-up whose hint names its question another way: a span naming either name files', () => {
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', span('6', 'What is alpha', 'Alpha means one.')),
      ask('q6b', 'And two?', '6', 'Alpha and two'),
      reply('a2', span('6', 'Alpha and two', 'Two is next.')),
      reply('a3', span('6', 'What is alpha', 'Still one.')),
    ], [A6, { ...A6, msgId: 'q6b', source: 'manual' }]);
    expect(r.words(K6)).toEqual(['Alpha means one.', 'Two is next.', 'Still one.']);
    expect(r.card(K6)).toEqual([['Alpha means one.'], ['Still one.']]);
  });

  it('a tag quoted in inline code files nothing: the main text after it stays main', () => {
    const r = read([
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', `${span('6', 'What is alpha', 'Alpha means one.')}`),
      user('u2', 'How do you answer a question?'),
      reply('a2', 'I write `<walnut-ask-answer thread="6" name="What is alpha">` first.\nThen the answer.'),
    ], [A6]);
    expect(r.words(K6)).toEqual(['Alpha means one.']);
    expect(r.keyOf('a2')).toBe(ROOT_THREAD_KEY);
    expect(r.split.find((x) => x.msgId === 'a2')?.text).toContain('`<walnut-ask-answer');
  });

  it('a mixed session: an old question\'s reply opening with a strict question\'s number does not move it', () => {
    const banner = '[Question Q1]\nThis message is question 1 of this conversation. Begin your reply with the line "[Q1]".\n[/Question Q1]';
    const A1 = anchor('q1', 'a0', 'Beta line.');
    const K1 = threadKeyOf(A1);
    const meta = [
      { headId: 'q6', status: 'open' as const, seq: 6, thread: '6', updatedAt: AT },
      { headId: 'q1', status: 'open' as const, seq: 1, updatedAt: AT },
    ];
    const rows = [
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a6', span('6', 'What is alpha', 'Alpha means one.')),
      user('q1', `${banner}\n\nWhat is beta?`),
      reply('a1', '[Q6]\nBeta means two.'),
    ];
    // The meta list never offers a strict question's number to the old tag ...
    expect(headsBySeq(meta)).toEqual(new Map([[1, 'q1']]));
    // ... and a list from elsewhere that does is ignored for a strict head.
    const r = read(rows, [A6, A1], new Map([[6, 'q6'], [1, 'q1']]));
    expect(r.keyOf('q1')).toBe(K1);
    expect(r.words(K1)).toEqual(['[Q6]\nBeta means two.']);
    expect(r.words(K6)).toEqual(['Alpha means one.']);
  });

  it('splitIndexOf: a transcript row\'s place among the split rows, owner-stamped copies included', () => {
    const rows: Row[] = [
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', 'Main words.'),
      reply('a2', `${span('6', 'What is alpha', 'Alpha.')}\nMore main.`),
    ];
    const split = splitTaggedReplies(rows);
    expect(split.indexOf(rows[3])).toBe(-1);
    expect(splitIndexOf(split, rows[3])).toBe(split.findIndex((m) => m.msgId === 'a1'));
    expect(split[splitIndexOf(split, rows[4])!].text).toBe('Alpha.');
    expect(splitIndexOf(split, rows[0])).toBe(0);
    expect(splitIndexOf(split, undefined)).toBeNull();
  });

  it('an unchanged transcript hands back the same row objects (memoized rows do not re-render)', () => {
    const rows: Row[] = [
      ...BASE,
      ask('q6', 'What is alpha?', '6', 'What is alpha'),
      reply('a1', `Main.\n${span('6', 'What is alpha', 'Alpha.')}`),
      reply('a2', 'Main again.'),
    ];
    const one = splitTaggedReplies(rows);
    const two = splitTaggedReplies([...rows]);
    expect(two).not.toBe(one);
    one.forEach((r, i) => expect(two[i]).toBe(r));
  });
});
