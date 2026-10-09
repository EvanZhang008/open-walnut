/**
 * Question numbers and the `[Qn]` reply tag (web/src/utils/question-tag.ts).
 *
 * The tag is how an answer says which question it belongs to, so the cases
 * here are the ones that used to lose an answer: a turn whose user row lost
 * its pre-assigned uuid (resume fallback), two sends merged into one turn, a
 * reply that opens with bold or a blank line before the tag. Filing by tag
 * has to beat Walnut's turn-order guess in every one of them, and a tag for a
 * question that does not exist has to change nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  QUESTION_BANNER_RE, headsBySeq, keysBySeq, nextQuestionSeq, parseQuestionTag,
  questionBanner, questionBannerName, questionNumbers, stripQuestionTag,
  blockTagKeys, tagKeyAtBlock, tagKeyOfBlocks, tagKeysOfBlocks, withQuestionBanner, withTagAnchors,
} from '@/utils/question-tag';
import { buildThreadTree, threadKeyOf, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import type { ThreadTreeMessage } from '@/utils/thread-tree';
import { indexMeta } from '@/utils/thread-meta';
import type { SessionThreadAnchor, SessionThreadMeta } from '@/types/session';

const user = (msgId: string, text = `q ${msgId}`): ThreadTreeMessage => ({ role: 'user', msgId, text });
const reply = (msgId: string, text = `a ${msgId}`): ThreadTreeMessage => ({ role: 'assistant', msgId, text });
const anchor = (msgId: string, parent: string, extra: Partial<SessionThreadAnchor> = {}): SessionThreadAnchor =>
  ({ msgId, parent, source: 'selection', at: '2026-09-03T10:00:00Z', ...extra });
const meta = (headId: string, extra: Partial<SessionThreadMeta> = {}): SessionThreadMeta =>
  ({ headId, status: 'open', updatedAt: '2026-09-03T10:00:00Z', ...extra });

describe('parseQuestionTag / stripQuestionTag', () => {
  it('reads the tag at the start of a reply and strips exactly that line', () => {
    expect(parseQuestionTag('[Q4]\nThe answer.')).toEqual({ seq: 4, rest: 'The answer.' });
    expect(stripQuestionTag('[Q4]\nThe answer.')).toBe('The answer.');
    // Same line, with a colon or a space inside the brackets.
    expect(parseQuestionTag('[Q 12]: yes')?.seq).toBe(12);
    expect(stripQuestionTag('[Q 12]: yes')).toBe('yes');
  });

  it('allows bold markers and leading blank lines, the way models actually write it', () => {
    expect(parseQuestionTag('**[Q2]**\n\nBody')).toEqual({ seq: 2, rest: 'Body' });
    expect(parseQuestionTag('\n\n[Q7]\nBody')?.seq).toBe(7);
    expect(parseQuestionTag('__[Q3]__ Body')).toEqual({ seq: 3, rest: 'Body' });
  });

  it('leaves everything else alone', () => {
    expect(parseQuestionTag('Sure. [Q4] is what you asked')).toBeNull();
    expect(parseQuestionTag('[Q0]\nzero is not a question')).toBeNull();
    expect(parseQuestionTag('[Question 4]\nnot the tag')).toBeNull();
    expect(parseQuestionTag('')).toBeNull();
    expect(parseQuestionTag(undefined)).toBeNull();
    const plain = 'No tag here.\n[Q4] later on';
    expect(stripQuestionTag(plain)).toBe(plain);
  });

  it('keeps the body verbatim after the tag (markdown, code, blank lines inside)', () => {
    const body = '```ts\nconst a = 1;\n```\n\nSecond paragraph.';
    expect(stripQuestionTag(`[Q9]\n${body}`)).toBe(body);
  });
});

describe('questionBanner', () => {
  it('uses the repo banner shape so existing readers fold it, and names the tag to write', () => {
    const b = questionBanner(4);
    expect(b.startsWith('[Question Q4]\n')).toBe(true);
    expect(b.endsWith('\n[/Question Q4]')).toBe(true);
    expect(b).toContain('"[Q4]"');
    expect(QUESTION_BANNER_RE.test(questionBannerName(4))).toBe(true);
    expect(QUESTION_BANNER_RE.test('Question Q')).toBe(false);
    expect(QUESTION_BANNER_RE.test('Walnut')).toBe(false);
  });

  it('puts the banner before the user text, separated by a blank line', () => {
    const sent = withQuestionBanner('Why does this fail?', 2);
    expect(sent).toBe(`${questionBanner(2)}\n\nWhy does this fail?`);
  });
});

describe('questionNumbers / nextQuestionSeq / keysBySeq', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3'), user('u4'), reply('r4')];

  it('numbers legacy questions by transcript order and keeps a stored seq', () => {
    const anchors = [anchor('u2', 'r1'), anchor('u3', 'r1', { quote: { exact: 'x' } }), anchor('u4', 'r2')];
    const tree = buildThreadTree(messages, anchors);
    // u4 was asked with the field present; u2 and u3 predate it.
    const index = indexMeta([meta('u4', { seq: 7 })]);
    const numbers = questionNumbers(tree, index);
    expect(numbers.get(threadKeyOf({ parent: 'r1' }))).toBe(1);
    expect(numbers.get(threadKeyOf({ parent: 'r1', quote: { exact: 'x' } }))).toBe(2);
    expect(numbers.get(threadKeyOf({ parent: 'r2' }))).toBe(7);
    expect(numbers.has(ROOT_THREAD_KEY)).toBe(false);
    expect(nextQuestionSeq(tree, index)).toBe(8);
    expect(keysBySeq(numbers).get(7)).toBe(threadKeyOf({ parent: 'r2' }));
  });

  it('a legacy number never reuses a stored one (two questions, one banner)', () => {
    const anchors = [anchor('u2', 'r1'), anchor('u3', 'r2'), anchor('u4', 'r3')];
    const tree = buildThreadTree(messages, anchors);
    // u3 holds 1 and u4 holds 3; u2 has no number of its own.
    const index = indexMeta([meta('u3', { seq: 1 }), meta('u4', { seq: 3 })]);
    const numbers = questionNumbers(tree, index);
    expect(numbers.get(threadKeyOf({ parent: 'r2' }))).toBe(1);
    expect(numbers.get(threadKeyOf({ parent: 'r1' }))).toBe(2);
    expect(numbers.get(threadKeyOf({ parent: 'r3' }))).toBe(3);
    expect(new Set(numbers.values()).size).toBe(3);
  });

  it('the next number clears every stored seq, including one whose question is outside the window', () => {
    const tree = buildThreadTree(messages, [anchor('u2', 'r1')]);
    const list = [meta('u2', { seq: 3 }), meta('gone-head', { seq: 11 })];
    expect(nextQuestionSeq(tree, indexMeta([meta('u2', { seq: 3 })]), list)).toBe(12);
    // No questions at all: the first one is 1.
    expect(nextQuestionSeq(buildThreadTree(messages, []), indexMeta([]))).toBe(1);
  });
});

describe('withTagAnchors', () => {
  const q1 = anchor('u2', 'r1', { quote: { exact: 'passage' } });

  it('files a turn under the question its first answer text names, user row included', () => {
    // u3 was sent as a follow-up on question 1 but its uuid was lost (resume
    // fallback): no anchor. The reply carries [Q1].
    const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3', '[Q1]\nmore on it')];
    const out = withTagAnchors(messages, [q1], headsBySeq([meta('u2', { seq: 1 })]));
    expect(out).toHaveLength(2);
    const extra = out.find((a) => a.msgId === 'u3')!;
    expect(extra).toMatchObject({ parent: 'r1', quote: { exact: 'passage' }, source: 'manual' });
    const tree = buildThreadTree(messages, out);
    const key = threadKeyOf({ parent: 'r1', quote: { exact: 'passage' } });
    expect(tree.byRow.get('u3')?.key).toBe(key);
    expect(tree.byRow.get('r3')?.key).toBe(key);
  });

  it('overrides the turn-order anchor when the tag names another question', () => {
    // Two questions sent quickly; Walnut guessed the second reply was for u3,
    // the model says it answers question 1.
    const q2 = anchor('u3', 'r2');
    const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3', '**[Q1]**\nanswer one')];
    const out = withTagAnchors(messages, [q1, q2], headsBySeq([meta('u2', { seq: 1 }), meta('u3', { seq: 2 })]));
    expect(out.filter((a) => a.msgId === 'u3')).toHaveLength(1);
    expect(out.find((a) => a.msgId === 'u3')).toMatchObject({ parent: 'r1', quote: { exact: 'passage' } });
  });

  it('changes nothing when the tag agrees, is unknown, or names a later question', () => {
    const heads = headsBySeq([meta('u2', { seq: 1 }), meta('u4', { seq: 2 })]);
    const agree = [user('u1'), reply('r1'), user('u2'), reply('r2', '[Q1]\nok')];
    const agreeAnchors = [q1];
    // Same array instance back: the tree memo sees no change.
    expect(withTagAnchors(agree, agreeAnchors, heads)).toBe(agreeAnchors);
    // A number no question has.
    const unknown = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3', '[Q9]\n?')];
    expect(withTagAnchors(unknown, [q1], heads)).toHaveLength(1);
    // The named question is asked AFTER this turn: an answer cannot precede its question.
    const later = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3', '[Q2]\n?'), user('u4'), reply('r4')];
    const q2Later = anchor('u4', 'r3');
    expect(withTagAnchors(later, [q1, q2Later], heads)).toHaveLength(2);
    // No numbered questions at all: the input array comes back as is.
    const anchors = [q1];
    expect(withTagAnchors(agree, anchors, new Map())).toBe(anchors);
  });

  it('reads only the FIRST answer text of a turn; tool rows and empty texts are skipped', () => {
    const messages = [
      user('u1'), reply('r1'), user('u2'), reply('r2'),
      user('u3'), reply('r3a', ''), reply('r3b', '[Q1]\nfirst text'), reply('r3c', '[Q2]\nlater text'),
    ];
    const heads = headsBySeq([meta('u2', { seq: 1 }), meta('u9', { seq: 2 })]);
    const out = withTagAnchors(messages, [q1, anchor('u9', 'r2')], heads);
    expect(out.find((a) => a.msgId === 'u3')).toMatchObject({ parent: 'r1' });
  });

  it('a tag that only echoes the row\'s own (wrong) banner leaves the row with its own anchor', () => {
    // The follow-up was typed in question 3's card, but went out numbered 1;
    // the model echoed [Q1]. The anchor is what the user replied in.
    const q3 = anchor('u3', 'r2', { quote: { exact: 'third' } });
    const follow = anchor('f1', 'r2', { quote: { exact: 'third' }, source: 'manual' });
    const messages = [
      user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3'),
      user('f1', withQuestionBanner('so is that fine?', 1)), reply('fr', '[Q1]\nyes, it is fine'),
    ];
    const heads = headsBySeq([meta('u2', { seq: 1 }), meta('u3', { seq: 3 })]);
    const anchors = [q1, q3, follow];
    expect(withTagAnchors(messages, anchors, heads)).toBe(anchors);
    // Without its own anchor (uuid lost), the tag still files the turn.
    const lost = [q1, q3];
    expect(withTagAnchors(messages, lost, heads).find((a) => a.msgId === 'f1')).toMatchObject({ parent: 'r1' });
  });

  it('a synthetic anchor never reaches the tree twice: the tagged turn keeps one row entry', () => {
    const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3', '[Q1]\nx')];
    const out = withTagAnchors(messages, [q1], headsBySeq([meta('u2', { seq: 1 })]));
    const tree = buildThreadTree(messages, out);
    // Question 1 owns u2, r2, u3, r3; nothing new was created.
    expect(tree.threads.filter((t) => t.key !== ROOT_THREAD_KEY)).toHaveLength(1);
    expect(tree.threads[1].turnIds).toEqual(['u2', 'u3']);
    expect(tree.byRow.get('r3')?.key).toBe(tree.threads[1].key);
  });
});

describe('a question the CLI took mid-turn (a queue-… row with the sent uuid)', () => {
  // 2026-10-08 incident shape, neutral text: question 3 was sent while a turn
  // ran, so its row is `queue-<ts>` and the uuid it was anchored under survives
  // only as `sourceUuid`. Its reply was the tag and tool calls.
  const QUEUE = 'queue-2026-10-07T01:27:29.115Z';
  const q1 = anchor('u2', 'r1', { quote: { exact: 'first' } });
  const q3 = anchor('q3', 'r2', { quote: { exact: 'third' } });
  const messages: ThreadTreeMessage[] = [
    user('u1'), reply('r1'), user('u2', withQuestionBanner('first?', 1)), reply('r2', '[Q1]\nanswer one'),
    { role: 'user', msgId: QUEUE, sourceUuid: 'q3', text: withQuestionBanner('third?', 3) },
    reply('t1', '[Q3]'), { role: 'assistant', msgId: 't2', text: '' },
  ];
  const list = [meta('u2', { seq: 1, status: 'resolved', title: 'First' }), meta('q3', { seq: 3, title: 'Third' }), meta(QUEUE)];
  const index = indexMeta(list);
  const heads = headsBySeq(list);

  it('finds its anchor, number and meta through the sent uuid', () => {
    const anchors = withTagAnchors(messages, [q1, q3], heads);
    // The tag agrees with the row's own anchor: nothing synthetic.
    expect(anchors).toHaveLength(2);
    const tree = buildThreadTree(messages, anchors);
    const key = threadKeyOf(q3);
    const node = tree.byKey.get(key)!;
    expect(node.headId).toBe('q3');
    expect(node.headRowId).toBe(QUEUE);
    expect(node.turnIds).toEqual(['q3']);
    // The timeline asks by the row's own id.
    expect(tree.byRow.get(QUEUE)).toMatchObject({ key, isHead: true });
    expect(tree.byRow.get('t1')?.key).toBe(key);
    const numbers = questionNumbers(tree, index);
    expect(numbers.get(key)).toBe(3);
    expect(numbers.get(threadKeyOf(q1))).toBe(1);
    expect(index.get(node.headId)?.title).toBe('Third');
  });

  it('before the fix shape (no sourceUuid) the number collided; it no longer can', () => {
    const bare = messages.map((m) => (m.msgId === QUEUE ? { role: m.role, msgId: m.msgId, text: m.text } : m));
    const tree = buildThreadTree(bare, withTagAnchors(bare, [q1, q3], heads));
    const numbers = questionNumbers(tree, index);
    // Filed by its tag, headed by the queue row (no seq of its own): it gets a
    // free number, never question 1's.
    expect(numbers.get(threadKeyOf(q3))).not.toBe(1);
    expect(new Set(numbers.values()).size).toBe(numbers.size);
  });
});

describe('tagKeyOfBlocks', () => {
  const keyBySeq = new Map([[1, 'k1'], [2, 'k2']]);
  const text = (content: string, parentToolUseId?: string) => ({ type: 'text', content, parentToolUseId });

  it('resolves the first main-lane text block of the run', () => {
    const blocks = [{ type: 'thinking', content: 'hm' }, text('[Q2]\nans'), text('[Q1]\nlater')];
    expect(tagKeyOfBlocks(blocks, 0, blocks.length, keyBySeq)).toBe('k2');
  });

  it('skips subagent-lane text, tool calls and empty text; null without a tag', () => {
    const blocks = [text('[Q1]\nlane', 'tool-9'), { type: 'tool_call', content: '' }, text('   '), text('plain answer')];
    expect(tagKeyOfBlocks(blocks, 0, blocks.length, keyBySeq)).toBeNull();
    // Unknown number: null too (fall back to the turn's own guess).
    expect(tagKeyOfBlocks([text('[Q5]\nx')], 0, 1, keyBySeq)).toBeNull();
    // A partial tag mid-stream ("[Q" not yet closed) is not a tag yet.
    expect(tagKeyOfBlocks([text('[Q')], 0, 1, keyBySeq)).toBeNull();
  });

  it('honours the [from, to) window', () => {
    const blocks = [text('[Q1]\nfirst turn'), text('[Q2]\nsecond turn')];
    expect(tagKeyOfBlocks(blocks, 1, 2, keyBySeq)).toBe('k2');
    expect(tagKeyOfBlocks(blocks, 2, 5, keyBySeq)).toBeNull();
  });
});

// One turn that answers Q1 and then moves on to Q2 (a question line the CLI took
// mid-turn, 2026-10-06): everything after the `[Q2]` line is Q2's, the live turn
// is answering Q2, and Q1 is the question it left.
describe('tagKeyAtBlock / tagKeysOfBlocks', () => {
  const keyBySeq = new Map([[1, 'k1'], [2, 'k2']]);
  const text = (content: string, parentToolUseId?: string) => ({ type: 'text', content, parentToolUseId });
  const tool = { type: 'tool_call', content: '' };
  const blocks = [{ type: 'thinking', content: 'hm' }, text('[Q1]\nfirst'), tool, text('more on one'), text('[Q2]\nsecond'), tool, text('done')];

  it('gives each block the newest tag at or before it', () => {
    expect(blocks.map((_, i) => tagKeyAtBlock(blocks, 0, blocks.length, i, keyBySeq)))
      .toEqual(['k1', 'k1', 'k1', 'k1', 'k2', 'k2', 'k2']);
  });

  it('falls back to the first-text rule before any tag, and ignores lane text and unknown numbers', () => {
    const untagged = [text('plain'), tool, text('[Q2]\nlater')];
    expect(tagKeyAtBlock(untagged, 0, 3, 0, keyBySeq)).toBeNull();
    expect(tagKeyAtBlock(untagged, 0, 3, 2, keyBySeq)).toBe('k2');
    const lane = [text('[Q1]\nmain'), text('[Q2]\nlane', 'tool-9'), text('[Q9]\nunknown')];
    expect(tagKeyAtBlock(lane, 0, 3, 2, keyBySeq)).toBe('k1');
  });

  it('honours the window and lists each named question once, in order', () => {
    expect(tagKeyAtBlock(blocks, 4, blocks.length, 6, keyBySeq)).toBe('k2');
    expect(tagKeyAtBlock(blocks, 0, 3, 6, keyBySeq)).toBe('k1');
    expect(tagKeysOfBlocks(blocks, 0, blocks.length, keyBySeq)).toEqual(['k1', 'k2']);
    expect(tagKeysOfBlocks([...blocks, text('[Q1]\nback')], 0, 8, keyBySeq)).toEqual(['k1', 'k2']);
    expect(tagKeysOfBlocks(blocks, 4, blocks.length, keyBySeq)).toEqual(['k2']);
  });

  it('blockTagKeys gives every block what tagKeyAtBlock gives it, run by run', () => {
    const runs = [
      text('plain'), tool, text('[Q2]\nlater'), // run 1: [0, 3)
      { type: 'thinking', content: 'hm' }, text('[Q1]\na'), tool, text('[Q2]\nb'), // run 2: [3, 7)
      tool, text('no tag'), // live run: [7, 9)
    ];
    const ends = [3, 7];
    const keys = blockTagKeys(runs, ends, keyBySeq);
    const bounds = [[0, 3], [3, 7], [7, 9]];
    const expected = runs.map((_, i) => {
      const [from, to] = bounds.find(([f, t]) => i >= f && i < t)!;
      return tagKeyAtBlock(runs, from, to, i, keyBySeq);
    });
    expect(keys).toEqual(expected);
    expect(keys).toEqual([null, null, 'k2', 'k1', 'k1', 'k1', 'k2', null, null]);
    // Ends past the blocks (a reset array) and an empty list are safe.
    expect(blockTagKeys(runs.slice(0, 2), [3, 7], keyBySeq)).toEqual([null, null]);
    expect(blockTagKeys([], [], keyBySeq)).toEqual([]);
  });
});
