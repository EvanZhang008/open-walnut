/**
 * The composer's inline references (web/src/components/chat/composer-refs.ts).
 *
 * A reference reaching the composer from ANY path (a persisted draft, a prefill,
 * an "@" pick, a paste, a restore after a failed send) is shown in the box as its
 * `@[label]` token, in place, and the message swaps the token back for its tag.
 * Every one of those paths calls inlineRefs, so the cases below are the paths,
 * expressed as text. The user asked for the reference to sit IN the box with the
 * words (2026-10-02), where a chip strip above the box used to hold it.
 *
 * ChatInput itself has no render test here: the repo's vitest runs in `node`
 * with no jsdom or React Testing Library, so the normalizer is a pure module and
 * this file is the ratchet for it.
 */
import { describe, it, expect } from 'vitest';
import { composeRefs, cutSpan, inlineRefs, listInlineRefs, refToken, tokenEndingAt } from '@/components/chat/composer-refs';

const TASK = '<task-ref id="t1" label="Fix the thing"/>';
const TASK2 = '<task-ref id="t2" label="Other thing"/>';
const SESSION = '<session-ref id="s1" label="Plan: auth"/>';
const PROJECT = '<project-ref id="Walnut" label="Walnut"/>';

describe('inlineRefs', () => {
  it('a draft that is only a quoted reference mounts as its token', () => {
    // What composer-insert.ts parks in localStorage when no panel is mounted.
    const { body, table } = inlineRefs(`${TASK} `);
    expect(body).toBe('@[Fix the thing] ');
    expect(table.get('Fix the thing')).toBe(TASK);
  });

  it('a tag keeps its place in the sentence', () => {
    expect(inlineRefs(`look at ${TASK} today`).body).toBe('look at @[Fix the thing] today');
    expect(inlineRefs(`half a sentence ${TASK} `).body).toBe('half a sentence @[Fix the thing] ');
  });

  it('every kind becomes a token, in order, and the table knows each one', () => {
    const { body, table } = inlineRefs(`${TASK} ${SESSION} ${PROJECT} compare these`);
    expect(body).toBe('@[Fix the thing] @[Plan: auth] @[Walnut] compare these');
    expect([...table.entries()]).toEqual([
      ['Fix the thing', TASK], ['Plan: auth', SESSION], ['Walnut', PROJECT],
    ]);
  });

  it('keeps the table it is handed and adds what the text brings', () => {
    const first = inlineRefs(TASK).table;
    const { body, table } = inlineRefs(`and ${TASK2}`, first);
    expect(body).toBe('and @[Other thing]');
    expect(table.get('Fix the thing')).toBe(TASK);
    expect(table.get('Other thing')).toBe(TASK2);
  });

  it('two different entities with the same words get different tokens', () => {
    const twin = '<task-ref id="zz-9f3e" label="Fix the thing"/>';
    const { body, table } = inlineRefs(`${TASK} vs ${twin}`);
    expect(body).toBe('@[Fix the thing] vs @[Fix the thing · 9f3e]');
    expect(table.get('Fix the thing · 9f3e')).toBe(twin);
    // The same twin again reuses its disambiguated label.
    expect(inlineRefs(twin, table).body).toBe('@[Fix the thing · 9f3e]');
  });

  it('the same entity renamed since keeps the label the box already shows', () => {
    const renamed = '<task-ref id="t1" label="Fix the thing"/>';
    const table = inlineRefs(TASK).table;
    expect(inlineRefs(renamed, table).body).toBe('@[Fix the thing]');
    expect(inlineRefs(`${TASK} ${renamed}`).body).toBe('@[Fix the thing] @[Fix the thing]');
  });

  it('brackets and line breaks in a label never break the token', () => {
    const odd = '<task-ref id="t3" label="Fix [the] thing"/>';
    const { body, table } = inlineRefs(odd);
    expect(body).toBe('@[Fix the thing]');
    expect(table.get('Fix the thing')).toBe(odd);
  });

  it('text with no tags is returned untouched, table intact', () => {
    const table = inlineRefs(TASK).table;
    expect(inlineRefs('just words  with  spacing', table)).toEqual({
      body: 'just words  with  spacing',
      table,
    });
  });

  it('a project ref keeps its name as the id (decoded) and its tag verbatim', () => {
    const quoted = '<project-ref id="A &quot;B&quot;" label="A &quot;B&quot;"/>';
    const { body, table } = inlineRefs(`${quoted} ship it`);
    expect(body).toBe('@[A "B"] ship it');
    expect(table.get('A "B"')).toBe(quoted);
  });

  it('an unlabeled tag shows its id', () => {
    expect(inlineRefs('<task-ref id="t9"/>').body).toBe('@[t9]');
  });

  it('is idempotent: inlining the composed form gives the same box back', () => {
    const first = inlineRefs(`look at ${TASK} and ${SESSION} please`);
    const composed = composeRefs(first.body, first.table);
    expect(composed).toBe(`look at ${TASK} and ${SESSION} please`);
    expect(inlineRefs(composed).body).toBe(first.body);
  });
});

