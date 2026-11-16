/**
 * The lines a Tree Mode or Ask here send puts in front of the person's words
 * (src/lib/composed-framing.ts). 2026-11-16, the user: "why in tree mode it shows
 * back to xx ... this should be hidden (collapse by default, can open to see)",
 * and "it should have info for the ai to reply the message in correct format".
 *
 * Guards:
 *  - every framing the composer writes splits back to exactly the typed words, in
 *    every reader (the bubble's split, the phone's `textWithoutContext`, the title
 *    reader, the question card);
 *  - nothing outside the shared module writes or parses an orientation line
 *    (a new composer or reader must use it, so the bubble folds its lines too);
 *  - the orientation line of a question page names the same thread id as the
 *    question hint the send carries.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACK_TO_MAIN_LINE, backToQuestionLine, backToThreadLine, framingLabel, splitComposedFraming,
} from '../../src/lib/composed-framing';
import { walnutAddedOf } from '../../src/lib/walnut-added';
import { ownWordsOf } from '../../src/core/sessions/own-words';
import { ROOT_THREAD_KEY, composeAnchoredText, composeOrientedText, fileAboutLineOf } from '@/utils/thread-tree';
import { questionBodyOf } from '@/utils/thread-card';

const WORDS = 'Which of the two is cheaper\nto run at night?';
const titleOfKey = () => 'Notebook sync: queue vs log';

/** Every shape the composer sends, built by the composer itself. */
const SENDS: Array<[string, string]> = [
  ['root after a question', composeOrientedText(WORDS, { latestKey: 'k6', currentKey: ROOT_THREAD_KEY, titleOfKey })],
  ['question page, newest elsewhere', composeOrientedText(WORDS, { latestKey: 'k7', currentKey: 'k6', titleOfKey, threadOfKey: () => '6' })],
  ['nested question page', composeOrientedText(WORDS, { latestKey: 'k7', currentKey: 'k6', titleOfKey, threadOfKey: () => '6.1.2' })],
  ['question page, older send without an id', `(Back to the earlier question about “${titleOfKey()}”)\n\n${WORDS}`],
  ['a fresh selection', composeAnchoredText(WORDS, { parent: 'r1', quote: { exact: 'line one\n\nline two' }, source: 'selection', label: 'x' }, ROOT_THREAD_KEY)],
  ['back to an older thread', composeAnchoredText(WORDS, { parent: 'r1', quote: { exact: 'the part' }, source: 'manual', label: 'the part' }, 'elsewhere')],
  ['a file passage', composeAnchoredText(WORDS, { parent: 'file:/repo/docs/plan.md', quote: { exact: 'Step two' }, line: 12, source: 'selection', label: 'x' }, ROOT_THREAD_KEY)],
  ['an older banner send', `[Question Q4]\nReply tag.\n[/Question Q4]\n\n${BACK_TO_MAIN_LINE}\n\n${WORDS}`],
];

describe('every framing the composer writes splits back to the typed words', () => {
  for (const [name, sent] of SENDS) {
    it(name, () => {
      const loneQuote = name === 'a fresh selection';
      const split = splitComposedFraming(sent, { quoteAlone: true });
      expect(split, name).not.toBeNull();
      // The bubble keeps a lone leading quote in the words (a passage comment quotes the same way).
      if (loneQuote) {
        expect(splitComposedFraming(sent)).toBeNull();
        expect(walnutAddedOf(sent).textWithoutContext).toBeUndefined();
        expect(ownWordsOf(sent)).toBe(WORDS);
        expect(questionBodyOf(sent)).toBe(WORDS);
        return;
      }
      expect(split!.words).toBe(WORDS);
      expect(split!.framing.length).toBeGreaterThan(0);
      expect(framingLabel(split!)).toMatch(/^(Sent to|About)/);
      // The phone reads the same split from the transcript row.
      const added = walnutAddedOf(sent);
      expect(added.textWithoutContext?.trim()).toBe(WORDS);
      expect(added.items.at(-1)?.label).toBe(framingLabel(split!));
      expect(ownWordsOf(sent)).toBe(WORDS);
      expect(questionBodyOf(sent)).toBe(WORDS);
    });
  }

  it('a message with no framing is left whole; a pasted quote alone stays the message', () => {
    expect(splitComposedFraming(WORDS)).toBeNull();
    expect(splitComposedFraming('> only a quote I pasted', { quoteAlone: true })).toBeNull();
    // A passage comment: quotes and comments in turn, every quote the person's.
    expect(splitComposedFraming('> first passage\n\nmy comment\n\n> second passage\n\nmine')).toBeNull();
    expect(walnutAddedOf(WORDS)).toEqual({ items: [] });
    // Framing with nothing after it: the readers keep the text.
    expect(ownWordsOf(BACK_TO_MAIN_LINE)).toBe(BACK_TO_MAIN_LINE);
  });

  // 2026-11-16 review: the composer quotes only after a file's About line or the older
  // thread line; a passage comment sent with a main or question line keeps its quotes.
  it('a passage comment sent with an orientation line keeps every quote in the words', () => {
    const comment = '> passage one\n\ncomment one\n\n> passage two\n\ncomment two'
    for (const line of [BACK_TO_MAIN_LINE, backToQuestionLine('Restart order', '6')]) {
      const split = splitComposedFraming(`${line}\n\n${comment}`)!
      expect(split.framing).toBe(line)
      expect(split.words).toBe(comment)
      expect(walnutAddedOf(`${line}\n\n${comment}`).textWithoutContext?.trim()).toBe(comment)
    }
  })

  it('pictures sent with the message stay ahead of the words; the framing after them comes off', () => {
    const header = '[Images attached by the user]\n- /tmp/uploads/a.png\n\n'
    const sent = `${header}${backToQuestionLine('Restart order', '6')}\n\n${WORDS}`
    const split = splitComposedFraming(sent)!
    expect(split.thread).toBe('6')
    expect(split.words).toBe(`${header}${WORDS}`)
    expect(walnutAddedOf(sent).textWithoutContext).toBe(`${header}${WORDS}`)
    expect(ownWordsOf(sent)).toBe(WORDS)
    expect(questionBodyOf(sent)).toBe(WORDS)
  })

  it('the line names the thread id, and the label says where it went', () => {
    const line = backToQuestionLine('A “quoted” title', '6.1');
    expect(line).toBe('(Back to the earlier question thread="6.1" about “A “quoted" title”)');
    const split = splitComposedFraming(`${line}\n\nhi`)!;
    expect(split.thread).toBe('6.1');
    expect(framingLabel(split)).toBe('Sent to question 6.1');
    expect(framingLabel(splitComposedFraming(`${BACK_TO_MAIN_LINE}\n\nhi`)!)).toBe('Sent to the main conversation');
    // An id that is not one is left out rather than written wrong.
    expect(backToThreadLine('x', '6 or 7')).toBe('(Back to the earlier thread about “x”)');
    expect(fileAboutLineOf('/a/b.md', 3)).toBe('About `/a/b.md:3`:');
  });
});

describe('one module writes and reads the framing', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const OWNER = 'src/lib/composed-framing.ts';
  function files(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...files(rel)); } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
    return out;
  }
  it('no other source file spells an orientation line or its pattern', () => {
    const offenders = [...files('src'), ...files('web/src')]
      .filter((f) => f !== OWNER)
      .filter((f) => /\(Back to the (main conversation|earlier (question|thread))|\\\(Back to/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
