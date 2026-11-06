/**
 * A review's score on a structured reply (src/core/peers/structured-reply.ts): read from an
 * object or "f/ux/ui" text, each 0..10, and shown to the asker as one Score line.
 */
import { describe, expect, it } from 'vitest';
import { composeReplyText, hasStructuredFields, readScore, readStructuredReply, scoreProblem } from '../../../src/core/peers/structured-reply.js';

describe('review score', () => {
  it('reads an object (any key case, numbers or "n/10" text) and the three-part text', () => {
    expect(readScore({ function: 8, UX: '7.5', Ui: '9/10' })).toEqual({ function: 8, ux: 7.5, ui: 9 });
    expect(readScore('8/7.5/9')).toEqual({ function: 8, ux: 7.5, ui: 9 });
    expect(readScore({ ux: 9 })).toEqual({ ux: 9 });
  });

  it('names no score for anything outside 0..10, empty, or of another shape', () => {
    expect(readScore({ function: 11, ux: -1, ui: '' })).toBeUndefined();
    expect(readScore('8/9')).toBeUndefined();
    expect(readScore([8, 9, 9])).toBeUndefined();
    expect(readScore(undefined)).toBeUndefined();
    expect(readScore({ function: 8.25 })).toEqual({ function: 8.3 });
  });

  it('is a structured field: alone it makes a reply structured, and the asker reads a Score line', () => {
    const r = readStructuredReply({ score: { function: 10, ux: 9, ui: 9 } });
    expect(r).toEqual({ score: { function: 10, ux: 9, ui: 9 } });
    expect(hasStructuredFields({ score: {} })).toBe(true);
    expect(composeReplyText('Looks good.', r)).toBe('Looks good.\n\nScore: function 10/10, UX 9/10, UI 9/10');
    expect(readStructuredReply({ score: { function: 'high' } })).toBeNull();
  });

  it('refuses a score with any part out of range, in text as in an object, and accepts a good one', () => {
    expect(scoreProblem('10/9/11')).toContain('not 0..10: ui');
    expect(scoreProblem('10/9')).toContain('score must be');
    expect(scoreProblem({ function: 10, ui: 11 })).toContain('not 0..10: ui');
    expect(scoreProblem({ fun: 9 })).toContain('unknown: fun');
    expect(scoreProblem('10/9/9')).toBeNull();
    expect(scoreProblem({ ux: 9 })).toBeNull();
    expect(scoreProblem(undefined)).toBeNull();
  });
});