describe('composeRefs', () => {
  it('swaps each known token for its tag, where it stands', () => {
    const { body, table } = inlineRefs(`compare ${TASK} with ${SESSION}`);
    expect(composeRefs(body, table)).toBe(`compare ${TASK} with ${SESSION}`);
  });

  it('a token the table does not know is the user\'s own text', () => {
    const { table } = inlineRefs(TASK);
    expect(composeRefs('see @[Fix the thing] and @[something else]', table))
      .toBe(`see ${TASK} and @[something else]`);
    // A half-deleted token is just text too.
    expect(composeRefs('see @[Fix the thin', table)).toBe('see @[Fix the thin');
  });

  it('a reference with no words is a complete message', () => {
    const { table } = inlineRefs(TASK);
    expect(composeRefs('  @[Fix the thing]  ', table)).toBe(TASK);
  });

  it('prose with no refs is the prose, trimmed', () => {
    expect(composeRefs('  hello  ', new Map())).toBe('hello');
    expect(composeRefs('', new Map())).toBe('');
  });

  it('keeps the newlines inside the prose', () => {
    const { table } = inlineRefs(TASK);
    expect(composeRefs('one\n@[Fix the thing]\ntwo', table)).toBe(`one\n${TASK}\ntwo`);
  });

  it('a leading slash command stays first because the token sits where it was typed', () => {
    const { table } = inlineRefs(TASK);
    expect(composeRefs('/walnut-trigger watch @[Fix the thing]', table)).toBe(`/walnut-trigger watch ${TASK}`);
  });
});

describe('the ChatInput paths, expressed as the calls ChatInput makes', () => {
  it('an "@" pick: the query span becomes the token, one space after it, caret there', () => {
    // handlePickRef: head + tag + (a space unless the tail starts with one) + tail.
    const pick = (typed: string, at: number, end: number) => {
      const tail = typed.slice(end);
      const sep = /^\s/.test(tail) ? '' : ' ';
      const split = inlineRefs(typed.slice(0, at) + TASK + sep + tail);
      return { body: split.body, caret: split.body.length - tail.length };
    };
    expect(pick('what about @fix now', 11, 15)).toEqual({
      body: 'what about @[Fix the thing] now', caret: 'what about @[Fix the thing]'.length,
    });
    expect(pick('what about @fix', 11, 15)).toEqual({
      body: 'what about @[Fix the thing] ', caret: 'what about @[Fix the thing] '.length,
    });
  });

  it('Backspace right after a token removes the whole token', () => {
    const { body, table } = inlineRefs(`look at ${TASK} now`);
    const caret = 'look at @[Fix the thing]'.length;
    expect(tokenEndingAt(body, caret, table)).toEqual({ start: 8, end: caret });
    const cut = cutSpan(body, 8, caret);
    expect(cut.text).toBe('look at now');
    expect(cut.caret).toBe(8);
  });

  it('Backspace elsewhere, or after an unknown token, is the browser\'s', () => {
    const { body, table } = inlineRefs(`look at ${TASK} now`);
    expect(tokenEndingAt(body, body.length, table)).toBeNull();
    expect(tokenEndingAt(body, 8, table)).toBeNull();
    expect(tokenEndingAt('see @[nobody]', 'see @[nobody]'.length, table)).toBeNull();
    expect(tokenEndingAt('', 0, table)).toBeNull();
  });

  it('a failed send restores from the composed message', () => {
    // dispatchSend hands the composed text back to restoreInput.
    const sent = composeRefs(inlineRefs(`${TASK} ${SESSION} try again`).body, inlineRefs(`${TASK} ${SESSION}`).table);
    const restored = inlineRefs(sent);
    expect(restored.body).toBe('@[Fix the thing] @[Plan: auth] try again');
    expect(restored.table.get('Plan: auth')).toBe(SESSION);
  });

  it('the draft round-trips through localStorage as ONE composed string', () => {
    const { body, table } = inlineRefs(`mid ${TASK} sentence`);
    const stored = composeRefs(body, table);
    // Another surface appends a second reference to that same key.
    const afterQuote = `${stored} ${TASK2} `;
    const split = inlineRefs(afterQuote);
    expect(split.body).toBe('mid @[Fix the thing] sentence @[Other thing] ');
    expect(composeRefs(split.body, split.table)).toBe(`mid ${TASK} sentence ${TASK2}`);
  });

  it('lists the known tokens with their spans', () => {
    const { body, table } = inlineRefs(`${TASK} and ${TASK2} and @[nobody]`);
    expect(listInlineRefs(body, table)).toEqual([
      { label: 'Fix the thing', tag: TASK, start: 0, end: refToken('Fix the thing').length },
      { label: 'Other thing', tag: TASK2, start: 21, end: 21 + refToken('Other thing').length },
    ]);
  });
});

describe('cutSpan', () => {
  it('removes the "@query" span and collapses the gap', () => {
    // "hello @fix world" with the caret after "@fix".
    const out = cutSpan('hello @fix world', 6, 10);
    expect(out.text).toBe('hello world');
    expect(out.caret).toBe(6);
  });

  it('a span at the start reports caret 0', () => {
    expect(cutSpan('@fix world', 0, 4)).toEqual({ text: 'world', caret: 0 });
  });

  it('a span at the end leaves the head alone', () => {
    expect(cutSpan('hello @fix', 6, 10)).toEqual({ text: 'hello ', caret: 6 });
  });

  it('inserts one space rather than gluing two words', () => {
    expect(cutSpan('a@fix.b', 1, 5)).toEqual({ text: 'a .b', caret: 2 });
  });
});
