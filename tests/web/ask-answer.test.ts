/**
 * The strict Ask here tag (web/src/utils/ask-answer.ts): its grammar, its names,
 * the rows that ask for it, and the thread ids new questions get.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  askAnswerOpening, askKeyOf, askNameKey, codeSpans, isStrictAskRow, liveAskKeyOf, parseAskAnswers, sameAskName, stripAskAnswerTags, strictAskOf, strictAsksOf,
} from '@/utils/ask-answer';
import { nextQuestionPath, nextQuestionSeq, questionLabels, questionPaths, questionSeqOfRow, stripQuestionTag, withIssued } from '@/utils/question-tag';
import { buildThreadTree, ROOT_THREAD_KEY, threadKeyOf } from '@/utils/thread-tree';
import type { SessionThreadAnchor, SessionThreadMeta } from '@/types/session';
import { strictAskHintText, strictAskRow } from './helpers/strict-ask';

const span = (thread: string, name: string, body: string) =>
  `<walnut-ask-answer thread="${thread}" name="${name}">\n${body}\n</walnut-ask-answer>`;

describe('parseAskAnswers', () => {
  it('cuts a message into its spans and the text between them, in order', () => {
    const text = `Main first.\n${span('6', 'Alpha', 'Alpha means one.')}\nMain middle.\n${span('7.1', 'Beta', 'Beta means two.')}\nMain last.`;
    expect(parseAskAnswers(text).map((p) => [p.thread, p.name, p.text])).toEqual([
      [null, undefined, 'Main first.'],
      ['6', 'Alpha', 'Alpha means one.'],
      [null, undefined, 'Main middle.'],
      ['7.1', 'Beta', 'Beta means two.'],
      [null, undefined, 'Main last.'],
    ]);
  });

  it('accepts single quotes, bare values, extra spaces and any case', () => {
    expect(parseAskAnswers("<WALNUT-ASK-ANSWER  thread='6'   name='A b'>\nx\n</Walnut-Ask-Answer >")
      .map((p) => [p.thread, p.name, p.text])).toEqual([['6', 'A b', 'x']]);
    expect(parseAskAnswers('<walnut-ask-answer thread=6.1.2>\ny\n</walnut-ask-answer>').map((p) => [p.thread, p.name, p.text]))
      .toEqual([['6.1.2', undefined, 'y']]);
  });

  it('a span with no closing tag runs to the end; an opening tag ends the span before it', () => {
    expect(parseAskAnswers('Lead.\n<walnut-ask-answer thread="6" name="A">\nOpen to the end.').map((p) => [p.thread, p.text]))
      .toEqual([[null, 'Lead.'], ['6', 'Open to the end.']]);
    expect(parseAskAnswers(`<walnut-ask-answer thread="6" name="A">\nOne.\n${span('6', 'A', 'Two.')}`).map((p) => [p.thread, p.text]))
      .toEqual([['6', 'One.'], ['6', 'Two.']]);
  });

  it('a tag inside a fenced code block is plain text, and so is one with no valid id', () => {
    const fenced = '```\n<walnut-ask-answer thread="6" name="A">\nquoted\n</walnut-ask-answer>\n```';
    expect(parseAskAnswers(fenced)).toEqual([{ thread: null, text: fenced, raw: fenced }]);
    const bad = '<walnut-ask-answer thread="six">\nx\n</walnut-ask-answer>';
    expect(parseAskAnswers(bad).every((p) => p.thread === null)).toBe(true);
  });

  it('an inline span keeps the words around it', () => {
    expect(parseAskAnswers('Before <walnut-ask-answer thread="6" name="A">inside</walnut-ask-answer> after').map((p) => [p.thread, p.text]))
      .toEqual([[null, 'Before'], ['6', 'inside'], [null, 'after']]);
  });
});

describe('askAnswerOpening', () => {
  it('reads the tag a text opens with, only at its start', () => {
    expect(askAnswerOpening(`\n\n${span('6.1', 'A', 'x')}`)).toEqual({ thread: '6.1', name: 'A' });
    expect(askAnswerOpening(`Lead.\n${span('6', 'A', 'x')}`)).toBeNull();
    expect(askAnswerOpening('[Q6]\nold tag')).toBeNull();
  });
});

describe('stripAskAnswerTags (what the chat shows)', () => {
  it('drops the tag lines and keeps everything else', () => {
    expect(stripAskAnswerTags(`Main.\n${span('6', 'A', 'Alpha.')}\nAfter.`)).toBe('Main.\nAlpha.\nAfter.');
    expect(stripQuestionTag(span('6', 'A', 'Alpha.'))).toBe('Alpha.');
  });

  it('keeps a tag quoted in a code block, and hides an opening tag still streaming in', () => {
    const fenced = '```\n<walnut-ask-answer thread="6">\n```';
    expect(stripAskAnswerTags(fenced)).toBe(fenced);
    expect(stripAskAnswerTags('<walnut-ask-ans')).toBe('');
    expect(stripAskAnswerTags('<walnut-ask-answer thread="6" na')).toBe('');
    expect(stripAskAnswerTags('<div>html</div>')).toBe('<div>html</div>');
  });
});

describe('names', () => {
  it('compare with whitespace collapsed, case folded and a trailing ellipsis ignored', () => {
    expect(askNameKey('  Why  is\nthe Sky blue\u2026 ')).toBe('why is the sky blue');
    expect(sameAskName('Why is the sky blue...', 'why is the SKY blue')).toBe(true);
    expect(sameAskName('Why is the sky blue', 'Why is the sea blue')).toBe(false);
  });
});

describe('strict rows', () => {
  it('a row is strict when its question hint asks for the answer tag', () => {
    const row = strictAskRow('q1', 'Why?', '6.1', 'Why it fails');
    expect(isStrictAskRow(row)).toBe(true);
    expect(strictAskOf(row)).toEqual({ thread: '6.1', name: 'Why it fails' });
    // A strict question has no `[Qn]` number: that tag never files its text.
    expect(questionSeqOfRow({ ...row, hints: [{ kind: 'question', arg: '6', text: strictAskHintText('6', 'x') }] })).toBeNull();
  });

  it('an old row (the `[Qn]` hint) is not strict and keeps its number', () => {
    const old = { role: 'user' as const, text: 'Why?', hints: [{ kind: 'question', arg: '4', text: 'this message is question 4 of this conversation. Begin your reply with the line "[Q4]"' }] };
    expect(isStrictAskRow(old)).toBe(false);
    expect(questionSeqOfRow(old)).toBe(4);
  });

  it('strictAsksOf: rows give the name, bubbles stand in until their row lands', () => {
    const rows = [strictAskRow('q6', 'Why?', '6', 'Why it fails')];
    const keys = new Map([['q6', 'k6'], ['uu7', 'k7']]);
    const index = strictAsksOf(rows, [{ role: 'user', userUuid: 'uu7', requestedHints: { question: { arg: '7' } } }], (id) => keys.get(id ?? '') ?? ROOT_THREAD_KEY);
    expect(index.byThread.get('6')).toEqual({ key: 'k6', names: new Set(['why it fails']) });
    expect(index.byThread.get('7')).toEqual({ key: 'k7' });
    expect([...index.byKey.keys()]).toEqual(['k6', 'k7']);
  });

  it('strictAsksOf: a follow-up that names its question another way adds that name', () => {
    const rows = [strictAskRow('q6', 'Why?', '6', 'Why it fails'), strictAskRow('q6b', 'And then?', '6', 'Some other name', { sourceUuid: 'q6' })];
    const index = strictAsksOf(rows, [], () => 'k6');
    expect(askKeyOf(index, '6', 'why it FAILS')).toBe('k6');
    expect(askKeyOf(index, '6', 'Some other name')).toBe('k6');
    expect(askKeyOf(index, '6', 'A third name')).toBeNull();
    expect(askKeyOf(index, '7', 'Why it fails')).toBeNull();
  });
});

describe('a tag quoted in inline code is text (2026-11-03 review)', () => {
  const quoted = 'Use `<walnut-ask-answer thread="6" name="X">` to answer.\nThe main text goes on.';
  it('opens no span: everything stays as written', () => {
    expect(parseAskAnswers(quoted)).toEqual([{ thread: null, text: quoted, raw: quoted }]);
    const doubled = 'A ``<walnut-ask-answer thread="6" name="X">`` quote.\nMore.';
    expect(parseAskAnswers(doubled).every((p) => p.thread === null)).toBe(true);
    // The same tag outside code still opens one.
    expect(parseAskAnswers('Lead.\n<walnut-ask-answer thread="6" name="X">\nIn.').map((p) => p.thread)).toEqual([null, '6']);
  });

  it('the chat shows it, backticks and all, on every assistant row', () => {
    expect(stripAskAnswerTags(quoted)).toBe(quoted);
    expect(stripQuestionTag(quoted)).toBe(quoted);
    expect(stripQuestionTag('Close it with `</walnut-ask-answer>`.')).toBe('Close it with `</walnut-ask-answer>`.');
    expect(askAnswerOpening('`<walnut-ask-answer thread="6" name="X">` is the tag.')).toBeNull();
  });

  it('codeSpans: inline runs close only on a run of the same length, on the same line', () => {
    const t = 'a `x` b ``y ` z`` c `open\nnext`';
    expect(codeSpans(t).map(([a, b]) => t.slice(a, b))).toEqual(['`x`', '``y ` z``']);
  });
});

describe('liveAskKeyOf (the live block\'s page)', () => {
  const index = strictAsksOf([strictAskRow('q6', 'Why?', '6', 'Why it fails')], [], () => 'k6');
  const open = '<walnut-ask-answer thread="6" name="Why it fails">';
  it('a block opening with the tag, or a short preamble then the tagged answer: the question', () => {
    expect(liveAskKeyOf(index, `${open}\nBecause.`)).toBe('k6');
    expect(liveAskKeyOf(index, `Looking.\n${open}\nBecause the cache is cold here.`)).toBe('k6');
  });
  it('the preamble alone so far, a long main reply around a short span, a wrong name: none', () => {
    expect(liveAskKeyOf(index, `Looking at it.\n${open}\n`)).toBeNull();
    expect(liveAskKeyOf(index, `I rewrote the module and ran every test again today.\n${open}\nYes.\n</walnut-ask-answer>`)).toBeNull();
    expect(liveAskKeyOf(index, 'Looking.\n<walnut-ask-answer thread="6" name="Other">\nBecause the cache is cold.')).toBeNull();
    expect(liveAskKeyOf(index, 'Plain text.')).toBeNull();
  });
});

describe('source', () => {
  it('ask-answer.ts is ASCII only', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'utils', 'ask-answer.ts'), 'utf8');
    expect(/[^\x00-\x7F]/.test(src)).toBe(false);
  });
});

describe('thread ids (2026-11-03, the user: "the thread can be nested")', () => {
  const at = '2026-11-03T00:00:00Z';
  const rows = [
    { role: 'user' as const, msgId: 'u0', text: 'Explain.' },
    { role: 'assistant' as const, msgId: 'a0', text: 'One.\nTwo.' },
    { role: 'user' as const, msgId: 'q1', text: 'What is one?' },
    { role: 'assistant' as const, msgId: 'a1', text: 'One is one.' },
    { role: 'user' as const, msgId: 'q2', text: 'And inside?' },
    { role: 'assistant' as const, msgId: 'a2', text: 'Inside.' },
  ];
  const anchors: SessionThreadAnchor[] = [
    { msgId: 'q1', parent: 'a0', quote: { exact: 'One.' }, source: 'selection', at },
    { msgId: 'q2', parent: 'a1', quote: { exact: 'One is one.' }, source: 'selection', at },
  ];
  const tree = buildThreadTree(rows, anchors);
  const k1 = threadKeyOf(anchors[0]);
  const k2 = threadKeyOf(anchors[1]);
  const meta = (m: Partial<SessionThreadMeta> & { headId: string }): SessionThreadMeta => ({ status: 'open', updatedAt: at, ...m });

  it('a stored id wins; a question from before ids reads as its number', () => {
    const index = new Map([['q1', meta({ headId: 'q1', seq: 1 })], ['q2', meta({ headId: 'q2', seq: 2, thread: '1.1' })]]);
    expect(questionPaths(tree, index)).toEqual(new Map([[k1, '1'], [k2, '1.1']]));
  });

  it('on the main conversation: the next top-level number; inside a question: its id plus the next child', () => {
    const index = new Map([['q1', meta({ headId: 'q1', seq: 1, thread: '1' })], ['q2', meta({ headId: 'q2', seq: 2, thread: '1.1' })]]);
    const list = [...index.values()];
    expect(nextQuestionPath(tree, index, list, ROOT_THREAD_KEY)).toBe('2');
    expect(nextQuestionPath(tree, index, list, k1)).toBe('1.2');
    expect(nextQuestionPath(tree, index, list, k2)).toBe('1.1.1');
    // An id held by a question outside the loaded rows is never given again.
    const more = [...list, meta({ headId: 'gone', seq: 3, thread: '1.2' }), meta({ headId: 'gone2', seq: 4 })];
    expect(nextQuestionPath(tree, index, more, k1)).toBe('1.3');
    expect(nextQuestionPath(tree, index, more, ROOT_THREAD_KEY)).toBe('5');
  });

  it('every surface shows the thread id: after a nested 1.1 the next top-level question reads 2, as its tag does', () => {
    const index = new Map([['q1', meta({ headId: 'q1', seq: 1, thread: '1' })], ['q2', meta({ headId: 'q2', seq: 2, thread: '1.1' })]]);
    const next = nextQuestionPath(tree, index, [...index.values()], ROOT_THREAD_KEY);
    expect(next).toBe('2');
    // Its number is 3, its id 2: the label is the id.
    expect(nextQuestionSeq(tree, index, [...index.values()])).toBe(3);
    expect(questionLabels(tree, index)).toEqual(new Map([[k1, '1'], [k2, '1.1']]));
    // An old question (no id) reads its number.
    expect(questionLabels(tree, new Map([['q1', meta({ headId: 'q1', seq: 4 })]])).get(k1)).toBe('4');
  });

  it('two questions asked before the meta is read back get two ids (withIssued)', () => {
    const index = new Map([['q1', meta({ headId: 'q1', seq: 1, thread: '1' })], ['q2', meta({ headId: 'q2', seq: 2, thread: '1.1' })]]);
    const list = [...index.values()];
    const first = nextQuestionPath(tree, index, withIssued(list, []), ROOT_THREAD_KEY);
    const issued = [meta({ headId: 'new1', seq: 3, thread: first })];
    const second = nextQuestionPath(tree, index, withIssued(list, issued), ROOT_THREAD_KEY);
    expect([first, second]).toEqual(['2', '3']);
    expect(nextQuestionSeq(tree, index, withIssued(list, issued))).toBe(4);
    // Inside a question: 1.2 (1.1 is taken), then 1.3.
    const a = nextQuestionPath(tree, index, withIssued(list, []), k1);
    const b = nextQuestionPath(tree, index, withIssued(list, [meta({ headId: 'new2', seq: 4, thread: a })]), k1);
    expect([a, b]).toEqual(['1.2', '1.3']);
    // A question asked inside one whose meta is only issued so far: below its id.
    expect(nextQuestionPath(tree, new Map(), [meta({ headId: 'q1', seq: 1, thread: '5' })], k1)).toBe('5.1');
    // Once the list shows an issued question, it is not counted twice.
    expect(withIssued([meta({ headId: 'new1', seq: 3, thread: '2' })], issued)).toHaveLength(1);
  });

  it('a session of old numbered questions goes on above their numbers', () => {
    const index = new Map([['q1', meta({ headId: 'q1', seq: 4 })], ['q2', meta({ headId: 'q2', seq: 5 })]]);
    expect(nextQuestionPath(tree, index, [...index.values()], ROOT_THREAD_KEY)).toBe('6');
    expect(nextQuestionPath(tree, index, [...index.values()], k2)).toBe('5.1');
  });
});
