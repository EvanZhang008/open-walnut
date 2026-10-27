/**
 * When this tab dates a question's answer (web/src/utils/thread-answer-dating.ts):
 * at its newest words once it stops being live; by its words in a fast turn
 * that never showed as streaming; by the stream's stop when it said nothing;
 * never in the gap between a send's delivery and its turn's start.
 */
import { describe, expect, it } from 'vitest';
import { newAnswerDating, stepAnswerDating } from '@/utils/thread-answer-dating';

/** `streaming`: the question whose own turn streams now ('' = the main conversation, null = none). */
const step = (d: ReturnType<typeof newAnswerDating>, now: number, live: string[], words: Record<string, string>, streaming: string | null) =>
  Object.fromEntries(stepAnswerDating(d, {
    live: new Set(live), words: new Map(Object.entries(words)), streaming: new Set(streaming === null ? [] : [streaming]), now,
  }));

describe('stepAnswerDating', () => {
  it('a streamed answer is dated at its last words, not at the turn end line', () => {
    const d = newAnswerDating();
    expect(step(d, 0, ['q'], {}, null)).toEqual({});
    expect(step(d, 10, ['q'], {}, 'q')).toEqual({});
    expect(step(d, 20, ['q'], { q: 'b0:5' }, 'q')).toEqual({});
    expect(step(d, 30, ['q'], { q: 'b0:40' }, 'q')).toEqual({});
    // The result line comes later: the answer still dates from 30.
    expect(step(d, 90, [], { q: 'b0:40' }, null)).toEqual({ q: 30 });
    // Dated once.
    expect(step(d, 95, [], { q: 'b0:40' }, null)).toEqual({});
  });

  it('final words that land with the end are dated then', () => {
    const d = newAnswerDating();
    step(d, 0, ['q'], { q: 'b0:20' }, 'q');
    expect(step(d, 50, [], { q: 'b1:60' }, null)).toEqual({ q: 50 });
  });

  it('a fast turn that never streamed is dated by its words', () => {
    const d = newAnswerDating();
    step(d, 0, ['q'], {}, null);
    // Delivered, not streaming, no words yet: the gap, not dated.
    expect(step(d, 5, [], {}, null)).toEqual({});
    expect(step(d, 8, [], {}, null)).toEqual({});
    expect(step(d, 12, [], { q: 'b0:30' }, null)).toEqual({ q: 12 });
  });

  it('a turn that said nothing is dated when its stream stops', () => {
    const d = newAnswerDating();
    step(d, 0, ['q'], {}, null);
    step(d, 5, ['q'], {}, 'q');
    expect(step(d, 9, [], {}, 'q')).toEqual({});
    expect(step(d, 20, [], {}, null)).toEqual({ q: 20 });
  });

  it('old words seen before it went live do not date a new send', () => {
    const d = newAnswerDating();
    step(d, 0, [], { q: 'h120' }, null);
    step(d, 10, ['q'], { q: 'h120' }, null);
    expect(step(d, 15, [], { q: 'h120' }, null)).toEqual({});
    expect(step(d, 40, [], { q: 'b3:22' }, null)).toEqual({ q: 40 });
  });

  it('a question the turn moved on from is dated at its own last words', () => {
    const d = newAnswerDating();
    step(d, 0, ['a'], {}, 'a');
    step(d, 10, ['a'], { a: 'b0:30' }, 'a');
    expect(step(d, 20, ['b'], { a: 'b0:30', b: 'b1:10' }, 'b')).toEqual({ a: 10 });
    expect(step(d, 50, [], { a: 'b0:30', b: 'b1:44' }, null)).toEqual({ b: 50 });
  });

  it('never dates the main conversation', () => {
    const d = newAnswerDating();
    step(d, 0, [''], { '': 'b0:5' }, '');
    expect(step(d, 10, [], { '': 'b0:5' }, null)).toEqual({});
  });

  it('another question streaming does not date one that said nothing (a cancelled send)', () => {
    const d = newAnswerDating();
    step(d, 0, ['q'], {}, null);
    // Withdrawn from the queue; another question's turn runs and ends.
    expect(step(d, 5, ['other'], {}, 'other')).toEqual({});
    expect(step(d, 9, [], { other: 'b0:12' }, null)).toEqual({ other: 9 });
  });

  it('the transcript taking over words a live block showed is not new words', () => {
    const d = newAnswerDating();
    step(d, 0, ['q'], { q: 'b0:20' }, 'q');
    expect(step(d, 10, [], { q: 'b0:20' }, null)).toEqual({ q: 0 });
    // A follow-up goes live, then the refetch swaps the block for history.
    step(d, 20, ['q'], { q: 'b0:20' }, null);
    step(d, 25, ['q'], { q: 'h80' }, null);
    // Delivered and gone from live before its turn: nothing dates it yet.
    expect(step(d, 30, [], { q: 'h80' }, null)).toEqual({});
  });
});
