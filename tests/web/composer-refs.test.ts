/**
 * The composer's chips-and-prose split (web/src/components/chat/composer-refs.ts).
 *
 * The bug this pins: "Quote in session" used to drop a raw
 * `<task-ref id="…" label="…"/>` into the session composer, so the user saw the
 * readable pill AND the markup in the textarea. The rule is now one-directional:
 * a tag reaching the composer from ANY path (a persisted draft, a prefill, an
 * "@" pick, a paste, a restore after a failed send) becomes a chip, and the
 * textarea keeps prose only. Every one of those paths calls splitComposerRefs,
 * so the cases below are the paths, expressed as text.
 *
 * ChatInput itself has no render test here: the repo's vitest runs in `node`
 * with no jsdom or React Testing Library, so the normalizer is a pure module and
 * this file is the ratchet for it.
 */
import { describe, it, expect } from 'vitest';
import { composeWithRefs, cutSpan, splitComposerRefs } from '@/components/chat/composer-refs';

const TASK = '<task-ref id="t1" label="Fix the thing"/>';
const TASK2 = '<task-ref id="t2" label="Other thing"/>';
const SESSION = '<session-ref id="s1" label="Plan: auth"/>';
const PROJECT = '<project-ref id="Walnut" label="Walnut"/>';

describe('splitComposerRefs', () => {
  it('a draft that is only a quoted reference mounts as a chip and an EMPTY box', () => {
    // What composer-insert.ts parks in localStorage when no panel is mounted.
    expect(splitComposerRefs(`${TASK} `)).toEqual({ refs: [TASK], body: '' });
  });

  it('the append prefill path lifts the tag out of the sentence in progress', () => {
    // ChatInput's 'append' mode builds "<typed> <prefill>".
    expect(splitComposerRefs(`half a sentence ${TASK} `)).toEqual({
      refs: [TASK],
      body: 'half a sentence ',
    });
  });

  it('a tag mid-sentence leaves ONE space behind, not two', () => {
    expect(splitComposerRefs(`look at ${TASK} today`)).toEqual({
      refs: [TASK],
      body: 'look at today',
    });
  });

  it('keeps every kind, in the order they appear', () => {
    const { refs, body } = splitComposerRefs(`${TASK} ${SESSION} ${PROJECT} compare these`);
    expect(refs).toEqual([TASK, SESSION, PROJECT]);
    expect(body).toBe('compare these');
  });

  it('carries the standing chips first and appends what the text adds', () => {
    const { refs, body } = splitComposerRefs(`and ${TASK2}`, [TASK]);
    expect(refs).toEqual([TASK, TASK2]);
    // The space the user typed before the tag is theirs to keep; composing trims it.
    expect(body).toBe('and ');
    expect(composeWithRefs(refs, body)).toBe(`${TASK} ${TASK2} and`);
  });

  it('the same entity twice is ONE chip (kind+id, not the label)', () => {
    const renamed = '<task-ref id="t1" label="Renamed since"/>';
    // The standing chip wins: it is the one the user can already see.
    expect(splitComposerRefs(renamed, [TASK]).refs).toEqual([TASK]);
    expect(splitComposerRefs(`${TASK} ${renamed}`).refs).toEqual([TASK]);
    // Same id, different KIND stays two chips.
    expect(splitComposerRefs(`${TASK} <session-ref id="t1" label="x"/>`).refs).toHaveLength(2);
  });

  it('text with no tags is returned untouched, chips intact', () => {
    expect(splitComposerRefs('just words  with  spacing', [TASK])).toEqual({
      refs: [TASK],
      body: 'just words  with  spacing',
    });
  });

  it('never glues two words together, and never eats a newline', () => {
    expect(splitComposerRefs(`see${TASK}now`).body).toBe('see now');
    expect(splitComposerRefs(`line one\n${TASK}\nline two`).body).toBe('line one\n\nline two');
  });

  it('a project ref keeps its name as the id (decoded) and its tag verbatim', () => {
    const quoted = '<project-ref id="A &quot;B&quot;" label="A &quot;B&quot;"/>';
    const { refs, body } = splitComposerRefs(`${quoted} ship it`);
    expect(refs).toEqual([quoted]);
    expect(body).toBe('ship it');
  });

  it('is idempotent: splitting the composed form gives the same chips back', () => {
    const first = splitComposerRefs(`look at ${TASK} and ${SESSION} please`);
    const composed = composeWithRefs(first.refs, first.body);
    expect(splitComposerRefs(composed)).toEqual(first);
  });
});

describe('composeWithRefs', () => {
  it('puts the tags first, then the prose', () => {
    expect(composeWithRefs([TASK, SESSION], 'what changed here?'))
      .toBe(`${TASK} ${SESSION} what changed here?`);
  });

  it('refs with no prose is a complete message', () => {
    expect(composeWithRefs([TASK], '   ')).toBe(TASK);
  });

  it('prose with no refs is the prose, trimmed', () => {
    expect(composeWithRefs([], '  hello  ')).toBe('hello');
    expect(composeWithRefs([], '')).toBe('');
  });

  it('keeps the newlines inside the prose', () => {
    expect(composeWithRefs([TASK], 'one\n\ntwo')).toBe(`${TASK} one\n\ntwo`);
  });
});

describe('the ChatInput paths, expressed as the calls ChatInput makes', () => {
  it('an "@" pick: the query span leaves the text, the tag becomes a chip', () => {
    // handlePickRef: cutSpan over the "@query" span, then normalize with the tag
    // appended to the candidate text.
    const typed = 'what about @fix now';
    const cut = cutSpan(typed, 11, 15); // "@fix"
    const split = splitComposerRefs(cut.text + TASK, [SESSION]);
    expect(split.body).toBe('what about now');
    expect(split.refs).toEqual([SESSION, TASK]);
    expect(cut.caret).toBe(11);
  });

  it('removing a chip touches only that reference', () => {
    const refs = [TASK, SESSION, PROJECT];
    const next = refs.filter((_, i) => i !== 1);
    expect(next).toEqual([TASK, PROJECT]);
    expect(composeWithRefs(next, 'still here')).toBe(`${TASK} ${PROJECT} still here`);
  });

  it('a failed send restores from the composed message', () => {
    // dispatchSend hands the composed text back to restoreInput.
    const sent = composeWithRefs([TASK, SESSION], 'try again');
    const restored = splitComposerRefs(sent);
    expect(restored.refs).toEqual([TASK, SESSION]);
    expect(restored.body).toBe('try again');
  });

  it('the draft round-trips through localStorage as ONE composed string', () => {
    const stored = composeWithRefs([TASK], 'mid sentence');
    // Another surface appends a second reference to that same key.
    const afterQuote = `${stored} ${TASK2} `;
    const split = splitComposerRefs(afterQuote);
    expect(split.refs).toEqual([TASK, TASK2]);
    expect(split.body).toBe('mid sentence ');
    expect(composeWithRefs(split.refs, split.body)).toBe(`${TASK} ${TASK2} mid sentence`);
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
